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
import { AgentCoordinator } from './AgentCoordinator.js';
import { AgentTracker } from './AgentTracker.js';
import { OpenClawGateway } from './OpenClawGateway.js';
import { discordNotifier } from './DiscordWebhook.js';
import type { AuditOptions } from './SecurityAuditor.js';
import { SpliceError, withRetry, isTransientError, errorMessage } from './Resilience.js';
import type { AgentStateDiagnosis, LedgerEntry, SemanticNode, SessionMetrics, VerifiedActionPlan, SummonRequest } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';


export class BrowserManager {
  private browser: Browser | null = null;
  private headless: boolean = true;
  private resourceBlocking: boolean = true; // Enabled by default for agents

  // Branch management
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private telemetry: Map<string, TelemetryInterceptor> = new Map();

  public activeBranch: string = 'main';

  // Runtime reliability state
  private lastKnownUrls: Map<string, string> = new Map();
  private crashedBranches: Set<string> = new Set();
  /** Suppresses crash accounting while Splice itself tears the browser down. */
  private expectingShutdown = false;
  private browserCrashCount = 0;
  private lastRecoveryAt: number | null = null;
  private startedAt: number = Date.now();
  /** Called on crash/recovery so the server layer can journal it. */
  public onReliabilityEvent: ((kind: 'crash' | 'recovery', detail: string) => void) | null = null;
  /** Set by the server layer so runtime health and the dashboard include journal statistics. */
  public journalStatsProvider: (() => Record<string, unknown>) | null = null;

  /** Multi-agent coordination engine — exposed for MCP tool layer. */
  public readonly coordinator: AgentCoordinator = new AgentCoordinator();

  /** Per-agent performance tracking and in-action optimization. */
  public readonly agentTracker: AgentTracker = new AgentTracker();

  /** Rolling history of recent diagnoses — feeds the predictive trend layer. */
  private diagnosisHistory: Array<{ state: AgentStateDiagnosis['state']; url: string; timestamp: number }> = [];

  // OpenClaw Gateway instance
  private openclawGateway: OpenClawGateway | null = null;

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

    await this.launchBrowser();
    await this.createBranch('main');

    // Optional OpenClaw Gateway initialization
    if (process.env.SPLICE_ENABLE_OPENCLAW === '1') {
      try {
        this.openclawGateway = new OpenClawGateway(this);
        await this.openclawGateway.start();
        this.pushLiveFeed('openclaw_gateway', 'Gateway started automatically');
      } catch (e: any) {
        console.error("[Splice] Failed to start optional OpenClaw Gateway:", e.message);
      }
    }

    if (process.env.SPLICE_AUTO_OPEN_DASHBOARD === '1') {
      try {
        const reportPath = await this.generateObservabilityReport();
        this.openDashboard(reportPath);
        console.error(`[Splice] Command Center launched at ${reportPath}`);
      } catch (e) {
        console.error("[Splice] Failed to auto-launch Command Center:", e);
      }
    }
  }

  private async launchBrowser() {
    this.browser = await chromium.launch({ headless: this.headless });
    // If Chromium dies underneath us (OOM, host kill, crash), mark the
    // session so the next tool call transparently relaunches instead of
    // failing every call until the MCP server is restarted.
    this.browser!.on('disconnected', () => {
      if (this.browser && !this.expectingShutdown) {
        this.browserCrashCount++;
        this.browser = null;
        this.onReliabilityEvent?.('crash', 'Browser process disconnected unexpectedly');
        console.error('[Splice Reliability] Browser disconnected — will auto-recover on next call.');
      }
    });
  }

  /**
   * Runtime reliability gate. Called at the top of every browser-touching
   * operation: relaunches a dead browser and rebuilds crashed branches,
   * restoring each branch's last known URL so the agent resumes where it
   * left off instead of dying mid-run.
   */
  public async ensureHealthy(): Promise<void> {
    if (!this.browser || !this.browser.isConnected()) {
      const branchesToRestore = new Map(this.lastKnownUrls);
      const previousActive = this.activeBranch;
      this.browser = null;
      this.contexts.clear();
      this.pages.clear();
      this.telemetry.clear();
      this.crashedBranches.clear();

      await this.launchBrowser();
      await this.createBranch('main');
      this.activeBranch = 'main';

      const mainUrl = branchesToRestore.get(previousActive) || branchesToRestore.get('main');
      if (mainUrl && mainUrl !== 'about:blank') {
        try {
          await this.getActivePage().goto(mainUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
          console.error(`[Splice Reliability] Could not restore URL after relaunch: ${errorMessage(e)}`);
        }
      }
      this.lastRecoveryAt = Date.now();
      this.onReliabilityEvent?.('recovery', `Browser relaunched; restored ${mainUrl ?? 'blank session'} on main`);
      this.pushLiveFeed('auto_recovery', `Browser relaunched after crash (#${this.browserCrashCount})`);
      return;
    }

    // Rebuild individual branches whose page crashed or was closed.
    for (const branchId of Array.from(this.crashedBranches)) {
      this.crashedBranches.delete(branchId);
      const lastUrl = this.lastKnownUrls.get(branchId);
      try {
        await this.contexts.get(branchId)?.close().catch(() => {});
        this.contexts.delete(branchId);
        this.pages.delete(branchId);
        this.telemetry.delete(branchId);
        await this.createBranch(branchId);
        if (lastUrl && lastUrl !== 'about:blank') {
          await this.pages.get(branchId)!.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        }
        this.lastRecoveryAt = Date.now();
        this.onReliabilityEvent?.('recovery', `Branch ${branchId} rebuilt after page crash`);
        this.pushLiveFeed('auto_recovery', `Branch ${branchId} rebuilt after page crash`);
      } catch (e) {
        console.error(`[Splice Reliability] Failed to rebuild branch ${branchId}: ${errorMessage(e)}`);
      }
    }
  }

  /** Live health snapshot for the get_runtime_health MCP tool. */
  public getRuntimeHealth() {
    return {
      browserConnected: !!this.browser && this.browser.isConnected(),
      activeBranch: this.activeBranch,
      branches: Array.from(this.contexts.keys()).map((branchId) => ({
        branchId,
        lastKnownUrl: this.lastKnownUrls.get(branchId) ?? 'about:blank',
        crashed: this.crashedBranches.has(branchId),
      })),
      browserCrashCount: this.browserCrashCount,
      lastRecoveryAt: this.lastRecoveryAt,
      uptimeMs: Date.now() - this.startedAt,
      headless: this.headless,
      resourceBlocking: this.resourceBlocking,
      openclawGatewayActive: !!this.openclawGateway,
      metrics: this.metrics,
      journal: this.journalStatsProvider ? this.journalStatsProvider() : null,
    };
  }

  private openDashboard(reportPath: string) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', reportPath] : [reportPath];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  private sanitizeFileName(name: string): string {
    const sanitized = name.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
      throw new Error('A valid snapshot or trace name is required.');
    }
    return sanitized.slice(0, 120);
  }

  private branchIdForUrl(url: string): string {
    return `speculative-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  }

  private async createBranch(branchId: string, storageState?: any) {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext(storageState ? { storageState } : undefined);
    const page = await context.newPage();

    await context.tracing.start({ screenshots: true, snapshots: true });

    const telemetry = new TelemetryInterceptor(page);
    telemetry.start();

    // Mark crashed/closed pages for lazy rebuild on the next ensureHealthy pass.
    page.on('crash', () => {
      this.crashedBranches.add(branchId);
      this.onReliabilityEvent?.('crash', `Page crashed on branch ${branchId}`);
      console.error(`[Splice Reliability] Page crashed on branch ${branchId} — queued for rebuild.`);
    });
    page.on('close', () => {
      if (this.pages.get(branchId) === page && this.browser?.isConnected() && !this.expectingShutdown) {
        this.crashedBranches.add(branchId);
      }
    });

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
    // A freshly built branch is healthy by definition.
    this.crashedBranches.delete(branchId);
  }

  public getActivePage(): Page {
    const page = this.pages.get(this.activeBranch);
    if (!page) throw new Error(`Active branch ${this.activeBranch} not found`);
    return page;
  }

  private pushLiveFeed(type: string, detail: string) {
    this.liveFeed.unshift({ type, detail, timestamp: Date.now() });
    if (this.liveFeed.length > 20) this.liveFeed.pop();

    if (this.openclawGateway) {
      this.openclawGateway.broadcast('live_feed_update', { type, detail });
    }
  }

  private saveMicroSnapshot(type: string, data: any) {
    const payload = JSON.stringify({ type, timestamp: Date.now(), ...data });
    const snapPath = path.join(this.snapshotsDir, `micro-snap-${Date.now()}.json`);
    // Store micro-snapshots encrypted
    this.vault.writeEncrypted(snapPath, payload);
    this.pushLiveFeed(type, JSON.stringify(data).substring(0, 80));
  }

  private tokenizeIntent(intent: string): string[] {
    const stopWords = new Set(['the', 'and', 'for', 'with', 'into', 'onto', 'that', 'this', 'from', 'then', 'please', 'click', 'press', 'open', 'go', 'to', 'on', 'a', 'an']);
    return intent.toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length > 2 && !stopWords.has(token));
  }

  private inferActionFromIntent(intent: string, value?: string): 'click' | 'type' | 'focus' | 'select' | 'press' {
    const normalized = intent.toLowerCase();
    if (value !== undefined || /\b(type|enter|fill|write|input)\b/.test(normalized)) return 'type';
    if (/\b(select|choose|pick)\b/.test(normalized)) return 'select';
    if (/\b(focus)\b/.test(normalized)) return 'focus';
    if (/\b(press|keyboard|key)\b/.test(normalized)) return 'press';
    return 'click';
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

    // Close old browser (intentional — not a crash)
    if (this.browser) {
      this.expectingShutdown = true;
      try {
        await this.browser.close();
      } finally {
        this.expectingShutdown = false;
      }
      this.browser = null;
      this.contexts.clear();
      this.pages.clear();
      this.telemetry.clear();
      this.crashedBranches.clear();
    }

    // Relaunch with new headless setting
    await this.launchBrowser();
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
            if (!document.body) { resolve(false); return; }
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
    await this.ensureHealthy();
    const speculativeBranchId = this.branchIdForUrl(url);
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
      this.coordinator.updateBranchStatus(this.activeBranch, url);
      this.lastKnownUrls.set(this.activeBranch, url);
      this.pushLiveFeed('navigate', `Cache hit → ${url}`);
      return;
    }

    const page = this.getActivePage();
    // Transient network failures (DNS blips, connection resets, slow first
    // byte) are retried with backoff instead of surfacing to the agent.
    await withRetry(
      () => page.goto(url, { waitUntil: 'domcontentloaded' }),
      {
        retries: 2,
        isRetryable: isTransientError,
        onRetry: (attempt, e) => {
          this.pushLiveFeed('navigate_retry', `Retry #${attempt} for ${url}: ${errorMessage(e).slice(0, 80)}`);
          console.error(`[Splice Reliability] navigate retry #${attempt} for ${url}: ${errorMessage(e)}`);
        },
      }
    );
    this.lastKnownUrls.set(this.activeBranch, url);

    // Adaptive Wait instead of just networkidle
    await this.waitForStability();
    
    // Auto-clean page
    await this.dismissCommonBanners();

    // Sync branch URL into the Canonical Context
    this.coordinator.updateBranchStatus(this.activeBranch, url);
    
    this.saveMicroSnapshot('navigate', { url });
  }

  async speculativeFork(urls: string[]) {
    await this.ensureHealthy();
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');
    const storageState = await context.storageState();

    for (const url of urls) {
      const branchId = this.branchIdForUrl(url);
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
    await this.ensureHealthy();
    const page = this.getActivePage();
    const telemetry = this.telemetry.get(this.activeBranch);
    const result = await SemanticExtractor.extract(page, intent, lens, maxTokens, telemetry?.getLogs() || []);
    const securityFlags = new Set<string>();
    const collectSecurityFlags = (node: SemanticNode) => {
      node.securityFlags?.forEach(flag => securityFlags.add(flag));
      node.children?.forEach(collectSecurityFlags);
    };
    collectSecurityFlags(result.tree);

    this.metrics.tokensSavedEstimate += result.tokensSaved;
    this.pushLiveFeed('semantic_tree', `lens=${lens}, intent=${intent || 'none'}, saved=${result.tokensSaved}t`);
    
    this.saveMicroSnapshot('semantic_tree', { 
      lens, 
      intent, 
      networkSummary: result.tree.networkSummary,
      securityFlags: Array.from(securityFlags),
      tokensSaved: result.tokensSaved 
    });
    
    return result.tree;
  }

  // -------------------------
  // AGENT STATE FORENSICS
  // -------------------------
  async diagnoseAgentState(goal?: string, lastActions: string[] = []): Promise<AgentStateDiagnosis> {
    await this.ensureHealthy();
    const page = this.getActivePage();
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});

    const telemetry = this.telemetry.get(this.activeBranch)?.getLogs() || [];
    const recentNetworkErrors = telemetry
      .filter(log => log.type === 'network' && log.data.event === 'response' && Number(log.data.status) >= 400)
      .slice(-10);

    const domSignals = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };

      const viewportArea = window.innerWidth * window.innerHeight;
      const interactiveSelector = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(',');

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], .modal, .popup'))
        .filter(isVisible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            areaRatio: viewportArea ? (rect.width * rect.height) / viewportArea : 0
          };
        });

      const overlays = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
        .filter(el => {
          if (!isVisible(el)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const zIndex = Number.parseInt(style.zIndex || '0', 10);
          const areaRatio = viewportArea ? (rect.width * rect.height) / viewportArea : 0;
          const fixedOrSticky = style.position === 'fixed' || style.position === 'sticky';
          return fixedOrSticky && areaRatio > 0.18 && (Number.isFinite(zIndex) ? zIndex >= 10 : true);
        })
        .slice(0, 5)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            id: el.getAttribute('data-splice-id') || el.id || el.getAttribute('aria-label') || el.tagName.toLowerCase(),
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            zIndex: window.getComputedStyle(el).zIndex,
            areaRatio: viewportArea ? (rect.width * rect.height) / viewportArea : 0
          };
        });

      const disabledControls = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(interactiveSelector))
        .filter(el => isVisible(el) && ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'));

      const invalidFields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
        .filter(el => isVisible(el) && !el.checkValidity());

      const actionableElements = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))
        .filter(el => isVisible(el) && !(el as HTMLButtonElement).disabled)
        .length;

      const captchaFrames = document.querySelectorAll('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="recaptcha"], iframe[src*="turnstile"]').length;
      const loadingIndicators = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .loading, .spinner, [data-loading="true"]')).filter(isVisible).length;
      const passwordFields = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(isVisible).length;
      const activeElement = document.activeElement instanceof HTMLElement
        ? {
            tagName: document.activeElement.tagName.toLowerCase(),
            id: document.activeElement.getAttribute('data-splice-id') || document.activeElement.id || undefined,
            text: (document.activeElement.innerText || document.activeElement.getAttribute('aria-label') || '').trim().slice(0, 80)
          }
        : null;

      return {
        title: document.title,
        url: location.href,
        dialogs,
        overlays,
        disabledControls: disabledControls.length,
        invalidFields: invalidFields.length,
        actionableElements,
        captchaFrames,
        loadingIndicators,
        passwordFields,
        activeElement,
        bodyText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600)
      };
    });

    const evidence: string[] = [];
    let state: AgentStateDiagnosis['state'] = 'ready';
    let confidence = 0.72;
    let recommendedNextAction: AgentStateDiagnosis['recommendedNextAction'] = {
      tool: 'compile_verified_action',
      reason: 'Page appears actionable; compile the next intent into a verified browser action.'
    };

    if (domSignals.captchaFrames > 0) {
      state = 'captcha';
      confidence = 0.95;
      evidence.push(`${domSignals.captchaFrames} CAPTCHA or anti-bot iframe(s) detected.`);
      recommendedNextAction = { tool: 'request_human_intervention', reason: 'CAPTCHA detected; agent should pause for human or configured solver.' };
    } else if (domSignals.loadingIndicators > 0) {
      state = 'navigation_pending';
      confidence = 0.78;
      evidence.push(`${domSignals.loadingIndicators} loading indicator(s) are visible.`);
      recommendedNextAction = { tool: 'diagnose_agent_state', reason: 'Wait briefly, then re-diagnose once the page settles.' };
    } else if (domSignals.dialogs.length > 0 || domSignals.overlays.length > 0) {
      state = 'ui_obstruction';
      confidence = 0.89;
      const obstruction = domSignals.dialogs[0] || domSignals.overlays[0];
      const obstructionLabel = 'id' in obstruction ? obstruction.id : obstruction.text;
      evidence.push(`Visible dialog or overlay may be intercepting actions: "${obstruction.text || obstructionLabel || 'unnamed obstruction'}".`);
      recommendedNextAction = { tool: 'compile_verified_action', target: 'close/dismiss control', reason: 'Dismiss the obstruction before continuing the workflow.' };
    } else if (domSignals.invalidFields > 0 || domSignals.disabledControls > 0) {
      state = 'validation_blocked';
      confidence = 0.82;
      evidence.push(`${domSignals.invalidFields} invalid field(s) and ${domSignals.disabledControls} disabled control(s) detected.`);
      recommendedNextAction = { tool: 'compile_verified_action', reason: 'Fill required inputs or satisfy validation before submitting.' };
    } else if (domSignals.passwordFields > 0 && /login|sign in|password|authenticate/i.test(domSignals.bodyText)) {
      state = 'auth_required';
      confidence = 0.8;
      evidence.push('Password field and authentication language are visible.');
      recommendedNextAction = { tool: 'load_snapshot', reason: 'Load an authenticated snapshot or request credentials through the host agent policy.' };
    } else if (recentNetworkErrors.length > 0) {
      state = 'network_failure';
      confidence = 0.74;
      evidence.push(`${recentNetworkErrors.length} recent HTTP error response(s), latest status ${recentNetworkErrors.at(-1)?.data.status}.`);
      recommendedNextAction = { tool: 'navigate', reason: 'Retry navigation or inspect the failing endpoint before continuing.' };
    }

    if (domSignals.actionableElements === 0) {
      state = state === 'ready' ? 'stale_or_missing_target' : state;
      confidence = Math.max(confidence, 0.76);
      evidence.push('No visible actionable elements are currently available.');
    }

    if (goal) evidence.push(`Current agent goal: ${goal}`);
    if (lastActions.length > 0) evidence.push(`Recent actions: ${lastActions.slice(-4).join(' -> ')}`);
    if (domSignals.activeElement?.id) evidence.push(`Focused element: ${domSignals.activeElement.id}`);
    if (evidence.length === 0) evidence.push(`${domSignals.actionableElements} visible actionable element(s) detected.`);

    const summaryByState: Record<AgentStateDiagnosis['state'], string> = {
      ready: 'The page appears ready for a verified intent action.',
      ui_obstruction: 'The agent is likely blocked by a visible overlay, modal, or pointer obstruction.',
      captcha: 'The workflow is blocked by CAPTCHA or anti-bot verification.',
      validation_blocked: 'The page likely requires missing or corrected form input before continuing.',
      auth_required: 'The workflow appears to require authentication.',
      navigation_pending: 'The page is still transitioning or loading.',
      network_failure: 'Recent network failures may be preventing the expected state.',
      stale_or_missing_target: 'The expected target is missing or the page has no visible actionable controls.',
      ambiguous_target: 'Multiple targets appear plausible and need disambiguation.',
      unknown: 'Splice could not confidently classify the current browser state.'
    };

    const diagnosis: AgentStateDiagnosis = {
      state,
      confidence,
      summary: summaryByState[state],
      evidence,
      recommendedNextAction,
      page: {
        url: domSignals.url,
        title: domSignals.title,
        activeBranch: this.activeBranch
      },
      signals: {
        dialogs: domSignals.dialogs.length,
        obstructiveOverlays: domSignals.overlays.length,
        disabledControls: domSignals.disabledControls,
        invalidFields: domSignals.invalidFields,
        captchaFrames: domSignals.captchaFrames,
        loadingIndicators: domSignals.loadingIndicators,
        recentNetworkErrors: recentNetworkErrors.length,
        actionableElements: domSignals.actionableElements
      }
    };

    diagnosis.trend = this.computeDiagnosisTrend(state, domSignals.url);
    if (diagnosis.trend.likelyStuck) {
      diagnosis.evidence.push(
        `Stuck signal: "${state}" has been diagnosed ${diagnosis.trend.repeatedStateCount} times in a row on this URL — repeating the same approach is unlikely to work.`
      );
    }

    this.saveMicroSnapshot('agent_state_diagnosis', {
      state: diagnosis.state,
      confidence: diagnosis.confidence,
      summary: diagnosis.summary,
      signals: diagnosis.signals,
      likelyStuck: diagnosis.trend?.likelyStuck ?? false
    });
    return diagnosis;
  }

  /**
   * Predictive trend layer: compares this diagnosis against recent history
   * to detect wedged workflows before the agent burns more steps on them.
   */
  private computeDiagnosisTrend(state: AgentStateDiagnosis['state'], url: string): NonNullable<AgentStateDiagnosis['trend']> {
    const previous = this.diagnosisHistory[this.diagnosisHistory.length - 1];
    this.diagnosisHistory.push({ state, url, timestamp: Date.now() });
    if (this.diagnosisHistory.length > 20) this.diagnosisHistory.shift();

    let repeatedStateCount = 0;
    for (let i = this.diagnosisHistory.length - 1; i >= 0; i--) {
      const entry = this.diagnosisHistory[i];
      if (entry.state !== state || entry.url !== url) break;
      repeatedStateCount++;
    }

    const likelyStuck = state !== 'ready' && repeatedStateCount >= 3;

    const predictionByState: Record<string, string> = {
      ready: 'The next verified action should execute cleanly.',
      navigation_pending: repeatedStateCount >= 2
        ? 'The page has stayed in a loading state across diagnoses — suspect a hung request; check telemetry or re-navigate.'
        : 'The page is likely to settle shortly; re-diagnose before acting.',
      ui_obstruction: likelyStuck
        ? 'The overlay is not going away on its own — target its dismiss control explicitly or fork a branch to test alternatives.'
        : 'Dismissing the obstruction should return the page to a ready state.',
      validation_blocked: likelyStuck
        ? 'The same validation failure keeps recurring — the field requirements likely differ from what the agent assumes; inspect the invalid fields directly.'
        : 'Satisfying the highlighted validation should unblock submission.',
      auth_required: 'Without loading an authenticated snapshot or credentials, further actions on this page will keep failing.',
      captcha: 'No automated action will progress past the CAPTCHA; human intervention is required.',
      network_failure: 'If the endpoint keeps failing, retries will not help — inspect the failing request before continuing.',
      stale_or_missing_target: 'Re-extracting the semantic tree should surface fresh element IDs.',
      ambiguous_target: 'Adding requireExactText or a more specific intent should disambiguate the target.',
      unknown: 'Gather more evidence (semantic tree, screenshot) before acting.'
    };

    return {
      repeatedStateCount,
      previousState: previous?.state,
      likelyStuck,
      prediction: predictionByState[state] ?? predictionByState.unknown
    };
  }

  async compileVerifiedAction(input: {
    intent: string;
    value?: string;
    constraints?: {
      noNavigationOutsideDomain?: boolean;
      avoidDestructiveActions?: boolean;
      requireExactText?: boolean;
    };
    execute?: boolean;
    includeVision?: boolean;
  }): Promise<VerifiedActionPlan> {
    const { intent, value, constraints = {}, execute = false, includeVision = false } = input;
    if (!intent || intent.trim().length === 0) throw new Error('Intent is required.');

    await this.ensureHealthy();
    await this.getSemanticTree(intent, 'UX', 1200);
    const diagnosis = await this.diagnoseAgentState(intent);
    // Resolve the page only after health checks, which may rebuild the branch.
    const page = this.getActivePage();
    const keywords = this.tokenizeIntent(intent);
    const inferredAction = this.inferActionFromIntent(intent, value);
    const currentUrl = page.url();
    const currentHost = (() => {
      try { return new URL(currentUrl).host; } catch { return ''; }
    })();

    const candidates = await page.evaluate((args: { keywords: string[]; query: string; currentHost: string; noExternal: boolean; requireExactText: boolean }) => {
      const selector = [
        'a[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(',');

      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.05 &&
          rect.width > 0 &&
          rect.height > 0;
      };

      return Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter(isVisible)
        .map(el => {
          const id = el.getAttribute('data-splice-id') || '';
          const rect = el.getBoundingClientRect();
          const tagName = el.tagName.toLowerCase();
          const href = el instanceof HTMLAnchorElement ? el.href : '';
          const label = [
            el.innerText,
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name'),
            el.getAttribute('title'),
            href
          ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          const normalized = label.toLowerCase();
          let score = 0;
          if (args.query && normalized === args.query) score += 42;
          else if (args.query && normalized.includes(args.query)) score += 30;
          for (const keyword of args.keywords) {
            if (normalized === keyword) score += 24;
            else if (normalized.includes(keyword)) score += 10;
          }
          if (args.requireExactText && args.keywords.length > 0 && !args.keywords.some(keyword => normalized.includes(keyword))) {
            score -= 30;
          }
          if (tagName === 'button' || el.getAttribute('role') === 'button') score += 3;
          if (tagName === 'a' && /pricing|docs|login|sign|dashboard|settings|account/.test(normalized)) score += 2;
          if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') score -= 25;

          let external = false;
          if (href && args.noExternal) {
            try { external = new URL(href).host !== args.currentHost; } catch { external = false; }
            if (external) score -= 40;
          }

          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const topElement = document.elementFromPoint(centerX, centerY);
          const obstructed = !!topElement && topElement !== el && !el.contains(topElement);
          if (obstructed) score -= 12;

          return {
            id,
            tagName,
            label: label.slice(0, 180),
            href,
            score,
            disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
            obstructed,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            external
          };
        })
        .filter(candidate => candidate.id)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    }, {
      keywords,
      query: keywords.join(' '),
      currentHost,
      noExternal: constraints.noNavigationOutsideDomain === true,
      requireExactText: constraints.requireExactText === true
    });

    const destructiveIntent = /\b(delete|remove|destroy|cancel subscription|purchase|buy|pay|submit payment|transfer|wire)\b/i.test(intent);
    const best = candidates[0];
    const evidence: string[] = [
      `Intent tokens: ${keywords.join(', ') || 'none'}`,
      `State forensics: ${diagnosis.state} (${Math.round(diagnosis.confidence * 100)}% confidence)`
    ];

    if (!best || best.score <= 0) {
      const plan: VerifiedActionPlan = {
        intent,
        confidence: 0.18,
        risk: 'high',
        plan: [],
        preconditions: ['A visible actionable element must match the intent.'],
        postconditions: ['No action executed.'],
        evidence: [...evidence, 'No candidate target scored above zero.'],
        alternatives: candidates.map(candidate => ({
          target: candidate.id,
          score: candidate.score,
          label: candidate.label,
          reason: candidate.disabled ? 'Candidate is disabled.' : candidate.obstructed ? 'Candidate appears visually obstructed.' : 'Low semantic match.'
        }))
      };
      this.saveMicroSnapshot('verified_action_plan', { intent, confidence: plan.confidence, risk: plan.risk, executable: false });
      return plan;
    }

    const topScore = Math.max(1, best.score);
    const secondScore = candidates[1]?.score ?? 0;
    const ambiguous = secondScore > 0 && secondScore / topScore > 0.82;
    const blockedByPolicy = constraints.avoidDestructiveActions === true && destructiveIntent;
    const baseConfidence = best.score >= 10 ? Math.max(best.score / 35, 0.62) : best.score / 35;
    const confidence = Math.max(0.2, Math.min(0.96, baseConfidence - (ambiguous ? 0.16 : 0) - (best.obstructed ? 0.2 : 0) - (blockedByPolicy ? 0.35 : 0)));
    const risk: VerifiedActionPlan['risk'] = blockedByPolicy || best.external || destructiveIntent ? 'high' : ambiguous || best.obstructed || diagnosis.state !== 'ready' ? 'medium' : 'low';
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => '');

    const plan: VerifiedActionPlan = {
      intent,
      confidence,
      risk,
      plan: blockedByPolicy ? [] : [{
        action: inferredAction,
        target: best.id,
        value,
        why: `Best semantic and visual match: "${best.label || best.tagName}" scored ${best.score}.`
      }],
      preconditions: [
        `Target ${best.id} is visible.`,
        best.disabled ? `Target ${best.id} must be enabled before action.` : `Target ${best.id} is enabled.`,
        best.obstructed ? `Target ${best.id} must not be covered by another element.` : `Target ${best.id} is not visually obstructed at its center point.`,
        constraints.noNavigationOutsideDomain ? `Navigation must stay on ${currentHost}.` : 'No domain constraint requested.',
        constraints.avoidDestructiveActions ? 'Destructive actions require an explicit policy override.' : 'No destructive-action policy requested.'
      ],
      postconditions: [
        inferredAction === 'click' ? 'URL, title, focused element, or visible page text should change in a way consistent with the intent.' : 'Target value or focus state should reflect the requested action.',
        `A follow-up diagnosis should not report captcha, obstruction, or validation_blocked unless the site introduced a new guard.`
      ],
      evidence: blockedByPolicy ? [...evidence, 'Intent appears destructive and policy forbids execution.'] : evidence,
      alternatives: candidates.slice(1).map(candidate => ({
        target: candidate.id,
        score: candidate.score,
        label: candidate.label,
        reason: candidate.disabled ? 'Disabled alternate.' : candidate.obstructed ? 'Obstructed alternate.' : 'Lower semantic score.'
      }))
    };

    plan.expectedOutcome = blockedByPolicy
      ? 'No action will execute: the intent matched a destructive pattern and avoidDestructiveActions is set.'
      : inferredAction === 'click'
        ? `Clicking "${best.label || best.id}" should ${best.href ? `navigate toward ${best.href}` : 'trigger an in-page state change'} and a follow-up diagnosis should report ready.`
        : inferredAction === 'type'
          ? `"${best.label || best.id}" should contain the provided value and any dependent validation or submit controls should unlock.`
          : `The ${inferredAction} action should update the state of "${best.label || best.id}" without navigating away.`;

    // Hybrid vision: attach a pixel crop of the chosen target so a vision
    // model (or a human) can confirm the DOM pick matches what is on screen.
    if (includeVision && best.id) {
      try {
        plan.targetPreview = await this.captureNodeScreenshot(best.id);
      } catch (e) {
        plan.evidence.push(`Vision preview unavailable: ${errorMessage(e)}`);
      }
    }

    if (execute && plan.plan.length > 0 && confidence >= 0.45 && !best.disabled && !best.obstructed) {
      const step = plan.plan[0];
      await this.interact(step.target, step.action, step.value);
      const afterUrl = page.url();
      const afterTitle = await page.title().catch(() => '');
      const afterDiagnosis = await this.diagnoseAgentState(intent);
      const afterText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      const changed = beforeUrl !== afterUrl || beforeTitle !== afterTitle;
      const intentVisible = keywords.some(keyword => afterText.toLowerCase().includes(keyword));
      const obstructionResolved = diagnosis.state === 'ui_obstruction' && afterDiagnosis.state !== 'ui_obstruction';
      const validationProgress = diagnosis.state === 'validation_blocked' &&
        afterDiagnosis.signals.invalidFields <= diagnosis.signals.invalidFields &&
        afterDiagnosis.signals.disabledControls <= diagnosis.signals.disabledControls;
      const domainStillAllowed = !constraints.noNavigationOutsideDomain || (() => {
        try { return new URL(afterUrl).host === currentHost; } catch { return true; }
      })();
      const passed = domainStillAllowed && (changed || intentVisible || obstructionResolved || validationProgress || afterDiagnosis.state === 'ready');

      plan.verification = {
        executed: true,
        passed,
        evidence: [
          changed ? `Page changed from "${beforeTitle || beforeUrl}" to "${afterTitle || afterUrl}".` : 'No URL or title change observed.',
          intentVisible ? 'Post-action page text still contains intent terms.' : 'Intent terms were not found in the post-action body text.',
          obstructionResolved ? 'The previous UI obstruction is no longer present.' : 'No obstruction-resolution signal observed.',
          validationProgress ? 'Validation-blocking signals did not increase after the action.' : 'No validation-progress signal observed.',
          `Post-action diagnosis: ${afterDiagnosis.state}.`,
          domainStillAllowed ? 'Domain constraint passed.' : 'Domain constraint failed.'
        ]
      };
    } else {
      plan.verification = {
        executed: false,
        passed: false,
        evidence: [
          execute ? 'Execution skipped because confidence/preconditions were insufficient.' : 'Execution was not requested.',
          `Top candidate: ${best.id} (${best.label || best.tagName}).`
        ]
      };
    }

    this.saveMicroSnapshot('verified_action_plan', {
      intent,
      target: best.id,
      confidence: plan.confidence,
      risk: plan.risk,
      executed: plan.verification?.executed,
      passed: plan.verification?.passed
    });
    return plan;
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
    // ── Ownership check — keeps errors local, eliminates conflicting writes ──
    this.coordinator.verifyOwnership(this.activeBranch, agentId);

    await this.ensureHealthy();
    const page = this.getActivePage();

    // CAPTCHA detection — always route to human intervention rather than
    // pretending an automated solver handled it.
    const captchaFrames = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="recaptcha"]');
    if (await captchaFrames.count() > 0) {
      this.metrics.captchaInterruptions++;
      throw new Error('CAPTCHA_REQUIRED: Human intervention requested via request_human_intervention.');
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
    this.lastKnownUrls.set(this.activeBranch, page.url());
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
    await this.ensureHealthy();
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
    const safeName = this.sanitizeFileName(name);
    const statePath = path.join(this.snapshotsDir, `${safeName}.splice`);
    this.vault.writeEncrypted(statePath, JSON.stringify(state));
    this.pushLiveFeed('save_snapshot', `Encrypted vault: ${safeName}`);
    return statePath;
  }

  async loadSnapshot(name: string) {
    // Support both new encrypted (.splice) and legacy (.json) formats
    const safeName = this.sanitizeFileName(name);
    const encPath = path.join(this.snapshotsDir, `${safeName}.splice`);
    const legacyPath = path.join(this.snapshotsDir, `${safeName}.json`);
    const statePath = fs.existsSync(encPath) ? encPath : legacyPath;

    if (!fs.existsSync(statePath)) throw new Error(`Snapshot "${safeName}" not found.`);

    const state = JSON.parse(this.vault.readDecrypted(statePath));

    // Detach the maps before closing so the close event is not mistaken
    // for a crash by the reliability layer.
    const oldContext = this.contexts.get('main');
    this.contexts.delete('main');
    this.pages.delete('main');
    this.telemetry.delete('main');
    if (oldContext) await oldContext.close();

    await this.createBranch('main', state);
    this.activeBranch = 'main';
    this.pushLiveFeed('load_snapshot', `Restored from vault: ${safeName}`);
  }

  // -------------------------
  // BRANCH MANAGEMENT
  // -------------------------
  async forkState(agentId?: string): Promise<string> {
    await this.ensureHealthy();
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    const branchId = `branch-${Date.now()}`;
    const storageState = await context.storageState();
    const currentUrl = this.getActivePage().url();

    await this.createBranch(branchId, storageState);
    const newPage = this.pages.get(branchId)!;
    await newPage.goto(currentUrl, { waitUntil: 'networkidle' });

    // Register branch ownership immediately so it's never an orphan
    if (agentId) {
      this.coordinator.acquireOwnership(branchId, agentId);
    }
    this.coordinator.updateBranchStatus(branchId, currentUrl);
    this.lastKnownUrls.set(branchId, currentUrl);

    this.pushLiveFeed('fork_state', `Created branch: ${branchId}${agentId ? ` (owner: ${agentId})` : ''}`);
    return branchId;
  }

  async commitBranch(branchId: string) {
    if (!this.contexts.has(branchId)) throw new Error(`Branch ${branchId} does not exist`);
    this.activeBranch = branchId;
    this.pushLiveFeed('commit_branch', `Active: ${branchId}`);
  }

  /**
   * Atomically transfer write ownership of a branch from one agent to another.
   * The from-agent must currently own the branch. Records the transfer in the ledger.
   */
  handoffBranch(branchId: string, fromAgentId: string, toAgentId: string): void {
    if (!this.contexts.has(branchId)) throw new Error(`Branch ${branchId} does not exist`);
    this.coordinator.handoffBranch(branchId, fromAgentId, toAgentId);
    this.pushLiveFeed('handoff_branch', `${branchId}: ${fromAgentId} → ${toAgentId}`);
  }

  /**
   * Promote a locally-produced finding to the Immutable Evidence Ledger.
   * Requires the agent to own the source branch. Triggers conflict detection.
   */
  promoteFinding(
    key: string,
    value: unknown,
    confidence: number,
    branchId: string,
    agentId: string
  ): LedgerEntry {
    const ccs = this.coordinator.buildCanonicalContext();
    const entry = this.coordinator.promoteFinding(key, value, confidence, branchId, agentId, ccs.snapshotId);
    this.pushLiveFeed('promote_finding', `key=${key}, agent=${agentId}, conf=${confidence}`);
    return entry;
  }

  requestSummon(url: string, reason?: string, domContext?: string): SummonRequest {
    const req = this.coordinator.addSummonRequest(url, reason, domContext);
    this.pushLiveFeed('summon_requested', `id=${req.id}, url=${url}`);
    return req;
  }

  acknowledgeSummon(summonId: string, agentId: string): SummonRequest | null {
    const req = this.coordinator.acknowledgeSummon(summonId, agentId);
    if (req) {
      this.pushLiveFeed('summon_acknowledged', `id=${summonId}, agent=${agentId}`);
    }
    return req;
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

    // Send automated Discord notification
    if (discordNotifier.isActive()) {
      await discordNotifier.sendEmbed({
        title: "⚠️ Human Intervention Required",
        description: `An agent is currently stuck and requires manual assistance.\n\n**Reason:** ${reason}\n**Active URL:** ${currentUrl}`,
        color: 0xf1c40f,
        footerText: `Splice Enterprise Hub • ${new Date().toLocaleTimeString()}`
      });
    }

    const visibleBrowser = await chromium.launch({ headless: false });
    const visibleContext = await visibleBrowser.newContext({ storageState: state });
    const visiblePage = await visibleContext.newPage();
    await visiblePage.goto(currentUrl);

    await visiblePage.waitForEvent('close', { timeout: 0 });

    const solvedState = await visibleContext.storageState();
    await visibleBrowser.close();
    fs.unlinkSync(statePath);

    // Detach and close the stale context before rebuilding the branch so
    // the reliability layer does not classify the swap as a crash.
    const staleContext = this.contexts.get(this.activeBranch);
    this.contexts.delete(this.activeBranch);
    this.pages.delete(this.activeBranch);
    this.telemetry.delete(this.activeBranch);
    if (staleContext) await staleContext.close().catch(() => {});

    await this.createBranch(this.activeBranch, solvedState);
    const newPage = this.getActivePage();
    await newPage.goto(currentUrl);
    this.lastKnownUrls.set(this.activeBranch, currentUrl);

    console.error(`--- INTERVENTION COMPLETE. AGENT RESUMING ---`);
    this.pushLiveFeed('human_intervention', `Resolved: ${reason}`);

    // Send automated Discord resolution notification
    if (discordNotifier.isActive()) {
      await discordNotifier.sendEmbed({
        title: "✅ Human Intervention Resolved",
        description: `Manual intervention was resolved. Agent is resuming navigation/actions.\n\n**Reason:** ${reason}`,
        color: 0x2ecc71,
        footerText: `Splice Enterprise Hub • ${new Date().toLocaleTimeString()}`
      });
    }
  }

  // -------------------------
  // DEBUGGING
  // -------------------------
  async debugFailure(sessionId: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');

    const safeSessionId = this.sanitizeFileName(sessionId);
    const tracePath = path.join(this.snapshotsDir, `trace-${safeSessionId}.zip`);
    await context.tracing.stop({ path: tracePath });
    await context.tracing.start({ screenshots: true, snapshots: true });

    this.pushLiveFeed('debug_failure', `Trace saved: trace-${safeSessionId}.zip`);
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

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    let templatePath = path.join(__dirname, '..', 'dashboard', 'index.html');
    if (!fs.existsSync(templatePath)) {
      // Fallback for test mode (dist_test/src/BrowserManager.js -> dist_test/dashboard -> Splice/dashboard)
      templatePath = path.join(__dirname, '..', '..', 'dashboard', 'index.html');
    }
    if (!fs.existsSync(templatePath)) {
      // Fallback for current working directory
      templatePath = path.join(process.cwd(), 'dashboard', 'index.html');
    }
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Observability template not found. Searched paths include: ${path.join(__dirname, '..', 'dashboard', 'index.html')}, ${path.join(__dirname, '..', '..', 'dashboard', 'index.html')}, and process.cwd(). Ensure you are running Splice from the project root.`);
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

    // Escape "<" so page-derived strings can never close the script tag or
    // inject markup into the locally rendered dashboard.
    const toJs = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

    const dataInjection = `
        const microSnapshots = ${toJs(snaps)};
        const metrics = ${toJs(this.metrics)};
        const liveFeed = ${toJs(this.getLiveFeed())};
        const audit = ${toJs(latestAudit ?? null)};
        const ccs = ${toJs(this.coordinator.buildCanonicalContext())};
        const taxMetrics = ${toJs(this.coordinator.getCoordinationTaxMetrics())};
        const summonsList = ${toJs(this.coordinator.getSummons())};
        const runtimeHealth = ${toJs(this.getRuntimeHealth())};
        const agentProfiles = ${toJs(this.agentTracker.getAllProfiles())};

        const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[ch]));
        const empty = (text) => \`<div class="empty">\${esc(text)}</div>\`;
        const tagClass = (value) => {
          const normalized = String(value || '').toLowerCase();
          if (normalized.includes('critical') || normalized.includes('high') || normalized.includes('captcha') || normalized.includes('obstruction')) return 'red';
          if (normalized.includes('warning') || normalized.includes('medium') || normalized.includes('validation') || normalized.includes('pending')) return 'amber';
          if (normalized.includes('info') || normalized.includes('network')) return 'blue';
          return 'green';
        };

        document.getElementById('stat-prevented').textContent = metrics.preventedErrors ?? 0;
        document.getElementById('stat-heals').textContent = metrics.selfHealCount ?? 0;
        document.getElementById('stat-vulns').textContent = audit ? audit.totals.critical + audit.totals.warning : 0;
        document.getElementById('active-branch').textContent = liveFeed.activeBranch || 'main';
        document.getElementById('watch-mode').textContent = liveFeed.watchMode ? 'On' : 'Off';
        document.getElementById('branch-count').textContent = liveFeed.branches.length;

        const gradeEl = document.getElementById('sec-grade');
        let grade = 'A';
        if (audit) {
          if (audit.totals.critical > 0) grade = 'F';
          else if (audit.totals.warning > 3) grade = 'C';
          else if (audit.totals.warning > 0) grade = 'B';
        }
        gradeEl.textContent = audit ? grade : '-';
        gradeEl.style.color = grade === 'F' ? 'var(--red)' : (grade === 'A' ? 'var(--green)' : 'var(--amber)');

        const timeline = document.getElementById('timeline');
        if (timeline) {
          timeline.innerHTML = microSnapshots.length
            ? microSnapshots.map((s, i) => {
              const alert = ['security', 'audit', 'diagnosis'].some(token => String(s.type).includes(token));
              const title = s.summary || s.intent || s.url || s.elementId || s.action || s.state || 'Session event';
              return \`
                <div class="timeline-item \${i === 0 ? 'active' : ''} \${alert ? 'alert' : ''}">
                  <div class="mono">\${esc(String(s.type || 'event').toUpperCase())}</div>
                  <div class="item-title">\${esc(title)}</div>
                  <div class="item-meta">\${new Date(s.timestamp).toLocaleTimeString()}</div>
                </div>
              \`;
            }).join('')
            : empty('No session events yet.');
        }

        const forensicsFeed = document.getElementById('forensics-feed');
        const diagnoses = microSnapshots.filter(s => s.type === 'agent_state_diagnosis').slice(0, 4);
        if (forensicsFeed) {
          forensicsFeed.innerHTML = diagnoses.length
            ? diagnoses.map(d => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(d.summary || d.state)}</div>
                  <div class="tag \${tagClass(d.state)}">\${esc(d.state || 'ready')}</div>
                </div>
                <div class="card-body">
                  Confidence: \${Math.round((d.confidence || 0) * 100)}%. 
                  Signals: \${Object.entries(d.signals || {}).map(([k, v]) => \`\${k}=\${v}\`).join(', ') || 'none'}.
                </div>
              </div>
            \`).join('')
            : empty('Run diagnose_agent_state to classify the current workflow state.');
        }

        const verifiedFeed = document.getElementById('verified-action-feed');
        const verifiedPlans = microSnapshots.filter(s => s.type === 'verified_action_plan').slice(0, 4);
        if (verifiedFeed) {
          verifiedFeed.innerHTML = verifiedPlans.length
            ? verifiedPlans.map(p => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(p.intent || 'Verified action')}</div>
                  <div class="tag \${tagClass(p.risk)}">\${esc(p.risk || 'low')}</div>
                </div>
                <div class="card-body">
                  Target: \${esc(p.target || 'none')}. Confidence: \${Math.round((p.confidence || 0) * 100)}%. 
                  Execution: \${p.executed ? (p.passed ? 'passed' : 'review') : 'planned'}.
                </div>
              </div>
            \`).join('')
            : empty('Run compile_verified_action to generate preconditions and postconditions.');
        }

        const specGrid = document.getElementById('spec-grid');
        if (specGrid) {
          specGrid.innerHTML = liveFeed.branches.length
            ? liveFeed.branches.map(b => \`
              <div class="branch-node \${b === liveFeed.activeBranch ? 'active' : ''}">
                <div class="branch-label">\${b === liveFeed.activeBranch ? 'Active' : 'Ready'}</div>
                <div class="branch-id">\${esc(b)}</div>
              </div>
            \`).join('')
            : empty('No browser branches are active.');
        }

        const netMap = document.getElementById('network-map');
        const lastTree = microSnapshots.find(s => s.type === 'semantic_tree' && s.networkSummary);
        if (netMap) {
          netMap.innerHTML = lastTree?.networkSummary?.endpoints?.length
            ? lastTree.networkSummary.endpoints.map(ep => \`
              <div class="endpoint-row">
                <div class="mono">GET</div>
                <div class="endpoint-path">\${esc(ep)}</div>
                <div class="item-meta">mapped</div>
              </div>
            \`).join('')
            : empty('Use the Network lens to map XHR and fetch endpoints.');
        }

        const agentSecFeed = document.getElementById('agent-security-feed');
        if (agentSecFeed) {
          const events = [];
          liveFeed.feed.forEach(item => {
            if (item.type === 'security_firewall') events.push({ title: 'Exfiltration blocked', detail: item.detail, severity: 'critical' });
          });
          microSnapshots.forEach(s => {
            if (s.type === 'semantic_tree' && s.securityFlags?.includes?.('prompt-injection-detected')) {
              events.push({ title: 'Prompt injection redacted', detail: 'Hidden instruction pattern was detected in page content.', severity: 'critical' });
            }
          });
          agentSecFeed.innerHTML = events.length
            ? events.map(e => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(e.title)}</div>
                  <div class="tag red">\${esc(e.severity)}</div>
                </div>
                <div class="card-body">\${esc(e.detail)}</div>
              </div>
            \`).join('')
            : empty('Firewall active. No prompt-injection or exfiltration events in the current window.');
        }

        const auditFeed = document.getElementById('audit-feed');
        if (auditFeed) {
          const findings = audit ? audit.findings.filter(f => f.severity !== 'PASS').slice(0, 5) : [];
          auditFeed.innerHTML = findings.length
            ? findings.map(f => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(f.title)}</div>
                  <div class="tag \${tagClass(f.severity)}">\${esc(f.severity)}</div>
                </div>
                <div class="card-body">\${esc(f.detail)}<br><br>Remediation: \${esc(f.remediation)}</div>
              </div>
            \`).join('')
            : empty('Run run_security_audit to populate launch-readiness findings.');
        }

        const consoleEl = document.getElementById('vision-feed');
        if (consoleEl) {
          consoleEl.innerHTML = liveFeed.consoleLogs.length
            ? liveFeed.consoleLogs.map(log => \`
              <div class="log-line">
                <div class="mono">\${esc(log.data.type || 'log')}</div>
                <div class="log-msg">\${esc(log.data.text || '')}</div>
                <div class="item-meta">\${new Date(log.timestamp).toLocaleTimeString()}</div>
              </div>
            \`).join('')
            : empty('Console telemetry will appear here once pages emit logs.');
        }

        // \u2500\u2500\u2500 Runtime Reliability Panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const relBrowser = document.getElementById('rel-browser');
        if (relBrowser) {
          relBrowser.textContent = runtimeHealth.browserConnected ? 'Connected' : 'Recovering';
          relBrowser.className = 'tax-value ' + (runtimeHealth.browserConnected ? 'ok' : 'bad');
        }
        const relUptime = document.getElementById('rel-uptime');
        if (relUptime) {
          const mins = Math.floor(runtimeHealth.uptimeMs / 60000);
          relUptime.textContent = mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm';
        }
        const setRel = (id, val, badWhenNonzero) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.textContent = val;
          el.className = 'tax-value ' + (badWhenNonzero && val > 0 ? 'nonzero' : 'zero');
        };
        setRel('rel-crashes', runtimeHealth.browserCrashCount, true);
        setRel('rel-recoveries', (runtimeHealth.journal && runtimeHealth.journal.recoveries) || 0, false);
        setRel('rel-journal', (runtimeHealth.journal && runtimeHealth.journal.toolCalls) || 0, false);
        setRel('rel-errors', (runtimeHealth.journal && runtimeHealth.journal.errors) || 0, true);

        // \u2500\u2500\u2500 Agent Performance Panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const agentPerfFeed = document.getElementById('agent-perf-feed');
        if (agentPerfFeed) {
          agentPerfFeed.innerHTML = agentProfiles.length
            ? agentProfiles.map(p => {
                const rate = Math.round(p.successRate * 100);
                const recent = Math.round(p.recentSuccessRate * 100);
                const fillClass = rate < 50 ? 'verylow' : rate < 75 ? 'low' : '';
                const statusTag = p.status === 'optimal' ? 'green' : p.status === 'degraded' ? 'amber' : 'red';
                const top = p.optimizations && p.optimizations[0];
                return \`
                  <div class="agent-perf-card \${esc(p.status)}">
                    <div class="agent-perf-head">
                      <span class="agent-badge">\${esc(p.agentId)}</span>
                      <span class="tag \${statusTag}">\${esc(p.status)}</span>
                    </div>
                    <div class="agent-perf-stats">
                      <span>success <b>\${rate}%</b></span>
                      <span>recent <b>\${recent}%</b></span>
                      <span>actions <b>\${p.totalActions}</b></span>
                      <span>avg <b>\${p.avgDurationMs}ms</b></span>
                      \${p.consecutiveFailures > 0 ? \`<span>streak <b style="color:var(--red)">\${p.consecutiveFailures}\u2715</b></span>\` : ''}
                    </div>
                    <div class="conf-bar"><div class="conf-fill \${fillClass}" style="width:\${rate}%"></div></div>
                    \${top ? \`<div class="agent-directive">\${esc(top.directive)}</div>\` : ''}
                  </div>
                \`;
              }).join('')
            : empty('No agent activity tracked yet. Pass agentId on tool calls to enable live tracking and in-action optimization.');
        }

        // \u2500\u2500\u2500 Coordination Health Panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
        const statAgents = document.getElementById('stat-agents');
        if (statAgents) statAgents.textContent = ccs.registeredAgents.length;

        // Pill state
        const coordPill = document.getElementById('coord-state-pill');
        if (coordPill) {
          const stateLabel = { healthy: 'Healthy', degraded: 'Degraded', quorum_blocked: 'Quorum Blocked' }[ccs.systemState] || ccs.systemState;
          coordPill.textContent = stateLabel;
          coordPill.style.color = ccs.systemState === 'healthy' ? 'var(--green)' : ccs.systemState === 'quorum_blocked' ? 'var(--red)' : 'var(--amber)';
        }

        // Tax Meter — highlight non-zero values in amber
        const updateTax = (id, val) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.textContent = val;
          el.className = 'tax-value ' + (val > 0 ? 'nonzero' : 'zero');
        };
        updateTax('tax-conflicts', taxMetrics.conflictsDetected);
        updateTax('tax-resolved', taxMetrics.conflictsResolved);
        updateTax('tax-blocked', taxMetrics.blockedActions);
        updateTax('tax-violations', taxMetrics.ownershipViolationAttempts);
        updateTax('tax-forced', taxMetrics.forcedReleases);

        // Agent Registry
        const agentRegistry = document.getElementById('agent-registry');
        if (agentRegistry) {
          agentRegistry.innerHTML = ccs.registeredAgents.length
            ? ccs.registeredAgents.map(a => \`
              <div class="branch-node" style="display:flex;align-items:center;gap:10px;min-height:auto;padding:10px 13px;">
                <span class="agent-badge \${esc(a.role)}">\${esc(a.agentId)}</span>
                <span class="tag purple">\${esc(a.role)}</span>
              </div>
            \`).join('')
            : empty('No agents registered. Call register_agent to begin multi-agent collaboration.');
        }

        // Evidence Ledger
        const ledgerFeed = document.getElementById('ledger-feed');
        const conflictedKeys = new Set(${toJs(this.coordinator.getConflictedKeys())});
        if (ledgerFeed) {
          const ledgerEntries = ccs.promotedFindings.slice(0, 6);
          ledgerFeed.innerHTML = ledgerEntries.length
            ? ledgerEntries.map(e => {
                const conf = Math.round(e.confidence * 100);
                const fillClass = conf < 50 ? 'verylow' : conf < 70 ? 'low' : '';
                const isConflict = conflictedKeys.has ? conflictedKeys.has(e.key) : false;
                return \`
                  <div class="ledger-entry \${isConflict ? 'conflict' : ''}">
                    <div class="ledger-key">\${esc(e.key)}</div>
                    <div class="ledger-meta">
                      <span>agent: \${esc(e.agentId)}</span>
                      <span>conf: \${conf}%</span>
                      <span>branch: \${esc(e.branchId)}</span>
                    </div>
                    <div class="conf-bar"><div class="conf-fill \${fillClass}" style="width:\${conf}%"></div></div>
                    \${isConflict ? '<div style="font-size:11px;color:var(--amber);margin-top:4px;">⚠ Conflict — call resolve_conflict</div>' : ''}
                  </div>
                \`;
              }).join('')
            : empty('No promoted findings yet. Agents can call promote_finding to share evidence.');
        }

        // Quorum Status
        const quorumFeed = document.getElementById('quorum-feed');
        if (quorumFeed) {
          quorumFeed.innerHTML = ccs.blockedKeys.length
            ? ccs.blockedKeys.map(k => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title" style="font-family:var(--mono,'JetBrains Mono'),monospace;font-size:13px">\${esc(k)}</div>
                  <div class="tag red">Blocked</div>
                </div>
                <div class="card-body">Conflicting entries detected. Call <code>resolve_conflict</code> with this key to unblock dependent actions.</div>
              </div>
            \`).join('')
            : \`<div class="empty" style="color:var(--green);border-color:rgba(65,230,162,0.2)">✓ All keys in consensus. No quorum failures.</div>\`;
        }

        // Summons
        const summonsFeed = document.getElementById('summons-feed');
        if (summonsFeed) {
          summonsFeed.innerHTML = summonsList.length
            ? summonsList.map(s => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(s.reason || 'Assistance requested')}</div>
                  <div class="tag \${s.status === 'acknowledged' ? 'green' : 'amber'}">\${esc(s.status)}</div>
                </div>
                <div class="card-body">
                  URL: <code style="font-size:11px">\${esc(s.url)}</code><br><br>
                  \${s.status === 'acknowledged' ? \`Assigned to: <strong>\${esc(s.acknowledgedBy)}</strong>\` : 'Waiting for agent response...'}
                </div>
              </div>
            \`).join('')
            : '<div class="empty">No summons recorded.</div>';
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

    // Send automated Discord notification
    if (discordNotifier.isActive()) {
      const severityEmoji = report.totals.critical > 0 ? "🚨" : report.totals.warning > 0 ? "⚠️" : "✅";
      const color = report.totals.critical > 0 ? 0xe74c3c : report.totals.warning > 0 ? 0xf1c40f : 0x2ecc71;
      
      await discordNotifier.sendEmbed({
        title: `${severityEmoji} Splice Security Audit Completed`,
        description: `**Target URL:** ${targetUrl}\n**Status:** ${report.agentFeedback.summary}`,
        color,
        fields: [
          { name: "Pages Crawled", value: `${report.crawledUrls.length}`, inline: true },
          { name: "Critical Issues", value: `${report.totals.critical}`, inline: true },
          { name: "Warnings", value: `${report.totals.warning}`, inline: true },
          { name: "Passed Checks", value: `${report.totals.passed}`, inline: true },
          { 
            name: "Critical Actions Required", 
            value: report.agentFeedback.criticalActions.length > 0 
              ? report.agentFeedback.criticalActions.join('\n').substring(0, 1000)
              : "None. All critical security checks passed!" 
          }
        ],
        footerText: `Splice Enterprise Security Hub • ${new Date().toLocaleTimeString()}`
      });
    }

    return report;
  }

  /**
   * Toggle the optional OpenClaw gateway server lifecycle dynamically.
   */
  async toggleOpenClawGateway(enabled: boolean) {
    if (enabled) {
      if (!this.openclawGateway) {
        this.openclawGateway = new OpenClawGateway(this);
      }
      await this.openclawGateway.start();
      this.pushLiveFeed('openclaw_gateway', 'Gateway server started manually');
    } else {
      if (this.openclawGateway) {
        await this.openclawGateway.stop();
        this.openclawGateway = null;
        this.pushLiveFeed('openclaw_gateway', 'Gateway server stopped manually');
      }
    }
  }

  async close() {
    if (this.openclawGateway) {
      await this.openclawGateway.stop();
      this.openclawGateway = null;
    }
    if (this.browser) {
      this.expectingShutdown = true;
      try {
        await this.browser.close();
      } finally {
        this.browser = null;
        this.contexts.clear();
        this.pages.clear();
        this.telemetry.clear();
        this.crashedBranches.clear();
      }
    }
  }
}
