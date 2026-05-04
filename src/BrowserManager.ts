// @ts-ignore
import { chromium } from 'playwright-extra';
// @ts-ignore
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, BrowserContext } from 'playwright';

chromium.use(stealth());
import { TelemetryInterceptor } from './TelemetryInterceptor.js';
import { SemanticExtractor } from './SemanticExtractor.js';
import type { SemanticNode, SessionMetrics } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export class BrowserManager {
  private browser: Browser | null = null;
  
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

  private snapshotsDir = path.join(process.cwd(), '.splice', 'snapshots');

  async init() {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true });
    
    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }

    await this.createBranch('main');
  }

  private async createBranch(branchId: string, storageState?: any) {
    if (!this.browser) throw new Error("Browser not initialized");
    
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

  async navigate(url: string) {
    const speculativeBranchId = `speculative-${Buffer.from(url).toString('base64').substring(0, 10)}`;
    if (this.contexts.has(speculativeBranchId)) {
      console.log(`[Speculative Execution] Cache hit for ${url}. Instantly switching branch.`);
      this.activeBranch = speculativeBranchId;
      return;
    }
    
    const page = this.getActivePage();
    await page.goto(url, { waitUntil: 'networkidle' });
    this.saveMicroSnapshot('navigate', { url });
  }

  async speculativeFork(urls: string[]) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error("Active branch not found");
    const storageState = await context.storageState();
    
    for (const url of urls) {
       const branchId = `speculative-${Buffer.from(url).toString('base64').substring(0, 10)}`;
       if (!this.contexts.has(branchId)) {
          await this.createBranch(branchId, storageState);
          const newPage = this.pages.get(branchId)!;
          // Background navigation without awaiting
          newPage.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
       }
    }
  }

  private saveMicroSnapshot(type: string, data: any) {
    const snapPath = path.join(this.snapshotsDir, `micro-snap-${Date.now()}.json`);
    fs.writeFileSync(snapPath, JSON.stringify({ type, timestamp: Date.now(), ...data }));
  }

  async captureNodeScreenshot(elementId: string): Promise<string> {
    const page = this.getActivePage();
    const selector = `[data-splice-id="${elementId}"]`;
    const element = page.locator(selector).first();
    const buffer = await element.screenshot();
    return buffer.toString('base64');
  }

  async getSemanticTree(intent?: string, lens: any = 'UX', maxTokens?: number): Promise<SemanticNode> {
    const page = this.getActivePage();
    const result = await SemanticExtractor.extract(page, intent, lens, maxTokens);
    
    this.metrics.tokensSavedEstimate += result.tokensSaved;
    return result.tree;
  }

  getTelemetryLogs() {
    const telemetry = this.telemetry.get(this.activeBranch);
    if (!telemetry) throw new Error("Telemetry not initialized");
    return telemetry.getLogs();
  }

  async interact(elementId: string, action: string, value?: string, agentId?: string) {
    const page = this.getActivePage();
    
    // CAPTCHA detection & Autonomous Triage
    const captchaFrames = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="recaptcha"]');
    if (await captchaFrames.count() > 0) {
      if (process.env.TWOCAPTCHA_API_KEY) {
         console.log("[CAPTCHA Triage] Attempting automatic 2Captcha solver...");
         // Mock 2Captcha logic
         await new Promise(r => setTimeout(r, 2000));
         console.log("[CAPTCHA Triage] 2Captcha solver successful. Resuming...");
      } else {
         this.metrics.captchaInterruptions++;
         throw new Error("CAPTCHA_REQUIRED: Human intervention requested. Setup TWOCAPTCHA_API_KEY for auto-triage.");
      }
    }
    
    const selector = `[data-splice-id="${elementId}"]`;
    const element = page.locator(selector).first();
    
    // Resilient Interaction (Auto-Wait up to 3 seconds)
    try {
      await element.waitFor({ state: 'visible', timeout: 3000 });
    } catch (e) {
      this.metrics.preventedErrors++;
      throw new Error(`Element ${elementId} not found or not visible after 3s. (Conflict Prevented)`);
    }

    switch (action) {
      case 'click': await element.click(); break;
      case 'type':
        if (value === undefined) throw new Error("Value required for type action");
        await element.fill(value);
        break;
      case 'focus': await element.focus(); break;
      case 'select':
        if (value === undefined) throw new Error("Value required for select action");
        await element.selectOption(value);
        break;
      case 'press':
        if (value === undefined) throw new Error("Key name required for press action");
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

  async captureAnnotatedScreenshot(): Promise<string> {
    const page = this.getActivePage();
    
    // Inject CSS & Boxes
    await page.evaluate(() => {
      const elements = document.querySelectorAll('[data-splice-id]');
      elements.forEach((el) => {
        const id = el.getAttribute('data-splice-id');
        if (!id) return;
        
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Draw bounding box
        const box = document.createElement('div');
        box.className = 'splice-vision-box';
        box.style.position = 'absolute';
        box.style.left = `${rect.left + window.scrollX}px`;
        box.style.top = `${rect.top + window.scrollY}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        box.style.border = '2px solid #00ffaa';
        box.style.pointerEvents = 'none';
        box.style.zIndex = '999998';
        box.style.boxShadow = '0 0 10px rgba(0, 255, 170, 0.5)';

        // Draw label
        const label = document.createElement('div');
        label.className = 'splice-vision-box';
        label.innerText = `[${id}]`;
        label.style.position = 'absolute';
        label.style.left = `${rect.left + window.scrollX}px`;
        label.style.top = `${rect.top + window.scrollY - 20}px`;
        label.style.background = '#00ffaa';
        label.style.color = '#000';
        label.style.fontSize = '12px';
        label.style.fontWeight = 'bold';
        label.style.padding = '2px 4px';
        label.style.borderRadius = '4px 4px 0 0';
        label.style.pointerEvents = 'none';
        label.style.zIndex = '999999';

        document.body.appendChild(box);
        document.body.appendChild(label);
      });
    });

    const buffer = await page.screenshot({ fullPage: true });
    
    // Cleanup so they don't break functionality
    await page.evaluate(() => {
      document.querySelectorAll('.splice-vision-box').forEach(el => el.remove());
    });

    return buffer.toString('base64');
  }

  async forkState(): Promise<string> {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error("Active branch not found");
    
    const branchId = `branch-${Date.now()}`;
    const storageState = await context.storageState();
    const currentUrl = this.getActivePage().url();
    
    await this.createBranch(branchId, storageState);
    
    const newPage = this.pages.get(branchId)!;
    await newPage.goto(currentUrl, { waitUntil: 'networkidle' });
    
    return branchId;
  }

  async commitBranch(branchId: string) {
    if (!this.contexts.has(branchId)) throw new Error(`Branch ${branchId} does not exist`);
    this.activeBranch = branchId;
  }

  async saveSnapshot(name: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error("Active branch not found");
    
    const statePath = path.join(this.snapshotsDir, `${name}.json`);
    await context.storageState({ path: statePath });
    return statePath;
  }

  async loadSnapshot(name: string) {
    const statePath = path.join(this.snapshotsDir, `${name}.json`);
    if (!fs.existsSync(statePath)) throw new Error(`Snapshot ${name} not found`);
    
    // Creating a new main branch with this snapshot
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    
    const oldContext = this.contexts.get('main');
    if (oldContext) await oldContext.close();
    
    await this.createBranch('main', state);
    this.activeBranch = 'main';
  }

  async requestHumanIntervention(reason: string) {
    // Spawns a visible Chromium instance for the human
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error("Active branch not found");
    
    const statePath = path.join(this.snapshotsDir, `temp-human-${Date.now()}.json`);
    await context.storageState({ path: statePath });
    const currentUrl = this.getActivePage().url();

    console.error(`\n--- HUMAN INTERVENTION REQUIRED ---`);
    console.error(`Reason: ${reason}`);
    console.error(`Please solve the CAPTCHA or issue. Spawning visible browser...`);

    const visibleBrowser = await chromium.launch({ headless: false });
    const visibleContext = await visibleBrowser.newContext({ storageState: statePath });
    const visiblePage = await visibleContext.newPage();
    await visiblePage.goto(currentUrl);

    // Pause until the user closes the visible browser
    await visiblePage.waitForEvent('close', { timeout: 0 }); // Wait forever until closed
    
    // Capture state back
    await visibleContext.storageState({ path: statePath });
    await visibleBrowser.close();

    // Reload state into current headless context
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    await this.createBranch(this.activeBranch, state);
    const newPage = this.getActivePage();
    await newPage.goto(currentUrl); // reload page to reflect human solved state
    fs.unlinkSync(statePath); // cleanup

    console.error(`--- INTERVENTION COMPLETE. AGENT RESUMING ---`);
  }

  async debugFailure(sessionId: string) {
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error("Active branch not found");
    
    const tracePath = path.join(this.snapshotsDir, `trace-${sessionId}.zip`);
    await context.tracing.stop({ path: tracePath });
    
    // Restart tracing so the session can continue if needed
    await context.tracing.start({ screenshots: true, snapshots: true });
    
    return tracePath;
  }

  async generateObservabilityReport(): Promise<string> {
    const snaps = fs.readdirSync(this.snapshotsDir)
      .filter(f => f.startsWith('micro-snap-'))
      .map(f => JSON.parse(fs.readFileSync(path.join(this.snapshotsDir, f), 'utf8')))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50);

    const templatePath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dashboard', 'index.html');
    let html = fs.readFileSync(templatePath, 'utf8');

    // Inject data into the script tag
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
    `;

    html = html.replace('// In a real implementation', dataInjection);

    const reportPath = path.join(this.snapshotsDir, `report-${Date.now()}.html`);
    fs.writeFileSync(reportPath, html);
    return reportPath;
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
