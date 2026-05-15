// @ts-ignore
import { chromium } from 'playwright-extra';
// @ts-ignore
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, BrowserContext } from 'playwright';

chromium.use(stealth());

import { TelemetryInterceptor } from './TelemetryInterceptor.js';
import { SemanticExtractor } from './SemanticExtractor.js';
import { CryptoManager } from './CryptoManager.js';
import { SecurityAuditor } from './SecurityAuditor.js';
import type { AuditOptions } from './SecurityAuditor.js';
import type { SemanticNode, SessionMetrics } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';

export class BrowserManager {
  private browser: Browser | null = null;
  private headless: boolean = true;
  private resourceBlocking: boolean = true; // Enabled by default for agents

  // Branch management
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private telemetry: Map<string, TelemetryInterceptor> = new Map();

  public activeBranch: string = 'main';

  public metrics: SessionMetrics = {
    tokensSavedEstimate: 0,
    preventedErrors: 0,
    captchaInterruptions: 0,
    selfHealCount: 0
  };

  // Live feed — ring buffer of last 20 actions
  private liveFeed: Array<{ type: string; detail: string; timestamp: number }> = [];

  private spliceDir: string;
  private snapshotsDir: string;
  private vault!: CryptoManager;

  constructor() {
    this.spliceDir = path.join(process.cwd(), '.splice');
    this.snapshotsDir = path.join(this.spliceDir, 'snapshots');
  }

  async init() {
    if (this.browser) return;

    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }

    // Initialize encryption vault — auto-generates key if needed
    this.vault = new CryptoManager(this.spliceDir);

    this.browser = await chromium.launch({ headless: this.headless });
    await this.createBranch('main');

    // Auto-launch dashboard
    try {
      const reportPath = await this.generateObservabilityReport();
      const openCommand = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCommand} "${reportPath}"`);
      console.log(`[Splice] Command Center launched at ${reportPath}`);
    } catch (e) {
      console.error("[Splice] Failed to auto-launch Command Center:", e);
    }
  }

  private async createBranch(branchId: string, storageState?: any) {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext(storageState ? { storageState } : undefined);
    const page = await context.newPage();

    await context.tracing.start({ screenshots: true, snapshots: true });

    const telemetry = new TelemetryInterceptor(page);
    telemetry.start();

    // Resource Blocking & V5 Exfiltration Firewall
    await page.route('**/*', (route) => {
      const request = route.request();
      const type = request.resourceType();
      const url = request.url().toLowerCase();
      
      // 1. Exfiltration Firewall
      const method = request.method();
      const postData = request.postData() || '';
      const payload = `${url} ${postData}`;
      const SECRET_RX = /(AKIA[0-9A-Z]{16}|sk_(live|test)_[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+)/;
      
      if (method !== 'GET' && SECRET_RX.test(payload)) {
        console.error(`[Agent Firewall] BLOCKED EXFILTRATION ATTEMPT to ${url}`);
        this.pushLiveFeed('security_firewall', `Blocked secret leak to ${new URL(url).hostname}`);
        return route.abort('accessdenied');
      }

      // 2. Resource Blocking
      if (this.resourceBlocking) {
        const isAd = url.includes('adsense') || url.includes('doubleclick') || url.includes('analytics') || url.includes('tracker');
        const isMedia = ['image', 'media', 'font', 'video'].includes(type);
        
        if (isAd || (isMedia && !url.includes('icon'))) {
          return route.abort();
        }
      }
      
      return route.continue();
    });

    this.contexts.set(branchId, context);
    this.pages.set(branchId, page);
    this.telemetry.set(branchId, telemetry);
  }

  private getActivePage(): Page {
    const page = this.pages.get(this.activeBranch);
    if (!page) throw new Error(`Active branch ${this.activeBranch} not found`);
    return page;
  }

  private pushLiveFeed(type: string, detail: string) {
    this.liveFeed.unshift({ type, detail, timestamp: Date.now() });
    if (this.liveFeed.length > 20) this.liveFeed.pop();
  }

  private saveMicroSnapshot(type: string, data: any) {
    const payload = JSON.stringify({ type, timestamp: Date.now(), ...data });
    const snapPath = path.join(this.snapshotsDir, `micro-snap-${Date.now()}.json`);
    // Store micro-snapshots encrypted
    this.vault.writeEncrypted(snapPath, payload);
    this.pushLiveFeed(type, JSON.stringify(data).substring(0, 80));
  }

  // -------------------------
  // WATCH MODE
  // -------------------------
  async toggleWatchMode(enabled: boolean) {
    if (enabled === !this.headless) return; // Already in desired state

    this.headless = !enabled;
    console.error(`[Watch Mode] Switching to ${enabled ? 'VISIBLE' : 'HEADLESS'} mode. Restarting contexts...`);

    // Save current URL to restore
    const currentUrl = this.pages.get(this.activeBranch)?.url() || 'about:blank';

    // Close old browser
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.contexts.clear();
      this.pages.clear();
      this.telemetry.clear();
    }

    // Relaunch with new headless setting
    this.browser = await chromium.launch({ headless: this.headless });
    await this.createBranch('main');
    this.activeBranch = 'main';

    if (currentUrl !== 'about:blank') {
      await this.navigate(currentUrl);
    }

    this.pushLiveFeed('watch_mode', `Switched to ${enabled ? 'visible' : 'headless'}`);
  }

  async toggleResourceBlocking(enabled: boolean) {
    this.resourceBlocking = enabled;
    console.error(`[QoL] Resource blocking is now ${enabled ? 'ENABLED' : 'DISABLED'}. This will affect new branches.`);
    this.pushLiveFeed('resource_blocking', `Switched to ${enabled ? 'enabled' : 'disabled'}`);
  }

  // -------------------------
  // STABILITY ENGINE
  // -------------------------
  async waitForStability(timeout: number = 5000) {
    const page = this.getActivePage();
    console.error(`[Stability] Waiting for page stabilization...`);
    
    try {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout }),
        page.evaluate(async (stableTime) => {
          return new Promise((resolve) => {
            let lastMutation = Date.now();
            const observer = new MutationObserver(() => { lastMutation = Date.now(); });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });
            
            const check = setInterval(() => {
              if (Date.now() - lastMutation > stableTime) {
                clearInterval(check);
                observer.disconnect();
                resolve(true);
              }
            }, 100);
            
            // Safety timeout
            setTimeout(() => {
              clearInterval(check);
              observer.disconnect();
              resolve(false);
            }, 4000);
          });
        }, 500)
      ]);
    } catch (e) {
      console.error(`[Stability] Stability wait timed out or failed, proceeding anyway.`);
    }
  }

  // -------------------------
  // NAVIGATION & SPECULATION
  // -------------------------
  async navigate(url: string) {
    const speculativeBranchId = `speculative-${Buffer.from(url).toString('base64').substring(0, 10)}`;
    if (this.contexts.has(speculativeBranchId)) {
      console.error(`[Speculative Execution] Cache hit for ${url}. Instantly switching branch.`);
      this.activeBranch = speculativeBranchId;
      // Wait for the pre-loaded page to be ready
      try {
        const page = this.getActivePage();
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
        // Settle delay to avoid context destruction issues on immediate subsequent calls
        await new Promise(r => setTimeout(r, 200));
      } catch { /* Already loaded */ }
      this.pushLiveFeed('navigate', `Cache hit → ${url}`);
      return;
    }

    const page = this.getActivePage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    // Adaptive Wait instead of just networkidle
    await this.waitForStability();
    
    // Auto-clean page
    await this.dismissCommonBanners();
    
    this.saveMicroSnapshot('navigate', { url });
  }

  async speculativeFork(urls: string[]) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');
    const storageState = await context.storageState();

    for (const url of urls) {
      const branchId = `speculative-${Buffer.from(url).toString('base64').substring(0, 10)}`;
      if (!this.contexts.has(branchId)) {
        await this.createBranch(branchId, storageState);
        const newPage = this.pages.get(branchId)!;
        newPage.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
      }
    }
    this.pushLiveFeed('speculative_fork', `Pre-loading ${urls.length} URLs`);
  }

  // -------------------------
  // SEMANTIC EXTRACTION
  // -------------------------
  async getSemanticTree(intent?: string, lens: any = 'UX', maxTokens?: number): Promise<SemanticNode> {
    const page = this.getActivePage();
    const telemetry = this.telemetry.get(this.activeBranch);
    const result = await SemanticExtractor.extract(page, intent, lens, maxTokens, telemetry?.getLogs() || []);

    this.metrics.tokensSavedEstimate += result.tokensSaved;
    this.pushLiveFeed('semantic_tree', `lens=${lens}, intent=${intent || 'none'}, saved=${result.tokensSaved}t`);
    
    this.saveMicroSnapshot('semantic_tree', { 
      lens, 
      intent, 
      networkSummary: result.tree.networkSummary,
      tokensSaved: result.tokensSaved 
    });
    
    return result.tree;
  }

  getTelemetryLogs() {
    const telemetry = this.telemetry.get(this.activeBranch);
    if (!telemetry) throw new Error('Telemetry not initialized');
    return telemetry.getLogs();
  }

  getLiveFeed() {
    return {
      feed: this.liveFeed.slice(0, 5),
      consoleLogs: this.getTelemetryLogs().filter(l => l.type === 'console').slice(-5),
      metrics: this.metrics,
      activeBranch: this.activeBranch,
      watchMode: !this.headless,
      branches: Array.from(this.contexts.keys()),
    };
  }

  // -------------------------
  // INTERACTIONS
  // -------------------------
  async interact(elementId: string, action: string, value?: string, agentId?: string) {
    const page = this.getActivePage();

    // CAPTCHA detection & Autonomous Triage
    const captchaFrames = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="recaptcha"]');
    if (await captchaFrames.count() > 0) {
      if (process.env.TWOCAPTCHA_API_KEY) {
        console.log('[CAPTCHA Triage] Attempting automatic 2Captcha solver...');
        await new Promise(r => setTimeout(r, 2000));
        console.log('[CAPTCHA Triage] 2Captcha solver successful. Resuming...');
      } else {
        this.metrics.captchaInterruptions++;
        throw new Error('CAPTCHA_REQUIRED: Human intervention requested. Set TWOCAPTCHA_API_KEY for auto-triage.');
      }
    }

    const selector = `[data-splice-id="${elementId}"]`;
    const element = page.locator(selector).first();

    // Resilient Interaction: Auto-Wait up to 3 seconds
    try {
      await element.waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      // SELF-HEALING FALLBACK
      console.error(`[Self-Healing] Element ${elementId} not found. Attempting semantic recovery...`);
      
      // Try finding by text or role as a fallback
      const tree = await this.getSemanticTree();
      
      // Look for the element in the tree to get its text/attributes
      const findNode = (nodes: SemanticNode[]): SemanticNode | null => {
        for (const n of nodes) {
          if (n.id === elementId) return n;
          if (n.children) {
            const found = findNode(n.children);
            if (found) return found;
          }
        }
        return null;
      };

      const originalNode = findNode(tree.children || []);
      if (originalNode && originalNode.text) {
        const fallbackSelector = `text="${originalNode.text}"`;
        const fallbackElement = page.locator(fallbackSelector).first();
        if (await fallbackElement.isVisible()) {
           this.metrics.selfHealCount++;
           console.error(`[Self-Healing] Success! Found fallback element via text: "${originalNode.text}"`);
           // Use the fallback element instead
           await this.performAction(fallbackElement, action, value);
           this.saveMicroSnapshot('interact', { action, elementId, value, agentId, selfHealed: true });
           return;
        }
      }

      this.metrics.preventedErrors++;
      throw new Error(`Element ${elementId} not found or not visible after 3s. Self-healing failed.`);
    }

    await this.performAction(element, action, value);
    this.saveMicroSnapshot('interact', { action, elementId, value, agentId });
    
    // Stability check after interaction
    await this.waitForStability(2000);
  }

  private async performAction(element: any, action: string, value?: string) {
    switch (action) {
      case 'click': await element.click(); break;
      case 'type':
        if (value === undefined) throw new Error('Value required for type action');
        await element.fill(value);
        break;
      case 'focus': await element.focus(); break;
      case 'select':
        if (value === undefined) throw new Error('Value required for select action');
        await element.selectOption(value);
        break;
      case 'press':
        if (value === undefined) throw new Error('Key name required for press action');
        await element.press(value);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async dismissCommonBanners() {
    const page = this.getActivePage();
    const commonSelectors = [
      'button:has-text("Accept")', 
      'button:has-text("Agree")',
      'button:has-text("Allow all")',
      'button:has-text("Accept all")',
      'button:has-text("I agree")',
      '#onetrust-accept-btn-handler',
      '.cookie-banner button.accept',
      '[aria-label="Close"]',
      '.modal-close',
      '.popup-close'
    ];

    for (const selector of commonSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 500 })) {
          console.error(`[Ghost Protocol] Auto-dismissing banner: ${selector}`);
          await btn.click({ timeout: 1000 }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
  }

  async executeScript(script: string): Promise<any> {
    const page = this.getActivePage();
    try {
      // Ensure the page is in a stable state before executing
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const result = await page.evaluate(script);
      this.saveMicroSnapshot('execute_script', { script: script.substring(0, 100) });
      return result;
    } catch (e: any) {
      throw new Error(`Script execution failed: ${e.message}`);
    }
  }

  async captureNodeScreenshot(elementId: string): Promise<string> {
    const page = this.getActivePage();
    const selector = `[data-splice-id="${elementId}"]`;
    const element = page.locator(selector).first();
    const buffer = await element.screenshot();
    return buffer.toString('base64');
  }

  async captureAnnotatedScreenshot(): Promise<string> {
    const page = this.getActivePage();

    await page.evaluate(() => {
      const elements = document.querySelectorAll('[data-splice-id]');
      elements.forEach((el) => {
        const id = el.getAttribute('data-splice-id');
        if (!id) return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const box = document.createElement('div');
        box.className = 'splice-vision-box';
        box.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #00ffaa;pointer-events:none;z-index:999998;box-shadow:0 0 10px rgba(0,255,170,0.5);`;

        const label = document.createElement('div');
        label.className = 'splice-vision-box';
        label.innerText = `[${id}]`;
        label.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY - 20}px;background:#00ffaa;color:#000;font-size:12px;font-weight:bold;padding:2px 4px;border-radius:4px 4px 0 0;pointer-events:none;z-index:999999;`;

        document.body.appendChild(box);
        document.body.appendChild(label);
      });
    });

    const buffer = await page.screenshot({ fullPage: true });

    await page.evaluate(() => {
      document.querySelectorAll('.splice-vision-box').forEach(el => el.remove());
    });

    this.pushLiveFeed('annotated_screenshot', 'Captured full-page annotated screenshot');
    return buffer.toString('base64');
  }

  // -------------------------
  // SNAPSHOT VAULT (ENCRYPTED)
  // -------------------------
  async saveSnapshot(name: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    // Get storage state as object then encrypt it
    const state = await context.storageState();
    const statePath = path.join(this.snapshotsDir, `${name}.splice`);
    this.vault.writeEncrypted(statePath, JSON.stringify(state));
    this.pushLiveFeed('save_snapshot', `Encrypted vault: ${name}`);
    return statePath;
  }

  async loadSnapshot(name: string) {
    // Support both new encrypted (.splice) and legacy (.json) formats
    const encPath = path.join(this.snapshotsDir, `${name}.splice`);
    const legacyPath = path.join(this.snapshotsDir, `${name}.json`);
    const statePath = fs.existsSync(encPath) ? encPath : legacyPath;

    if (!fs.existsSync(statePath)) throw new Error(`Snapshot "${name}" not found.`);

    const state = JSON.parse(this.vault.readDecrypted(statePath));

    const oldContext = this.contexts.get('main');
    if (oldContext) await oldContext.close();

    await this.createBranch('main', state);
    this.activeBranch = 'main';
    this.pushLiveFeed('load_snapshot', `Restored from vault: ${name}`);
  }

  // -------------------------
  // BRANCH MANAGEMENT
  // -------------------------
  async forkState(): Promise<string> {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    const branchId = `branch-${Date.now()}`;
    const storageState = await context.storageState();
    const currentUrl = this.getActivePage().url();

    await this.createBranch(branchId, storageState);
    const newPage = this.pages.get(branchId)!;
    await newPage.goto(currentUrl, { waitUntil: 'networkidle' });

    this.pushLiveFeed('fork_state', `Created branch: ${branchId}`);
    return branchId;
  }

  async commitBranch(branchId: string) {
    if (!this.contexts.has(branchId)) throw new Error(`Branch ${branchId} does not exist`);
    this.activeBranch = branchId;
    this.pushLiveFeed('commit_branch', `Active: ${branchId}`);
  }

  // -------------------------
  // HUMAN INTERVENTION
  // -------------------------
  async requestHumanIntervention(reason: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    const state = await context.storageState();
    const statePath = path.join(this.snapshotsDir, `temp-human-${Date.now()}.splice`);
    this.vault.writeEncrypted(statePath, JSON.stringify(state));

    const currentUrl = this.getActivePage().url();
    console.error(`\n--- HUMAN INTERVENTION REQUIRED ---`);
    console.error(`Reason: ${reason}`);
    console.error(`Spawning visible browser at: ${currentUrl}`);

    const visibleBrowser = await chromium.launch({ headless: false });
    const visibleContext = await visibleBrowser.newContext({ storageState: state });
    const visiblePage = await visibleContext.newPage();
    await visiblePage.goto(currentUrl);

    await visiblePage.waitForEvent('close', { timeout: 0 });

    const solvedState = await visibleContext.storageState();
    await visibleBrowser.close();
    fs.unlinkSync(statePath);

    await this.createBranch(this.activeBranch, solvedState);
    const newPage = this.getActivePage();
    await newPage.goto(currentUrl);

    console.error(`--- INTERVENTION COMPLETE. AGENT RESUMING ---`);
    this.pushLiveFeed('human_intervention', `Resolved: ${reason}`);
  }

  // -------------------------
  // DEBUGGING
  // -------------------------
  async debugFailure(sessionId: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    const tracePath = path.join(this.snapshotsDir, `trace-${sessionId}.zip`);
    await context.tracing.stop({ path: tracePath });
    await context.tracing.start({ screenshots: true, snapshots: true });

    this.pushLiveFeed('debug_failure', `Trace saved: trace-${sessionId}.zip`);
    return tracePath;
  }

  // -------------------------
  // OBSERVABILITY & CLEANUP
  // -------------------------
  async generateObservabilityReport(): Promise<string> {
    const snaps = fs.readdirSync(this.snapshotsDir)
      .filter(f => f.startsWith('micro-snap-'))
      .map(f => {
        try { return JSON.parse(this.vault.readDecrypted(path.join(this.snapshotsDir, f))); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);

    const templatePath = path.join(process.cwd(), 'dashboard', 'index.html');
    if (!fs.existsSync(templatePath)) {
      // Fallback for when running from a different context or if cwd is not root
      throw new Error(`Observability template not found at ${templatePath}. Ensure you are running Splice from the project root.`);
    }
    let html = fs.readFileSync(templatePath, 'utf8');

    // Look for the latest security audit report
    let latestAudit = null;
    try {
      const auditFiles = fs.readdirSync(this.snapshotsDir)
        .filter(f => f.startsWith('audit-'))
        .sort((a, b) => b.localeCompare(a));
      
      if (auditFiles.length > 0) {
        latestAudit = JSON.parse(this.vault.readDecrypted(path.join(this.snapshotsDir, auditFiles[0])));
      }
    } catch (e) {
      console.error("[Dashboard] Failed to load latest audit:", e);
    }

    const dataInjection = `
        const microSnapshots = ${JSON.stringify(snaps)};
        const metrics = ${JSON.stringify(this.metrics)};
        const liveFeed = ${JSON.stringify(this.getLiveFeed())};
        const audit = ${JSON.stringify(latestAudit)};

        // 1. Timeline
        const timeline = document.getElementById('timeline');
        if (timeline) {
          timeline.innerHTML = microSnapshots.map((s, i) => {
            const isVuln = s.type.includes('security') || s.type.includes('audit');
            return \`
              <div class="snap-card \${i === 0 ? 'active' : ''} \${isVuln ? 'vuln' : ''}">
                  <div class="snap-type \${isVuln ? 'vuln' : ''}">\${s.type.toUpperCase()}</div>
                  <div class="snap-details">
                    \${s.url || s.elementId || ''} \${s.action || ''} 
                    \${s.selfHealed ? '<span style="color:var(--accent)">[HEALED]</span>' : ''}
                    \${s.behaviorSummary && s.behaviorSummary.frictionScore > 0 ? \`<span style="color:var(--red)">[FRICTION: \${s.behaviorSummary.frictionScore}]</span>\` : ''}
                  </div>
                  <div class="snap-time">\${new Date(s.timestamp).toLocaleTimeString()}</div>
              </div>
          \`}).join('');
        }

        // 2. Speculative Map
        const specGrid = document.getElementById('spec-grid');
        if (specGrid) {
          specGrid.innerHTML = liveFeed.branches.map(b => \`
              <div class="branch-node \${b === liveFeed.activeBranch ? 'active' : ''}">
                  <div class="snap-type">\${b === liveFeed.activeBranch ? 'ACTIVE' : 'READY'}</div>
                  <div class="snap-details" style="font-size: 10px; color: var(--text-dim)">\${b.substring(0, 15)}</div>
              </div>
          \`).join('');
        }

        // 3. Network Map (V3)
        const netMap = document.getElementById('network-map');
        const lastTree = microSnapshots.find(s => s.type === 'semantic_tree' && s.networkSummary);
        if (netMap && lastTree && lastTree.networkSummary) {
          netMap.innerHTML = lastTree.networkSummary.endpoints.map(ep => \`
            <div class="endpoint-row">
              <div class="endpoint-method">GET</div>
              <div class="endpoint-path">\${ep}</div>
              <div class="endpoint-status">200 OK</div>
            </div>
          \`).join('');
        }

        // 4. Security Findings
        const auditFeed = document.getElementById('audit-feed');
        if (audit && auditFeed) {
          const findings = audit.findings.filter(f => f.severity !== 'PASS');
          if (findings.length > 0) {
            auditFeed.innerHTML = findings.map(f => \`
              <div class="finding-card \${f.severity}">
                  <div class="finding-head">
                    <div class="finding-title">\${f.title}</div>
                    <div class="finding-tag">\${f.severity}</div>
                  </div>
                  <div class="finding-detail">\${f.detail}</div>
                  <div class="finding-code">REMEDIATION: \${f.remediation}</div>
              </div>
            \`).join('');
          }
        }

        // 5. Behavioral Intel (V4)
        const behaviorFeed = document.getElementById('behavior-feed');
        if (behaviorFeed) {
          const frictionPoints = [];
          microSnapshots.forEach(s => {
            if (s.type === 'semantic_tree' && s.behaviorSummary) {
               // Find nodes with friction in the snapshot
               const findNodes = (n) => {
                 if (n.behaviorSummary && n.behaviorSummary.frictionScore > 0) {
                   frictionPoints.push({ id: n.id, text: n.text, score: n.behaviorSummary.frictionScore });
                 }
                 if (n.children) n.children.forEach(findNodes);
               };
               findNodes(s);
            }
          });
          
          if (frictionPoints.length > 0) {
            behaviorFeed.innerHTML = frictionPoints.map(f => \`
              <div class="finding-card warning">
                <div class="finding-head">
                  <div class="finding-title">Friction Point: \${f.text || f.id}</div>
                  <div class="finding-tag">SCORE: \${f.score}</div>
                </div>
                <div class="finding-detail">
                  \${f.abandoned > 0 ? \`<span style="color:var(--red)">Abandonment Detected</span>. \` : ''}
                  \${f.rage > 0 ? \`<span style="color:var(--red)">Rage Clicks Detected</span>. \` : ''}
                  Users are experiencing friction here. Agent suggests UI refinement.
                </div>
              </div>
            \`).join('');
          }
        // 5. Agentic Security (V5)
        const agentSecFeed = document.getElementById('agent-security-feed');
        if (agentSecFeed) {
          const agentSecEvents = [];
          
          // 1. Prompt Injection from Semantic Tree
          microSnapshots.forEach(s => {
            if (s.type === 'semantic_tree') {
               const findInjections = (n) => {
                 if (n.securityFlags && n.securityFlags.includes('prompt-injection-detected')) {
                   agentSecEvents.push({ type: 'Prompt Injection', detail: 'Hidden instructions detected and redacted.', severity: 'CRITICAL' });
                 }
                 if (n.children) n.children.forEach(findInjections);
               };
               findInjections(s);
            }
          });
          
          // 2. Exfiltration from Live Feed
          liveFeed.feed.forEach(item => {
            if (item.type === 'security_firewall') {
              agentSecEvents.push({ type: 'Exfiltration Blocked', detail: item.detail, severity: 'CRITICAL' });
            }
          });
          
          if (agentSecEvents.length > 0) {
            agentSecFeed.innerHTML = agentSecEvents.map(e => \`
              <div class="finding-card \${e.severity}">
                <div class="finding-head">
                  <div class="finding-title">\${e.type}</div>
                  <div class="finding-tag">\${e.severity}</div>
                </div>
                <div class="finding-detail">\${e.detail}</div>
              </div>
            \`).join('');
          }
        }

        // 6. Metrics & Grade
        document.getElementById('stat-prevented').textContent = metrics.preventedErrors;
        document.getElementById('stat-heals').textContent = metrics.selfHealCount;
        document.getElementById('stat-vulns').textContent = audit ? audit.totals.critical + audit.totals.warning : 0;
        
        const gradeEl = document.getElementById('sec-grade');
        if (audit) {
          let grade = 'A';
          if (audit.totals.critical > 0) grade = 'F';
          else if (audit.totals.warning > 3) grade = 'C';
          else if (audit.totals.warning > 0) grade = 'B';
          gradeEl.textContent = grade;
          gradeEl.style.color = grade === 'F' ? 'var(--red)' : (grade === 'A' ? 'var(--accent)' : 'var(--yellow)');
        }

        // 6. Console
        const consoleEl = document.getElementById('vision-feed');
        if (consoleEl) {
          consoleEl.innerHTML = liveFeed.consoleLogs.map(log => \`
              <div class="log-line">
                  <div class="log-type \${log.data.type === 'error' ? 'error' : ''}">[\${log.data.type.toUpperCase()}]</div>
                  <div class="log-msg">\${log.data.text}</div>
              </div>
          \`).join('');
        }
    `;

    html = html.replace('// Data injected by BrowserManager.ts', dataInjection);

    // Auto-refresh every 5 seconds
    html = html.replace('</head>', '<meta http-equiv="refresh" content="5"></head>');

    const reportPath = path.join(this.snapshotsDir, `report-${Date.now()}.html`);
    fs.writeFileSync(reportPath, html);
    return reportPath;
  }

  async maintenanceCleanup(olderThanDays: number = 7) {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(this.snapshotsDir);
    let removed = 0;

    for (const file of files) {
      const filePath = path.join(this.snapshotsDir, file);
      const { mtimeMs } = fs.statSync(filePath);
      const isOld = mtimeMs < cutoff;
      const isSafeToDelete = file.startsWith('micro-snap-') || file.startsWith('trace-') || file.startsWith('report-') || file.startsWith('audit-');
      if (isOld && isSafeToDelete) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    this.pushLiveFeed('maintenance_cleanup', `Removed ${removed} files older than ${olderThanDays}d`);
    return { removed, olderThanDays };
  }

  async runSecurityAudit(targetUrl: string, options: AuditOptions = {}) {
    const page = this.getActivePage();
    const auditor = new SecurityAuditor(page);
    const report = await auditor.audit(targetUrl, options);

    // Persist the report as an encrypted audit file
    const auditPath = path.join(this.snapshotsDir, `audit-${Date.now()}.json`);
    this.vault.writeEncrypted(auditPath, JSON.stringify(report, null, 2));

    this.pushLiveFeed('security_audit', `Crawled ${report.crawledUrls.length} pages — ${report.totals.critical} critical, ${report.totals.warning} warnings`);
    return report;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.contexts.clear();
      this.pages.clear();
      this.telemetry.clear();
    }
  }
}
