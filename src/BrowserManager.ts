import { chromium } from 'playwright';
import type { Browser, Page, BrowserContext } from 'playwright';
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
    const page = this.getActivePage();
    await page.goto(url, { waitUntil: 'networkidle' });
  }

  async getSemanticTree(intent?: string, lens: any = 'UX'): Promise<SemanticNode> {
    const page = this.getActivePage();
    const result = await SemanticExtractor.extract(page, intent, lens);
    
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
    
    // CAPTCHA detection simple heuristic before interaction
    const captchaFrames = page.locator('iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[title*="recaptcha"]');
    if (await captchaFrames.count() > 0) {
      this.metrics.captchaInterruptions++;
      throw new Error("CAPTCHA_REQUIRED: Human intervention requested.");
    }
    
    const selector = `[data-splice-id="${elementId}"]`;
    const element = page.locator(selector).first();
    
    const isVisible = await element.isVisible();
    if (!isVisible) {
      this.metrics.preventedErrors++;
      throw new Error(`Element ${elementId} not found or not visible. (Conflict Prevented)`);
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
