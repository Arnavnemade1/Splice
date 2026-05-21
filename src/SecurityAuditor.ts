import type { Page, Response } from 'playwright';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO' | 'PASS';

export interface AuditFinding {
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation: string;
  affectedUrl?: string;
  affectedElement?: string;
}

export interface AgentFeedback {
  summary: string;
  criticalActions: string[];
  warningActions: string[];
  passed: string[];
}

export interface AuditReport {
  url: string;
  crawledUrls: string[];
  timestamp: number;
  safeMode: boolean;
  totals: { critical: number; warning: number; info: number; passed: number };
  findings: AuditFinding[];
  agentFeedback: AgentFeedback;
}

export interface AuditOptions {
  safeMode?: boolean;       // If true, never submit forms (passive only)
  crawl?: boolean;          // If true, auto-follow same-domain links
  maxCrawlDepth?: number;   // Max pages to crawl (default 5)
  checks?: Array<'headers' | 'xss' | 'auth' | 'data' | 'deps' | 'exploits' | 'openclaw'>;
}

const XSS_PROBE = '"><img src=x onerror=window.__spliceXSSHit=true>';
const SECRET_PATTERNS = [
  { name: 'API Key (generic)',  regex: /['"][a-zA-Z0-9_\-]{32,45}['"]/g },
  { name: 'JWT Token',          regex: /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g },
  { name: 'Stripe Key',         regex: /sk_(live|test)_[a-zA-Z0-9]{20,}/g },
  { name: 'AWS Access Key',     regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Private Key Block',  regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g },
  { name: 'Password in source', regex: /password\s*[:=]\s*['"][^'"]{4,}/gi },
];

export class SecurityAuditor {
  private findings: AuditFinding[] = [];
  private crawledUrls: Set<string> = new Set();

  constructor(private page: Page) {}

  private push(finding: AuditFinding) {
    this.findings.push(finding);
  }

  private pass(check: string, title: string) {
    this.push({ check, severity: 'PASS', title, detail: 'Check passed.', remediation: '' });
  }

  // ─────────────────────────────────────────────
  // CHECK 1: SECURITY HEADERS
  // ─────────────────────────────────────────────
  async checkHeaders(response: Response | null, url: string) {
    const headers = response ? response.headers() : {};

    const required: Array<{ header: string; severity: Severity; title: string; detail: string; remediation: string }> = [
      {
        header: 'content-security-policy',
        severity: 'CRITICAL',
        title: 'Missing Content-Security-Policy (CSP)',
        detail: 'No CSP header found. This allows arbitrary scripts to execute, enabling XSS attacks.',
        remediation: "Add to your server: Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none';"
      },
      {
        header: 'strict-transport-security',
        severity: 'WARNING',
        title: 'Missing Strict-Transport-Security (HSTS)',
        detail: 'HSTS is not set. Browsers may connect over HTTP, enabling downgrade attacks.',
        remediation: "Strict-Transport-Security: max-age=31536000; includeSubDomains; preload"
      },
      {
        header: 'x-frame-options',
        severity: 'WARNING',
        title: 'Missing X-Frame-Options (Clickjacking Risk)',
        detail: 'Page can be embedded in an iframe, enabling clickjacking attacks.',
        remediation: "X-Frame-Options: DENY  OR use CSP: frame-ancestors 'none';"
      },
      {
        header: 'x-content-type-options',
        severity: 'WARNING',
        title: 'Missing X-Content-Type-Options',
        detail: 'Browser may MIME-sniff responses, enabling content injection.',
        remediation: "X-Content-Type-Options: nosniff"
      },
      {
        header: 'referrer-policy',
        severity: 'INFO',
        title: 'Missing Referrer-Policy',
        detail: 'Full URLs may be leaked in Referer headers to third parties.',
        remediation: "Referrer-Policy: strict-origin-when-cross-origin"
      },
      {
        header: 'permissions-policy',
        severity: 'INFO',
        title: 'Missing Permissions-Policy',
        detail: 'Browser features (camera, mic, geolocation) are unrestricted.',
        remediation: "Permissions-Policy: geolocation=(), microphone=(), camera=()"
      }
    ];

    for (const req of required) {
      if (headers[req.header]) {
        this.pass('headers', `Header present: ${req.header}`);
      } else {
        this.push({ check: 'headers', affectedUrl: url, ...req });
      }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 2: XSS SURFACE SCANNER
  // ─────────────────────────────────────────────
  async checkXSS(safeMode: boolean, url: string) {
    const inputs = await this.page.evaluate(() => {
      const fields: Array<{ id: string; type: string; name: string }> = [];
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach(el => {
        fields.push({
          id: el.getAttribute('data-splice-id') || el.id || el.name || 'unknown',
          type: (el as HTMLInputElement).type || 'textarea',
          name: el.name
        });
      });
      return fields;
    });

    if (inputs.length === 0) {
      this.pass('xss', 'No user-input fields found on this page.');
      return;
    }

    this.push({
      check: 'xss',
      severity: 'INFO',
      title: `XSS Surface: ${inputs.length} input field(s) detected`,
      detail: `Fields found: ${inputs.map(i => i.name || i.id).join(', ')}`,
      remediation: 'Ensure all user input is sanitized server-side and HTML-escaped on render. Use a library like DOMPurify for rich text.',
      affectedUrl: url
    });

    if (safeMode) {
      this.push({
        check: 'xss',
        severity: 'INFO',
        title: 'XSS Active Probe skipped (Safe Mode)',
        detail: 'Safe Mode is enabled. Enable active mode to inject XSS probe strings into detected fields.',
        remediation: 'Set safeMode: false in the audit options to run active XSS probing (dev environments only).',
        affectedUrl: url
      });
      return;
    }

    // Active probing (non-safe mode)
    for (const input of inputs) {
      if (input.type === 'submit' || input.type === 'button' || input.type === 'hidden') continue;
      try {
        await this.page.evaluate((args: { id: string; probe: string }) => {
          (window as any).__spliceXSSHit = false;
          const el = document.querySelector(`[data-splice-id="${args.id}"], #${args.id}, [name="${args.id}"]`) as HTMLInputElement;
          if (el) el.value = args.probe;
        }, { id: input.id, probe: XSS_PROBE });

        await this.page.evaluate((id: string) => {
          const el = document.querySelector(`[data-splice-id="${id}"], #${id}, [name="${id}"]`) as HTMLInputElement;
          if (el) { el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }
        }, input.id);

        const hit = await this.page.evaluate(() => !!(window as any).__spliceXSSHit);
        if (hit) {
          this.push({
            check: 'xss',
            severity: 'CRITICAL',
            title: `XSS Vulnerability Detected: field "${input.name || input.id}"`,
            detail: `The probe string was executed (onerror triggered) in field: ${input.name || input.id}`,
            remediation: `Sanitize output for field "${input.name}". Use: textContent instead of innerHTML, or DOMPurify.sanitize() for rich text.`,
            affectedUrl: url,
            affectedElement: input.id
          });
        }
      } catch { /* Non-fatal probe failure */ }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 3: AUTH & CSRF
  // ─────────────────────────────────────────────
  async checkAuth(url: string) {
    const results = await this.page.evaluate(() => {
      const issues: string[] = [];
      const forms = Array.from(document.querySelectorAll('form'));

      for (const form of forms) {
        const hasCSRF = form.querySelector('input[name*="csrf"], input[name*="token"], input[name*="_token"]');
        if (!hasCSRF && (form.method?.toLowerCase() === 'post' || !form.method)) {
          issues.push(`CSRF: Form at action="${form.action || 'self'}" has no CSRF token field.`);
        }
      }

      const passwordFields = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
      for (const field of passwordFields) {
        if (field.autocomplete !== 'off' && field.autocomplete !== 'new-password' && field.autocomplete !== 'current-password') {
          issues.push(`AUTH: Password field "${field.name || field.id}" lacks proper autocomplete attribute.`);
        }
      }

      return issues;
    });

    if (results.length === 0) {
      this.pass('auth', 'No obvious CSRF or auth misconfigurations detected.');
    } else {
      for (const issue of results) {
        const isCsrf = issue.startsWith('CSRF');
        this.push({
          check: 'auth',
          severity: isCsrf ? 'CRITICAL' : 'WARNING',
          title: isCsrf ? 'Missing CSRF Token on Form' : 'Password Field Autocomplete Issue',
          detail: issue,
          remediation: isCsrf
            ? 'Add a hidden CSRF token field to all POST forms. In Express: use csurf middleware. In Next.js: use next-csrf.'
            : 'Add autocomplete="new-password" to registration fields and autocomplete="current-password" to login fields.',
          affectedUrl: url
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 4: SENSITIVE DATA EXPOSURE
  // ─────────────────────────────────────────────
  async checkDataExposure(url: string) {
    const results = await this.page.evaluate((patterns) => {
      const issues: Array<{ type: string; context: string }> = [];

      // Scan all inline scripts
      document.querySelectorAll('script:not([src])').forEach(script => {
        const content = script.textContent || '';
        for (const { name, regex } of patterns) {
          const re = new RegExp(regex.source, regex.flags);
          const matches = content.match(re);
          if (matches && matches.length > 0) {
            issues.push({ type: name, context: `Inline script (first 50 chars of match): ${matches[0].substring(0, 50)}` });
          }
        }
      });

      // Scan localStorage keys
      const sensitiveStorageKeys = ['token', 'password', 'secret', 'apikey', 'api_key', 'auth', 'jwt', 'credentials'];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || '';
        if (sensitiveStorageKeys.some(s => key.toLowerCase().includes(s))) {
          issues.push({ type: 'Sensitive localStorage Key', context: `Key: "${key}"` });
        }
      }

      // Scan sessionStorage keys
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i) || '';
        if (sensitiveStorageKeys.some(s => key.toLowerCase().includes(s))) {
          issues.push({ type: 'Sensitive sessionStorage Key', context: `Key: "${key}"` });
        }
      }

      return issues;
    }, SECRET_PATTERNS.map(p => ({ name: p.name, regex: { source: p.regex.source, flags: p.regex.flags } })));

    if (results.length === 0) {
      this.pass('data', 'No obvious sensitive data exposed in scripts or storage.');
    } else {
      for (const issue of results) {
        this.push({
          check: 'data',
          severity: 'CRITICAL',
          title: `Sensitive Data Exposed: ${issue.type}`,
          detail: issue.context,
          remediation: issue.type.includes('storage')
            ? 'Never store auth tokens or passwords in localStorage/sessionStorage. Use httpOnly cookies instead.'
            : 'Move secrets to server-side environment variables. Never embed API keys or tokens in client-side JavaScript.',
          affectedUrl: url
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 5: DEPENDENCIES & RESOURCE INTEGRITY
  // ─────────────────────────────────────────────
  async checkDependencies(url: string) {
    const results = await this.page.evaluate(() => {
      const issues: Array<{ severity: string; title: string; detail: string; remediation: string }> = [];
      const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'));

      for (const script of scripts) {
        const src = script.src;
        if (!src) continue;

        const isExternal = !src.startsWith(window.location.origin);

        if (isExternal && !script.integrity) {
          issues.push({
            severity: 'WARNING',
            title: `External Script Without SRI: ${src.split('/').pop()}`,
            detail: `Script loaded from ${new URL(src).hostname} has no Subresource Integrity (SRI) hash.`,
            remediation: `Add integrity and crossorigin attributes. Generate hash at: https://www.srihash.org/\nExample: <script src="${src}" integrity="sha384-..." crossorigin="anonymous">`
          });
        }

        if (src.startsWith('http://')) {
          issues.push({
            severity: 'CRITICAL',
            title: `Mixed Content: Script loaded over HTTP`,
            detail: `Script ${src} is loaded over an insecure HTTP connection.`,
            remediation: `Change the script src to use https:// instead of http://.`
          });
        }
      }

      return issues;
    });

    if (results.length === 0) {
      this.pass('deps', 'All external scripts have SRI hashes or are same-origin.');
    } else {
      for (const issue of results) {
        this.push({
          check: 'deps',
          severity: issue.severity as Severity,
          title: issue.title,
          detail: issue.detail,
          remediation: issue.remediation,
          affectedUrl: url
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 6: AGENT EXPLOITS & ACE
  // ─────────────────────────────────────────────
  async checkAgentExploits(url: string) {
    const results = await this.page.evaluate(() => {
      const issues: Array<{ severity: string; title: string; detail: string; remediation: string }> = [];
      const codeBlocks = Array.from(document.querySelectorAll('pre, code'));
      
      const ACE_PATTERNS = [
        { name: 'Reverse Shell', regex: /(nc|netcat|bash -i) .*>&\d/i },
        { name: 'Destructive OS Command', regex: /rm\s+-rf\s+\/|mkfs|dd if=\/dev\/(zero|random)/i },
        { name: 'Remote Execution Pipeline', regex: /(curl|wget)\s+.*\|\s*(bash|sh|zsh)/i },
        { name: 'Cryptominer/Malware download', regex: /(chmod \+x.*&&.*\.\/|powershell.*-e|Invoke-WebRequest)/i }
      ];

      for (const block of codeBlocks) {
        const content = block.textContent || '';
        for (const pattern of ACE_PATTERNS) {
          if (pattern.regex.test(content)) {
            issues.push({
              severity: 'CRITICAL',
              title: `Agent Exploit Detected: ${pattern.name}`,
              detail: `A code block contains a potentially malicious command: ${content.substring(0, 100)}...`,
              remediation: 'Do not allow autonomous agents to execute code blocks from this page without human verification.'
            });
          }
        }
      }
      return issues;
    });

    if (results.length === 0) {
      this.pass('exploits', 'No obvious malicious agent exploits found in code blocks.');
    } else {
      for (const issue of results) {
        this.push({
          check: 'exploits',
          severity: issue.severity as Severity,
          title: issue.title,
          detail: issue.detail,
          remediation: issue.remediation,
          affectedUrl: url
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  // CHECK 7: OPENCLAW GATEWAY, SKILLS & CLAWJACKED
  // ─────────────────────────────────────────────
  async checkOpenClaw(url: string) {
    // 1. Port scanning for unsecured local OpenClaw gateway
    const checkPort = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(800);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.connect(port, '127.0.0.1');
      });
    };

    try {
      const gatewayOpen = await checkPort(18789);
      if (gatewayOpen) {
        this.push({
          check: 'openclaw',
          severity: 'WARNING',
          title: 'Active OpenClaw Gateway Detected',
          detail: 'An active OpenClaw gateway was detected running on local port 18789. Ensure this gateway is strictly bound to 127.0.0.1 and not exposed externally.',
          remediation: 'Verify your gateway config. Bind to 127.0.0.1 (localhost) only, or implement a VPN/Tailscale layer.',
          affectedUrl: url
        });
      } else {
        this.pass('openclaw', 'No unsecured local OpenClaw gateway exposed on port 18789.');
      }
    } catch {
      // Ignore network errors in port scanner
    }

    // 2. ClawJacked Exploit & Prompt Injection Scanning
    const clawjackedFindings = await this.page.evaluate(() => {
      const results: string[] = [];
      
      // Script references
      document.querySelectorAll('script').forEach(script => {
        const text = script.textContent || '';
        if (/ws:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):18789/i.test(text) || /openclaw/i.test(text)) {
          results.push(`Script block attempts connection/reference to OpenClaw: "${text.substring(0, 100)}..."`);
        }
      });

      // Prompt injection attempts targeting local tools
      const selector = 'span, div, p, a, input, textarea, code, pre';
      document.querySelectorAll(selector).forEach(el => {
        const text = el.textContent || (el as HTMLInputElement).value || '';
        if (/openclaw.*(execute|run|shell|terminal|token|credentials|leak)/i.test(text)) {
          results.push(`Potential prompt injection in ${el.tagName}: "${text.trim().substring(0, 120)}..."`);
        }
      });

      return results;
    });

    if (clawjackedFindings.length > 0) {
      for (const finding of clawjackedFindings) {
        this.push({
          check: 'openclaw',
          severity: 'CRITICAL',
          title: 'ClawJacked Exploit / Prompt Injection Found',
          detail: finding,
          remediation: 'Sanitize webpage inputs and dynamic elements before exposing them to autonomous browser agents.',
          affectedUrl: url
        });
      }
    } else {
      this.pass('openclaw', 'No ClawJacked prompt injections or external websocket connections detected.');
    }

    // 3. Unsafe Local OpenClaw Skills Scanning (local directory scan)
    const localDir = process.cwd();
    const results: string[] = [];
    const scanSkillDir = (dir: string, depth = 0) => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            scanSkillDir(fullPath, depth + 1);
          } else if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.json')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            // Malicious skill signature check (accessing environment vars + sending to external server/discord webhooks or executing commands)
            if (/claw.*skill/i.test(file) || /molt.*plugin/i.test(file)) {
              if (/process\.env/i.test(content) && /(exec|eval|spawn|child_process)/i.test(content)) {
                results.push(`Unsafe skill file: ${file} (contains system-level execution capability with environment access)`);
              }
            }
          }
        }
      } catch {}
    };

    scanSkillDir(localDir);
    if (results.length > 0) {
      for (const res of results) {
        this.push({
          check: 'openclaw',
          severity: 'WARNING',
          title: 'Unverified OpenClaw Skill Detected',
          detail: res,
          remediation: 'Audit the identified skill file. Ensure it is from a trusted source and run it in an isolated container/sandbox.',
          affectedUrl: url
        });
      }
    } else {
      this.pass('openclaw', 'No unverified or malicious local OpenClaw skills found in workspace.');
    }
  }

  // ─────────────────────────────────────────────
  // CRAWL LOGIC
  // ─────────────────────────────────────────────
  private async getLinksOnPage(baseOrigin: string): Promise<string[]> {
    const hrefs = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map(a => a.href)
    );
    return hrefs.filter(href => {
      try {
        const u = new URL(href);
        return u.origin === baseOrigin && !href.includes('#');
      } catch { return false; }
    });
  }

  // ─────────────────────────────────────────────
  // MAIN AUDIT RUNNER
  // ─────────────────────────────────────────────
  async audit(targetUrl: string, options: AuditOptions = {}): Promise<AuditReport> {
    this.findings = [];
    this.crawledUrls = new Set();

    const {
      safeMode = true,
      crawl = true,
      maxCrawlDepth = 5,
      checks = ['headers', 'xss', 'auth', 'data', 'deps', 'exploits', 'openclaw']
    } = options;

    const baseOrigin = new URL(targetUrl).origin;
    const queue = [targetUrl];

    while (queue.length > 0 && this.crawledUrls.size < maxCrawlDepth) {
      const url = queue.shift()!;
      if (this.crawledUrls.has(url)) continue;
      this.crawledUrls.add(url);

      let response: Response | null = null;
      try {
        response = await this.page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      } catch {
        this.push({
          check: 'headers', severity: 'WARNING',
          title: `Page unreachable: ${url}`,
          detail: 'Navigation timed out or page threw an error.',
          remediation: 'Verify the URL is correct and the server is running.',
          affectedUrl: url
        });
        continue;
      }

      if (checks.includes('headers')) await this.checkHeaders(response, url);
      if (checks.includes('xss'))     await this.checkXSS(safeMode, url);
      if (checks.includes('auth'))    await this.checkAuth(url);
      if (checks.includes('data'))    await this.checkDataExposure(url);
      if (checks.includes('deps'))    await this.checkDependencies(url);
      if (checks.includes('exploits')) await this.checkAgentExploits(url);
      if (checks.includes('openclaw')) await this.checkOpenClaw(url);

      // Crawl links from this page
      if (crawl) {
        const links = await this.getLinksOnPage(baseOrigin);
        for (const link of links) {
          if (!this.crawledUrls.has(link)) queue.push(link);
        }
      }
    }

    // ─── Build Structured Agent Feedback ───
    const critical = this.findings.filter(f => f.severity === 'CRITICAL');
    const warnings  = this.findings.filter(f => f.severity === 'WARNING');
    const infos     = this.findings.filter(f => f.severity === 'INFO');
    const passed    = this.findings.filter(f => f.severity === 'PASS');

    const agentFeedback: AgentFeedback = {
      summary: critical.length > 0
        ? `AUDIT FAILED: ${critical.length} critical security issue(s) must be fixed before deployment.`
        : warnings.length > 0
          ? `AUDIT PASSED WITH WARNINGS: No critical issues, but ${warnings.length} issue(s) should be addressed.`
          : 'AUDIT PASSED: No security issues detected.',
      criticalActions: critical.map(f => `[${f.affectedUrl || ''}] FIX NOW: ${f.title}\n  → ${f.remediation}`),
      warningActions:  warnings.map(f =>  `[${f.affectedUrl || ''}] IMPROVE: ${f.title}\n  → ${f.remediation}`),
      passed:          passed.map(f => `✓ ${f.title}`)
    };

    return {
      url: targetUrl,
      crawledUrls: Array.from(this.crawledUrls),
      timestamp: Date.now(),
      safeMode,
      totals: {
        critical: critical.length,
        warning: warnings.length,
        info: infos.length,
        passed: passed.length
      },
      findings: this.findings,
      agentFeedback
    };
  }
}
