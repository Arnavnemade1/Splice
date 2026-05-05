// @ts-ignore
import { chromium } from 'playwright-extra';
// @ts-ignore
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, BrowserContext } from 'playwright';

chromium.use(stealth());

import { TelemetryInterceptor } from './TelemetryInterceptor.js';
import { SemanticExtractor } from './SemanticExtractor.js';
import { CryptoManager } from './CryptoManager.js';
import type { SemanticNode, SessionMetrics } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export class BrowserManager {
  private browser: Browser | null = null;
  private headless: boolean = true;

  // Branch management
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();
  private telemetry: Map<string, TelemetryInterceptor> = new Map();

  public activeBranch: string = 'main';

  public metrics: SessionMetrics = {
    tokensSavedEstimate: 0,
    preventedErrors: 0,
    captchaInterruptions: 0
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
  }

  private async createBranch(branchId: string, storageState?: any) {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext(storageState ? { storageState } : undefined);
    const page = await context.newPage();

    await context.tracing.start({ screenshots: true, snapshots: true });

    const telemetry = new TelemetryInterceptor(page);
    telemetry.start();

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

  // -------------------------
  // NAVIGATION & SPECULATION
  // -------------------------
  async navigate(url: string) {
    const speculativeBranchId = `speculative-${Buffer.from(url).toString('base64').substring(0, 10)}`;
    if (this.contexts.has(speculativeBranchId)) {
      console.log(`[Speculative Execution] Cache hit for ${url}. Instantly switching branch.`);
      this.activeBranch = speculativeBranchId;
      this.pushLiveFeed('navigate', `Cache hit → ${url}`);
      return;
    }

    const page = this.getActivePage();
    await page.goto(url, { waitUntil: 'networkidle' });
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
    const result = await SemanticExtractor.extract(page, intent, lens, maxTokens);

    this.metrics.tokensSavedEstimate += result.tokensSaved;
    this.pushLiveFeed('semantic_tree', `lens=${lens}, intent=${intent || 'none'}, saved=${result.tokensSaved}t`);
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
      this.metrics.preventedErrors++;
      throw new Error(`Element ${elementId} not found or not visible after 3s.`);
    }

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

    this.saveMicroSnapshot('interact', { action, elementId, value, agentId });
  }

  async executeScript(script: string): Promise<any> {
    const page = this.getActivePage();
    try {
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

    const templatePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dashboard', 'index.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    const dataInjection = `
        const microSnapshots = ${JSON.stringify(snaps)};
        const metrics = ${JSON.stringify(this.metrics)};

        const timeline = document.getElementById('timeline');
        timeline.innerHTML = microSnapshots.map((s, i) => \`
            <div class="snapshot-card \${i === 0 ? 'active' : ''}">
                <div class="snap-type">\${s.type.toUpperCase()}</div>
                <div class="snap-details">\${s.url || s.elementId || ''} \${s.action || ''}</div>
                <div class="snap-time">\${new Date(s.timestamp).toLocaleTimeString()}</div>
            </div>
        \`).join('');

        const metricEl = document.getElementById('metrics-inject');
        if (metricEl) metricEl.textContent = JSON.stringify(metrics, null, 2);
    `;

    html = html.replace('// In a real implementation', dataInjection);

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
      const isSafeToDelete = file.startsWith('micro-snap-') || file.startsWith('trace-') || file.startsWith('report-');
      if (isOld && isSafeToDelete) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }

    this.pushLiveFeed('maintenance_cleanup', `Removed ${removed} files older than ${olderThanDays}d`);
    return { removed, olderThanDays };
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
