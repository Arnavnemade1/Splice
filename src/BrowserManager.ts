// @ts-ignore
import { chromium } from 'playwright-extra';
// @ts-ignore
import stealth from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, BrowserContext, BrowserContextOptions } from 'playwright';

// StealthProfile assigns each session a DETERMINISTIC hardwareConcurrency; the
// plugin's own evasion would pin every context to one shared value (4) and
// erase that per-identity signal. Drop just that evasion — all the others
// (including the critical user-agent Headless-token strip that default,
// non-session branches rely on) stay enabled.
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('navigator.hardwareConcurrency');
chromium.use(stealthPlugin);

import { TelemetryInterceptor } from './TelemetryInterceptor.js';
import { SemanticExtractor } from './SemanticExtractor.js';
import { CryptoManager } from './CryptoManager.js';
import { SecurityAuditor } from './SecurityAuditor.js';
import { AgentCoordinator } from './AgentCoordinator.js';
import { AgentTracker } from './AgentTracker.js';
import { RecoveryMemory } from './RecoveryMemory.js';
import type { SemanticDelta, FullTreeFallback, SpeculativeBranchSummary } from './types.js';
import { OpenClawGateway } from './OpenClawGateway.js';
import { discordNotifier } from './DiscordWebhook.js';
import { resolveFingerprint, stealthContextOptions, stealthInitScript, type StealthFingerprint } from './StealthProfile.js';
import { WebBotAuth } from './WebBotAuth.js';
import { SessionStore, sessionBranchId, isSessionBranch, sessionNameFromBranch, sanitizeSessionName, type SessionRecord } from './SessionStore.js';
import type { AuditOptions } from './SecurityAuditor.js';
import { SpliceError, withRetry, isTransientError, errorMessage } from './Resilience.js';
import { buildBehaviorReport, renderBehaviorMarkdown, summarizeEvent, type BehaviorEvent, type BehaviorReportDigest } from './BehaviorReport.js';
import { optimizePrompt, type PageLabel, type PromptOptimization } from './PromptOptimizer.js';
import { A11Y_RULES, sortFindings, summarizeAudit, type A11yAuditReport } from './AccessibilityAuditor.js';
import { exploreJSpace, cleanLabel, type JSpaceReport } from './JSpace.js';
import { JSpaceMap, observationFromReport, renderJSpaceMapMarkdown, type JSpaceMapReport } from './JSpaceMap.js';
import { JSpaceDetector, type DetectionSummary, type JSpaceDetection } from './JSpaceDetector.js';
import { buildCalibration, explainDecision, type CalibrationReport, type DecisionExplanation } from './Cognition.js';
import { buildTrainOfThought, renderTrainOfThoughtMarkdown, type TrainOfThoughtReport } from './TrainOfThought.js';
import { assembleJacobianReport, type JacobianLensReport } from './JacobianLens.js';
import type { AgentStateDiagnosis, LedgerEntry, SemanticNode, SessionMetrics, VerifiedActionPlan, SummonRequest } from './types.js';
import type {
  NetworkActivitySummary,
  NetworkRequestRecord,
  PageEventRecord,
  WaitCondition,
  WaitForResult,
  FormFieldResult,
  FormFillReport,
  ExtractionField,
  StructuredExtraction,
  PageExpectation,
  PageAssertionResult,
  ViewportInspection,
  ViewportWidget
} from './types.js';
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

  // Multi-modal feedback: vision previews attach automatically to key tools
  // until the per-session budget runs out. Explicit includeVision: true is
  // never blocked and never counted. Defaults mirror config.ts.
  private readonly visionByDefault = !['0', 'false'].includes((process.env.SPLICE_VISION_BY_DEFAULT ?? '').trim().toLowerCase());

  /**
   * Standing permission to optimize intents inside compile_verified_action
   * (promptOptimization in splice.config.json / SPLICE_PROMPT_OPTIMIZATION).
   * Off by default: without it, prompts are only rewritten when the caller
   * passes optimizeIntent: true on the individual call. Applied rewrites are
   * always reported back via plan.intentOptimization — never silent.
   */
  public promptOptimizationAuto = ['1', 'true', 'auto'].includes((process.env.SPLICE_PROMPT_OPTIMIZATION ?? '').trim().toLowerCase());
  private readonly visionBudget = (() => {
    const raw = Number(process.env.SPLICE_VISION_BUDGET);
    return process.env.SPLICE_VISION_BUDGET !== undefined && Number.isFinite(raw) && raw >= 0 ? raw : 20;
  })();
  private visionCapturesUsed = 0;

  /** Claim one automatic vision capture from the session budget. */
  private consumeVisionBudget(): boolean {
    if (!this.visionByDefault || this.visionCapturesUsed >= this.visionBudget) return false;
    this.visionCapturesUsed++;
    return true;
  }

  /** Multi-agent coordination engine — exposed for MCP tool layer. */
  public readonly coordinator: AgentCoordinator = new AgentCoordinator();

  /** Per-agent performance tracking and in-action optimization. */
  public readonly agentTracker: AgentTracker = new AgentTracker();

  /** Rolling history of recent diagnoses — feeds the predictive trend layer. */
  private diagnosisHistory: Array<{ state: AgentStateDiagnosis['state']; url: string; timestamp: number }> = [];

  /** Delta-first observations: last flattened semantic snapshot per branch. */
  private treeSnapshots: Map<string, { hash: string; url: string; title: string; index: Map<string, { type: string; text?: string; value?: string; tag?: string }> }> = new Map();

  /**
   * Action anchors: unpruned snapshots captured after each state-changing
   * action, keyed by actionId. Lets an agent ask "what changed since action
   * act-N?" across any number of intervening calls.
   */
  private actionAnchors: Map<string, { hash: string; url: string; title: string; tool: string; at: number; index: Map<string, { type: string; text?: string; value?: string; tag?: string }> }> = new Map();
  private actionCounter = 0;
  private readonly MAX_ACTION_ANCHORS = 12;
  private lastActionId: string | null = null;

  /** Token efficiency: consecutive full tree reads per branch whose content did not change. */
  private identicalReads: Map<string, number> = new Map();

  /** Learning loop: persisted recovery patterns per domain+state. */
  public recoveryMemory!: RecoveryMemory;

  // OpenClaw Gateway instance
  private openclawGateway: OpenClawGateway | null = null;

  public metrics: SessionMetrics = {
    tokensSavedEstimate: 0,
    preventedErrors: 0,
    captchaInterruptions: 0,
    selfHealCount: 0,
    redundantObservationTokens: 0
  };

  // Live feed — ring buffer of last 20 actions
  private liveFeed: Array<{ type: string; detail: string; timestamp: number }> = [];

  /**
   * Behavior log — bounded in-memory record of every cognition event
   * (observations, diagnoses, plans, actions, waits, assertions). This is the
   * raw material for generateBehaviorReport(): the chain-of-thought digest an
   * agent reads back to improve its own strategy on long runs.
   */
  private behaviorLog: BehaviorEvent[] = [];
  private readonly MAX_BEHAVIOR_EVENTS = 2000;

  /**
   * J-space map — the session's decision geometry, accumulated. Every
   * compiled action and Jacobian-lens probe records its decision's J-space
   * coordinates here automatically; getJSpaceMap() reads the live map and
   * close() persists it to .splice/jspace/ so every session ends with a report.
   */
  private jSpaceMap = new JSpaceMap();
  private jSpaceReportWrittenAt = 0;
  private thoughtReportWrittenAt = 0;
  /** Hazard detection over decision geometry — screens every mapped decision. */
  private jSpaceDetector = new JSpaceDetector();

  /** Out-of-band page events (dialogs, popups, downloads) the agent would otherwise miss. */
  private pageEvents: PageEventRecord[] = [];
  private readonly MAX_PAGE_EVENTS = 100;
  private downloadsDir: string;

  private spliceDir: string;
  private snapshotsDir: string;
  private vault!: CryptoManager;

  /** Registry of isolated per-account browser identities. */
  public sessions!: SessionStore;
  /** Cryptographic bot identity for cooperative (Web Bot Auth) origins. */
  public webBotAuth!: WebBotAuth;
  /** Live fingerprint per branch — feeds get_stealth_profile and diagnostics. */
  private fingerprints: Map<string, StealthFingerprint> = new Map();

  constructor() {
    this.spliceDir = path.join(process.cwd(), '.splice');
    this.snapshotsDir = path.join(this.spliceDir, 'snapshots');
    this.downloadsDir = path.join(this.spliceDir, 'downloads');
  }

  async init() {
    if (this.browser) return;

    if (!fs.existsSync(this.snapshotsDir)) {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
    }

    // Initialize encryption vault — auto-generates key if needed
    this.vault = new CryptoManager(this.spliceDir);
    this.recoveryMemory = new RecoveryMemory(this.spliceDir);
    this.sessions = new SessionStore(this.spliceDir);
    this.webBotAuth = new WebBotAuth(this.spliceDir);

    // Watch mode from config/env: launch with a visible Chromium window.
    if (process.env.SPLICE_WATCH_MODE === '1') this.headless = false;

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
        // Session branches rebuild with their persisted identity: the same
        // deterministic fingerprint and the last saved storage state (login).
        if (isSessionBranch(branchId)) {
          const record = this.sessions.get(sessionNameFromBranch(branchId));
          const fp = resolveFingerprint(record?.seed ?? sessionNameFromBranch(branchId));
          const state = this.readSessionState(sessionNameFromBranch(branchId));
          await this.createBranch(branchId, state, fp);
        } else {
          await this.createBranch(branchId);
        }
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
      vision: {
        autoEnabled: this.visionByDefault,
        budget: this.visionBudget,
        used: this.visionCapturesUsed,
        remaining: Math.max(0, this.visionBudget - this.visionCapturesUsed),
      },
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

  private async createBranch(branchId: string, storageState?: any, fingerprint?: StealthFingerprint) {
    if (!this.browser) throw new Error('Browser not initialized');

    // A fingerprint makes the whole request/JS surface of this context agree
    // (UA, platform, viewport, locale, timezone, client hints). Sessions pass
    // a per-identity fingerprint so parallel accounts never share one.
    const contextOptions: BrowserContextOptions = fingerprint ? stealthContextOptions(fingerprint) : {};
    if (storageState) contextOptions.storageState = storageState;
    const context = await this.browser.newContext(
      Object.keys(contextOptions).length ? contextOptions : undefined
    );
    if (fingerprint) {
      await context.addInitScript(stealthInitScript(fingerprint));
    }
    const page = await context.newPage();

    // puppeteer-extra-plugin-stealth normalizes UA + hardwareConcurrency across
    // every context to one shared value. For a session we want the OPPOSITE:
    // a distinct, deterministic identity per account. Assert it at the CDP
    // layer (applied last, so it wins over the plugin) without disabling the
    // plugin's other evasions that the default branches still rely on.
    if (fingerprint) {
      try {
        const chromeMajor = /Chrome\/(\d+)/.exec(fingerprint.userAgent)?.[1] ?? '131';
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.setUserAgentOverride', {
          userAgent: fingerprint.userAgent,
          platform: fingerprint.platform,
          acceptLanguage: `${fingerprint.locale},${fingerprint.locale.split('-')[0]};q=0.9`,
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: chromeMajor },
              { brand: 'Not(A:Brand', version: '24' },
              { brand: 'Google Chrome', version: chromeMajor },
            ],
            fullVersion: `${chromeMajor}.0.0.0`,
            platform: fingerprint.secChUaPlatform.replace(/"/g, ''),
            platformVersion: '',
            architecture: 'x86',
            model: '',
            mobile: false,
          },
        });
        await cdp.send('Emulation.setHardwareConcurrencyOverride', {
          hardwareConcurrency: fingerprint.hardwareConcurrency,
        });
      } catch (e) {
        console.error(`[Splice Sessions] CDP fingerprint override failed for ${branchId}: ${errorMessage(e)}`);
      }
    }

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

    // ── Out-of-band event capture ─────────────────────────────────────────
    // Native dialogs, popups, and downloads silently wedge agents that only
    // observe the DOM. Splice auto-handles them non-destructively and records
    // every occurrence so the agent can see what happened and adapt.
    page.on('dialog', async (dialog) => {
      const kind = dialog.type();
      // Alerts and beforeunload have only one safe direction; confirm/prompt
      // default to dismiss so an unattended agent never accepts a destructive
      // action it did not plan.
      const accept = kind === 'alert' || kind === 'beforeunload';
      try {
        if (accept) await dialog.accept();
        else await dialog.dismiss();
      } catch { /* dialog may already be handled */ }
      this.recordPageEvent('dialog', branchId, {
        dialogType: kind,
        message: dialog.message().slice(0, 300),
        action: accept ? 'accepted' : 'dismissed'
      });
      this.pushLiveFeed('dialog', `${kind} ${accept ? 'accepted' : 'dismissed'}: ${dialog.message().slice(0, 60)}`);
    });

    page.on('popup', async (popup) => {
      let url = 'about:blank';
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 3000 });
        url = popup.url();
      } catch { url = popup.url(); }
      this.recordPageEvent('popup', branchId, {
        url,
        note: 'Popup left open. Use navigate(url) on a branch to follow it deliberately.'
      });
      this.pushLiveFeed('popup', `Popup opened: ${url.slice(0, 80)}`);
    });

    page.on('download', async (download) => {
      const suggested = this.sanitizeFileName(download.suggestedFilename() || `download-${Date.now()}`);
      const target = path.join(this.downloadsDir, `${Date.now()}-${suggested}`);
      let saved = false;
      try {
        if (!fs.existsSync(this.downloadsDir)) fs.mkdirSync(this.downloadsDir, { recursive: true });
        await download.saveAs(target);
        saved = true;
      } catch { /* download may have been cancelled */ }
      this.recordPageEvent('download', branchId, {
        url: download.url(),
        suggestedFilename: suggested,
        savedTo: saved ? target : null
      });
      this.pushLiveFeed('download', `${suggested} ${saved ? 'saved' : 'failed'}`);
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
    if (fingerprint) this.fingerprints.set(branchId, fingerprint);
    else this.fingerprints.delete(branchId);
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
    this.behaviorLog.push({ type, timestamp: Date.now(), data });
    if (this.behaviorLog.length > this.MAX_BEHAVIOR_EVENTS) {
      this.behaviorLog.splice(0, this.behaviorLog.length - this.MAX_BEHAVIOR_EVENTS);
    }
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

  /**
   * Structured-intent gate: an intent must name a target on the page, not
   * just a goal state. "click submit on form X" compiles; "finish" does not —
   * it has no target tokens to rank candidates against, so any pick would be
   * a guess presented with false confidence.
   */
  private assessIntentStructure(intent: string): { structured: boolean; reason?: string } {
    const normalized = intent.trim().toLowerCase().replace(/[.!?]+$/, '');
    const vagueGoals = /^(finish|done|continue|proceed|next|go( ahead| on)?|ok(ay)?|yes|do (it|that|this|the thing)|handle (it|this)|make it work|fix (it|this)|complete( (it|this|the (task|flow|process|rest)))?|finish( (it|up|the (task|flow|process)))?|wrap( it)? up|keep going|carry on|try again|retry)$/;
    if (vagueGoals.test(normalized)) {
      return { structured: false, reason: `"${intent}" states a goal, not an action on a target.` };
    }
    if (this.tokenizeIntent(intent).length === 0) {
      return { structured: false, reason: `"${intent}" contains no target words to match against page elements.` };
    }
    return { structured: true };
  }

  /** Top visible actionable elements, for suggesting structured intents on a vague goal. */
  /** Visible actionable labels on the active page — grounding material for
   *  intent suggestions and prompt optimization. */
  private async collectActionableLabels(limit = 6): Promise<PageLabel[]> {
    const page = this.getActivePage();
    return await page.evaluate((max: number) => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const describe = (el: HTMLElement) => (
        el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 60);
      const results: Array<{ kind: 'click' | 'type' | 'select'; label: string }> = [];
      for (const selector of ['button, [role="button"], input[type="submit"]', 'a[href]', 'input:not([type="hidden"]):not([type="submit"]), textarea, select']) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
          if (results.length >= max) break;
          if (!isVisible(el)) continue;
          const label = describe(el);
          if (!label) continue;
          const tag = el.tagName.toLowerCase();
          const kind = tag === 'select' ? 'select' as const : tag === 'input' || tag === 'textarea' ? 'type' as const : 'click' as const;
          if (!results.some(r => r.label === label)) results.push({ kind, label });
        }
        if (results.length >= max) break;
      }
      return results;
    }, limit);
  }

  private async collectIntentSuggestions(limit = 6): Promise<string[]> {
    const labels = await this.collectActionableLabels(limit);
    return labels.map(({ kind, label }) =>
      kind === 'type' ? `type <value> into "${label}"` : kind === 'select' ? `select <option> in "${label}"` : `click "${label}"`
    );
  }

  /**
   * Optimize a prompt for Splice's cognition APIs — suggestion only, nothing
   * is executed or rewritten in place. Strips conversational filler,
   * normalizes verbs, separates input values from intents, grounds the target
   * against the page's actual visible labels, and routes prompts that a
   * one-call primitive (fill_form, wait_for, extract_structured,
   * assert_page_state) serves better. To apply automatically inside
   * compile_verified_action, pass optimizeIntent: true per call or enable
   * promptOptimization in splice.config.json.
   */
  async optimizeIntent(prompt: string): Promise<PromptOptimization> {
    if (!prompt || prompt.trim().length === 0) throw new Error('A prompt is required.');
    const labels = await this.collectActionableLabels(24).catch(() => [] as PageLabel[]);
    // Session-learned hints: words the J-space map saw match nothing in 2+
    // decisions. The optimizer cross-checks them against this page's labels
    // before acting, and reports every application in transformations.
    const optimization = optimizePrompt(prompt, labels, { inertTokens: this.jSpaceMap.recurringInertTokens() });
    if (optimization.changed) {
      this.saveMicroSnapshot('prompt_optimized', {
        original: optimization.original.slice(0, 120),
        optimized: optimization.optimized.slice(0, 120),
        groundedTo: optimization.groundedTo,
        routedTo: optimization.toolSuggestion?.tool,
        estimatedTokensSaved: optimization.estimatedTokensSaved,
      });
    }
    return optimization;
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

  /**
   * Semantic waiting primitive. Blocks until the first of the given
   * conditions is satisfied (any-of), then returns which one matched and how
   * long it took. Replaces the poll-with-full-tree-reads anti-pattern: one
   * call instead of N observations.
   *
   * Never throws on timeout — returns a result with `timedOut: true` and a
   * hint, so a single call always yields a usable signal.
   */
  async waitFor(
    conditions: WaitCondition[],
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<WaitForResult> {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new Error('waitFor requires at least one condition.');
    }
    for (const c of conditions) {
      if (c.kind !== 'network_idle' && (!c.value || String(c.value).trim().length === 0)) {
        throw new Error(`Condition "${c.kind}" requires a value.`);
      }
    }

    await this.ensureHealthy();
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10000, 250), 60000);
    const pollIntervalMs = Math.min(Math.max(options.pollIntervalMs ?? 250, 100), 2000);
    const startedAt = Date.now();
    let pollCount = 0;
    let consecutiveIdlePolls = 0;

    const domKinds = new Set(['text_present', 'text_gone', 'element_visible', 'element_hidden']);
    const needsDomCheck = conditions.some(c => domKinds.has(c.kind));

    while (true) {
      pollCount++;
      const page = this.getActivePage();
      const url = page.url();
      const title = await page.title().catch(() => '');

      // DOM-based conditions resolve in a single in-page pass.
      let domResults: boolean[] = [];
      if (needsDomCheck) {
        domResults = await page.evaluate((conds: Array<{ kind: string; value?: string }>) => {
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const isVisible = (el: Element) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || 1) > 0.05 &&
              rect.width > 0 && rect.height > 0;
          };
          const anyVisibleMatch = (needle: string) => {
            const lower = needle.toLowerCase();
            const els = document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [role], h1, h2, h3, h4, label, [aria-label], summary, li, td, th, p, span, div');
            for (const el of els) {
              const label = [
                el.childElementCount === 0 ? el.innerText : '',
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('name'),
                el.getAttribute('title')
              ].filter(Boolean).join(' ').toLowerCase();
              if (label.includes(lower) && isVisible(el)) return true;
            }
            return false;
          };
          return conds.map(c => {
            const value = (c.value || '').toLowerCase();
            switch (c.kind) {
              case 'text_present': return bodyText.includes(value);
              case 'text_gone': return !bodyText.includes(value);
              case 'element_visible': return anyVisibleMatch(value);
              case 'element_hidden': return !anyVisibleMatch(value);
              default: return false;
            }
          });
        }, conditions.map(c => ({ kind: c.kind, value: c.value }))).catch(() => conditions.map(() => false));
        // A destroyed execution context (mid-navigation) counts as "not yet".
      }

      const inFlight = this.telemetry.get(this.activeBranch)?.getInFlightCount() ?? 0;
      consecutiveIdlePolls = inFlight === 0 ? consecutiveIdlePolls + 1 : 0;

      let domIndex = 0;
      for (let i = 0; i < conditions.length; i++) {
        const c = conditions[i];
        let satisfied = false;
        if (domKinds.has(c.kind)) {
          satisfied = domResults[domIndex++] === true;
        } else if (c.kind === 'url_matches') {
          satisfied = url.toLowerCase().includes(String(c.value).toLowerCase());
        } else if (c.kind === 'title_matches') {
          satisfied = title.toLowerCase().includes(String(c.value).toLowerCase());
        } else if (c.kind === 'network_idle') {
          // Two consecutive idle polls avoid declaring victory between
          // request bursts.
          satisfied = consecutiveIdlePolls >= 2;
        }

        if (satisfied) {
          const elapsedMs = Date.now() - startedAt;
          // Every poll beyond the first replaced a would-be full observation.
          const estimatedTokensSaved = Math.max(0, pollCount - 1) * 350;
          this.metrics.tokensSavedEstimate += estimatedTokensSaved;
          this.saveMicroSnapshot('wait_for', {
            matched: `${c.kind}${c.value ? `("${c.value}")` : ''}`,
            timedOut: false,
            elapsedMs,
            pollCount,
          });
          return {
            satisfied: true,
            matched: { index: i, kind: c.kind, value: c.value },
            elapsedMs,
            timedOut: false,
            pollCount,
            finalUrl: url,
            finalTitle: title,
            estimatedTokensSaved
          };
        }
      }

      if (Date.now() - startedAt + pollIntervalMs > timeoutMs) {
        const elapsedMs = Date.now() - startedAt;
        const estimatedTokensSaved = Math.max(0, pollCount - 1) * 350;
        this.metrics.tokensSavedEstimate += estimatedTokensSaved;
        this.saveMicroSnapshot('wait_for', {
          conditions: conditions.map(c => `${c.kind}${c.value ? `("${c.value}")` : ''}`).join(', '),
          timedOut: true,
          elapsedMs,
          pollCount,
        });
        return {
          satisfied: false,
          elapsedMs,
          timedOut: true,
          pollCount,
          finalUrl: url,
          finalTitle: title,
          estimatedTokensSaved,
          hint: inFlight > 0
            ? `${inFlight} network request(s) still in flight when the wait expired — the page may be slow, not stuck. Consider one retry with a longer timeout.`
            : 'The page settled without meeting any condition. Run diagnose_agent_state to classify what state the page is actually in.'
        };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
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

    await this.captureActionAnchor('navigate');
    this.saveMicroSnapshot('navigate', { url, actionId: this.lastActionId });
  }

  async speculativeFork(urls: string[]): Promise<SpeculativeBranchSummary[]> {
    await this.ensureHealthy();
    const context = this.contexts.get(this.activeBranch);
    if (!context) throw new Error('Active branch not found');
    const storageState = await context.storageState();

    const loads: Array<Promise<SpeculativeBranchSummary>> = [];
    for (const url of urls) {
      const branchId = this.branchIdForUrl(url);
      if (!this.contexts.has(branchId)) {
        await this.createBranch(branchId, storageState);
        const newPage = this.pages.get(branchId)!;
        loads.push(
          newPage.goto(url, { waitUntil: 'networkidle' })
            .then(() => this.snapshotSpeculativeBranch(branchId, url))
            .catch((): SpeculativeBranchSummary => ({ branchId, url, status: 'loading' }))
        );
      } else {
        // Branch already exists (repeat call): report its current comparison.
        loads.push(Promise.resolve({
          branchId,
          url,
          status: this.treeSnapshots.has(branchId) ? 'ready' : 'loading',
          title: this.treeSnapshots.get(branchId)?.title,
          comparedToActive: this.compareBranchToActive(branchId),
        }));
      }
    }
    this.pushLiveFeed('speculative_fork', `Pre-loading ${urls.length} URLs`);

    // Bounded wait: report whatever settles within the budget; slower pages
    // keep pre-loading in the background and are marked 'loading'.
    const summaries = await Promise.all(loads.map((load, i) =>
      Promise.race([
        load,
        new Promise<SpeculativeBranchSummary>(resolve =>
          setTimeout(() => resolve({ branchId: this.branchIdForUrl(urls[i]), url: urls[i], status: 'loading' }), 6000)
        ),
      ])
    ));
    for (const s of summaries.filter(s => s.status === 'ready' && s.comparedToActive)) {
      this.saveMicroSnapshot('speculative_delta', { branchId: s.branchId, url: s.url, summary: s.comparedToActive!.summary });
    }
    return summaries;
  }

  /** Snapshot a pre-loaded speculative branch and compare it to the active branch. */
  private async snapshotSpeculativeBranch(branchId: string, url: string): Promise<SpeculativeBranchSummary> {
    const page = this.pages.get(branchId);
    if (!page) return { branchId, url, status: 'loading' };
    // No intent: an unpruned snapshot doubles as the branch's delta baseline,
    // so deltaOnly works immediately after commit_branch.
    const { tree } = await SemanticExtractor.extract(page, undefined, 'UX', undefined, []);
    const title = await page.title().catch(() => '');
    this.updateTreeSnapshot(tree, page.url(), title, branchId);
    return {
      branchId,
      url,
      status: 'ready',
      title,
      comparedToActive: this.compareBranchToActive(branchId),
    };
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

    // Update the delta baseline for this branch, tracking redundant reads:
    // an unchanged hash means this full tree re-sent bytes the agent already had.
    const title = await page.title().catch(() => '');
    const prevHash = this.treeSnapshots.get(this.activeBranch)?.hash;
    const newHash = this.updateTreeSnapshot(result.tree, page.url(), title);
    if (prevHash && prevHash === newHash) {
      this.identicalReads.set(this.activeBranch, (this.identicalReads.get(this.activeBranch) ?? 0) + 1);
      this.metrics.redundantObservationTokens += Math.round(JSON.stringify(result.tree).length / 4);
    } else {
      this.identicalReads.set(this.activeBranch, 0);
    }

    return result.tree;
  }

  /**
   * Token efficiency: a nudge for the tool layer to attach to full tree
   * responses when the page has not changed since the previous read —
   * i.e. the agent just paid full price for information it already had.
   */
  getObservationEfficiencyHint(): string | null {
    const repeats = this.identicalReads.get(this.activeBranch) ?? 0;
    if (repeats < 1) return null;
    return `[Token Optimizer] This full tree is identical to your previous read (${repeats} redundant read(s), ~${this.metrics.redundantObservationTokens} tokens re-sent this session). Pass deltaOnly: true with the same intent to receive only what changed.`;
  }

  // -------------------------
  // DELTA-FIRST OBSERVATIONS
  // -------------------------
  private flattenTree(tree: SemanticNode): Map<string, { type: string; text?: string; value?: string; tag?: string }> {
    const index = new Map<string, { type: string; text?: string; value?: string; tag?: string }>();
    const walk = (node: SemanticNode) => {
      if (node.id && node.id !== 'root' && node.type !== 'system') {
        index.set(node.id, { type: node.type, text: node.text, value: node.value, tag: node.attributes?.tagName });
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    return index;
  }

  private updateTreeSnapshot(tree: SemanticNode, url: string, title: string, branchId: string = this.activeBranch): string {
    const index = this.flattenTree(tree);
    const hash = createHash('sha256')
      .update(JSON.stringify(Array.from(index.entries())))
      .digest('hex')
      .slice(0, 12);
    this.treeSnapshots.set(branchId, { hash, url, title, index });
    return hash;
  }

  /** Hash of the current delta baseline for the active branch, if one exists. */
  getSnapshotHash(): string | null {
    return this.treeSnapshots.get(this.activeBranch)?.hash ?? null;
  }

  /** Anchor id of the most recent state-changing action, if any. */
  getLastActionId(): string | null {
    return this.lastActionId;
  }

  /**
   * Capture an unpruned post-action snapshot so later delta calls can anchor
   * to this exact moment via sinceLastActionId. Unpruned deliberately: the
   * anchor cannot know what intent a future diff will use, and mixing pruning
   * settings across a diff fabricates adds/removes. Best-effort — an anchor
   * that fails to capture never fails the action itself.
   */
  private async captureActionAnchor(tool: string): Promise<string | null> {
    try {
      const page = this.getActivePage();
      const telemetry = this.telemetry.get(this.activeBranch);
      const result = await SemanticExtractor.extract(page, undefined, 'UX', undefined, telemetry?.getLogs() || []);
      const index = this.flattenTree(result.tree);
      const hash = createHash('sha256')
        .update(JSON.stringify(Array.from(index.entries())))
        .digest('hex')
        .slice(0, 12);
      const actionId = `act-${++this.actionCounter}`;
      this.actionAnchors.set(actionId, {
        hash,
        url: page.url(),
        title: await page.title().catch(() => ''),
        tool,
        at: Date.now(),
        index
      });
      while (this.actionAnchors.size > this.MAX_ACTION_ANCHORS) {
        const oldest = this.actionAnchors.keys().next().value;
        if (oldest === undefined) break;
        this.actionAnchors.delete(oldest);
      }
      this.lastActionId = actionId;
      return actionId;
    } catch {
      return null;
    }
  }

  /** Core diff between two flattened snapshots, keyed by stable data-splice-id. */
  private diffIndexes(
    previous: Map<string, { type: string; text?: string; value?: string; tag?: string }>,
    current: Map<string, { type: string; text?: string; value?: string; tag?: string }>
  ): { added: SemanticDelta['added']; removed: SemanticDelta['removed']; changed: SemanticDelta['changed']; unchangedCount: number } {
    const added: SemanticDelta['added'] = [];
    const removed: SemanticDelta['removed'] = [];
    const changed: SemanticDelta['changed'] = [];
    let unchangedCount = 0;

    for (const [id, node] of current) {
      const prev = previous.get(id);
      if (!prev) {
        added.push({ id, type: node.type, text: node.text?.slice(0, 120), tag: node.tag });
      } else {
        let mutated = false;
        if ((prev.text ?? '') !== (node.text ?? '')) {
          changed.push({ id, field: 'text', before: (prev.text ?? '').slice(0, 120), after: (node.text ?? '').slice(0, 120) });
          mutated = true;
        }
        if ((prev.value ?? '') !== (node.value ?? '')) {
          changed.push({ id, field: 'value', before: (prev.value ?? '').slice(0, 120), after: (node.value ?? '').slice(0, 120) });
          mutated = true;
        }
        if (!mutated) unchangedCount++;
      }
    }
    for (const [id, node] of previous) {
      if (!current.has(id)) removed.push({ id, text: node.text?.slice(0, 120), tag: node.tag });
    }
    return { added, removed, changed, unchangedCount };
  }

  /**
   * Cross-branch comparison for speculative pre-loads. data-splice-ids are
   * per-page, so branches are compared by content signature (tag + text)
   * rather than by id — this answers "what does that page have that this
   * one doesn't", not "which node mutated".
   */
  private compareBranchToActive(branchId: string): SpeculativeBranchSummary['comparedToActive'] {
    const active = this.treeSnapshots.get(this.activeBranch);
    const other = this.treeSnapshots.get(branchId);
    if (!active || !other) return null;
    const sig = (n: { type: string; text?: string; tag?: string }) => `${n.tag || n.type}|${(n.text || '').slice(0, 80)}`;
    const activeSigs = new Set(Array.from(active.index.values()).map(sig));
    const otherSigs = new Set(Array.from(other.index.values()).map(sig));
    const unique = Array.from(otherSigs).filter(s => !activeSigs.has(s));
    const missing = Array.from(activeSigs).filter(s => !otherSigs.has(s));
    return {
      uniqueElements: unique.length,
      missingElements: missing.length,
      uniqueSample: unique.slice(0, 5).map(s => s.split('|')[1]).filter(Boolean),
      summary: `${unique.length} element(s) unique to this branch, ${missing.length} active-branch element(s) absent`,
    };
  }

  /**
   * Delta-first observation: extract a fresh semantic snapshot and return
   * ONLY what changed since the previous one on this branch — new elements,
   * removed elements, text/value mutations, and URL/title transitions.
   * Dramatically cheaper than re-reading the full tree on long sessions.
   *
   * Falls back to the full tree (FullTreeFallback) when no baseline exists or
   * when the caller's lastSnapshotHash no longer matches the server baseline,
   * so a single call always yields a usable observation. Use the same intent
   * across calls — intent-based pruning changes which elements are visible,
   * and mixing intents produces spurious added/removed entries.
   *
   * With structuralOnly, text-only mutations (tickers, timestamps, counters)
   * are suppressed as churn: only added/removed elements and value changes
   * are reported, with textChangesIgnored counting what was filtered.
   */
  async getSemanticDelta(intent?: string, lens: any = 'UX', lastSnapshotHash?: string, structuralOnly?: boolean, sinceLastActionId?: string): Promise<SemanticDelta | FullTreeFallback> {
    // Action-anchored diffs are unpruned on both sides: the anchor was
    // captured without knowing this call's intent, and mixing pruning
    // settings across a diff fabricates adds/removes.
    const anchored = sinceLastActionId !== undefined;
    const previous = anchored
      ? this.actionAnchors.get(sinceLastActionId!)
      : this.treeSnapshots.get(this.activeBranch);
    const tree = await this.getSemanticTree(anchored ? undefined : intent, lens);
    const current = this.treeSnapshots.get(this.activeBranch)!;

    if (anchored && !previous) {
      const known = Array.from(this.actionAnchors.keys());
      return {
        fullTreeRequired: true,
        reason: `Unknown actionId "${sinceLastActionId}" — it may have aged out of the anchor window (last ${this.MAX_ACTION_ANCHORS} actions kept). ${known.length > 0 ? `Known anchors: ${known.join(', ')}.` : 'No anchors exist yet; perform an action first.'} The full tree is returned.`,
        snapshotHash: current.hash,
        tree,
      };
    }
    if (!previous) {
      return {
        fullTreeRequired: true,
        reason: 'No prior snapshot existed for this branch. The full tree is returned and the baseline is now established — subsequent deltaOnly calls will diff against it.',
        snapshotHash: current.hash,
        tree,
      };
    }
    if (!anchored && lastSnapshotHash && lastSnapshotHash !== previous.hash) {
      return {
        fullTreeRequired: true,
        reason: `Your lastSnapshotHash (${lastSnapshotHash}) does not match the server baseline (${previous.hash}) — the page was observed again since your last read. The full tree is returned; the new baseline is ${current.hash}.`,
        snapshotHash: current.hash,
        tree,
      };
    }

    const { added, removed, changed: allChanged, unchangedCount } = this.diffIndexes(previous.index, current.index);

    // Re-render detection: an element the framework re-created (or moved)
    // gets a fresh splice-id but keeps its content signature. Pairing those
    // added/removed entries and reporting them as rewrittenIds keeps identity
    // churn from masquerading as real page changes.
    const signature = (n: { type?: string; text?: string; value?: string; tag?: string }) =>
      `${n.tag || ''}|${n.type || ''}|${(n.text || '').slice(0, 120)}|${(n.value || '').slice(0, 120)}`;
    const rewrittenIds: NonNullable<SemanticDelta['rewrittenIds']> = [];
    const removedBySig = new Map<string, Array<(typeof removed)[number]>>();
    for (const r of removed) {
      const prevNode = previous.index.get(r.id);
      const sig = signature({ ...prevNode, tag: r.tag, text: r.text });
      if (!removedBySig.has(sig)) removedBySig.set(sig, []);
      removedBySig.get(sig)!.push(r);
    }
    const realAdded = added.filter(a => {
      const sig = signature({ ...current.index.get(a.id), tag: a.tag, text: a.text, type: a.type });
      const twins = removedBySig.get(sig);
      if (twins && twins.length > 0) {
        const twin = twins.shift()!;
        rewrittenIds.push({ from: twin.id, to: a.id, text: a.text });
        return false;
      }
      return true;
    });
    const rewrittenFromIds = new Set(rewrittenIds.map(r => r.from));
    const realRemoved = removed.filter(r => !rewrittenFromIds.has(r.id));

    // structuralOnly: text churn is noise on live pages — keep structure and value changes.
    const changed = structuralOnly ? allChanged.filter(c => c.field !== 'text') : allChanged;
    const textChangesIgnored = structuralOnly ? allChanged.length - changed.length : undefined;

    const delta: SemanticDelta = {
      deltaOf: previous.hash,
      snapshotHash: current.hash,
      url: { before: previous.url, after: current.url, changed: previous.url !== current.url },
      title: { before: previous.title, after: current.title, changed: previous.title !== current.title },
      added: realAdded.slice(0, 40),
      removed: realRemoved.slice(0, 40),
      changed: changed.slice(0, 40),
      unchangedCount,
      summary: [
        anchored ? `since ${sinceLastActionId}` : null,
        previous.url !== current.url ? `navigated ${previous.url} → ${current.url}` : null,
        previous.title !== current.title ? `title "${previous.title}" → "${current.title}"` : null,
        `${realAdded.length} added, ${realRemoved.length} removed, ${changed.length} changed, ${unchangedCount} unchanged`,
        rewrittenIds.length > 0 ? `${rewrittenIds.length} element(s) re-rendered with new ids (content unchanged)` : null,
        textChangesIgnored ? `${textChangesIgnored} text-only change(s) suppressed as churn` : null,
      ].filter(Boolean).join('; '),
    };
    if (anchored) delta.sinceActionId = sinceLastActionId;
    if (rewrittenIds.length > 0) delta.rewrittenIds = rewrittenIds.slice(0, 20);
    if (textChangesIgnored !== undefined) delta.textChangesIgnored = textChangesIgnored;

    // Credit the savings: the agent received this delta instead of the full tree.
    const saved = Math.max(0, Math.round((JSON.stringify(tree).length - JSON.stringify(delta).length) / 4));
    delta.estimatedTokensSaved = saved;
    this.metrics.tokensSavedEstimate += saved;

    this.saveMicroSnapshot('semantic_delta', {
      summary: delta.summary,
      sinceActionId: delta.sinceActionId,
      added: delta.added.length,
      removed: delta.removed.length,
      changed: delta.changed.length,
      rewrittenIds: delta.rewrittenIds?.length ?? 0,
      urlChanged: delta.url.changed,
      addedSample: delta.added.slice(0, 3).map(a => a.text || a.id),
      removedSample: delta.removed.slice(0, 3).map(r => r.text || r.id),
      changedSample: delta.changed.slice(0, 3).map(c => `${c.id}: "${c.before}" → "${c.after}"`),
    });
    return delta;
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

    diagnosis.recommendedRecoveryStrategy = this.buildRecoveryStrategy(domSignals.url, state);

    this.saveMicroSnapshot('agent_state_diagnosis', {
      state: diagnosis.state,
      confidence: diagnosis.confidence,
      summary: diagnosis.summary,
      signals: diagnosis.signals,
      likelyStuck: diagnosis.trend?.likelyStuck ?? false,
      recoveryStrategySource: diagnosis.recommendedRecoveryStrategy?.source
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

  private domainOf(url: string): string {
    try { return new URL(url).host; } catch { return ''; }
  }

  /**
   * Learning loop: surface a recovery strategy for the diagnosed state,
   * preferring patterns that verifiably worked on this domain before.
   */
  private buildRecoveryStrategy(url: string, state: AgentStateDiagnosis['state']): NonNullable<AgentStateDiagnosis['recommendedRecoveryStrategy']> {
    const generalAdvice: Record<string, string> = {
      ready: 'No recovery needed — compile the next verified intent action.',
      ui_obstruction: 'Compile a verified action targeting the dismiss/close control of the obstruction.',
      validation_blocked: 'Inspect the invalid fields via the semantic tree, fill required values, then retry submission.',
      auth_required: 'Load an authenticated snapshot (load_snapshot) or pause for credentials via the host agent policy.',
      captcha: 'Call request_human_intervention — automated retries will not pass a CAPTCHA.',
      navigation_pending: 'Wait briefly and re-diagnose; if it persists, check telemetry for a hung request.',
      network_failure: 'Inspect the failing endpoint in telemetry before retrying navigation.',
      stale_or_missing_target: 'Re-extract the semantic tree (optionally deltaOnly) to refresh element IDs.',
      ambiguous_target: 'Re-compile the intent with requireExactText or a more specific description.',
      unknown: 'Capture an annotated screenshot and a semantic tree to gather more evidence.'
    };

    const domain = this.domainOf(url);
    const learned = domain && state !== 'ready' ? this.recoveryMemory.lookup(domain, state) : [];
    if (learned.length > 0) {
      const top = learned[0];
      return {
        source: 'learned',
        advice: `On ${domain}, "${state}" was previously recovered ${top.successCount}× by ${top.action} via intent "${top.intent}"${top.targetLabel ? ` (target: "${top.targetLabel}")` : ''}. Try that first.`,
        learnedPatterns: learned.map(p => ({ intent: p.intent, action: p.action, targetLabel: p.targetLabel, successCount: p.successCount }))
      };
    }
    return { source: 'general', advice: generalAdvice[state] ?? generalAdvice.unknown };
  }

  /**
   * The candidate ranking behind compile_verified_action: score every visible
   * actionable element against the intent tokens. Extracted so introspection
   * tools (the Jacobian lens) probe the real ranking, not an approximation.
   */
  private async rankIntentCandidates(
    keywords: string[],
    inferredAction: string,
    currentHost: string,
    constraints: { noNavigationOutsideDomain?: boolean; requireExactText?: boolean } = {}
  ): Promise<Array<{
    id: string; tagName: string; label: string; href: string; score: number;
    disabled: boolean; obstructed: boolean;
    rect: { x: number; y: number; width: number; height: number }; external: boolean;
    /** Per-keyword score contribution, aligned with `keywords` — the exact
     *  Jacobian column for this candidate (the linear part of the score). */
    keywordContributions: number[];
    /** Bonus from the full joined query matching the label (nonlinear in tokens). */
    queryBonus: number;
    /** Everything token-independent: action affinity, penalties, link heuristics. */
    structuralScore: number;
    /** Named concept-feature vector — Splice's "activation" for this candidate.
     *  These are the interpretable directions the decision workspace is built
     *  from (query match, keyword match, action affinity, obstruction, …). */
    features: Record<string, number>;
  }>> {
    const page = this.getActivePage();
    return page.evaluate((args: { keywords: string[]; query: string; currentHost: string; noExternal: boolean; requireExactText: boolean; inferredAction: string }) => {
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
          // Named concept features — the decision workspace's axes. The score
          // is exactly their sum, so each is an interpretable direction along
          // which the choice can be moved.
          const features: Record<string, number> = {
            queryMatch: 0,
            keywordMatch: 0,
            exactTextGate: 0,
            actionAffinity: 0,
            navHeuristic: 0,
            disabledPenalty: 0,
            externalPenalty: 0,
            obstructionPenalty: 0,
          };
          if (args.query && normalized === args.query) features.queryMatch = 42;
          else if (args.query && normalized.includes(args.query)) features.queryMatch = 30;
          const queryBonus = features.queryMatch;
          const keywordContributions = args.keywords.map((keyword): number =>
            normalized === keyword ? 24 : normalized.includes(keyword) ? 10 : 0
          );
          features.keywordMatch = keywordContributions.reduce((a, b) => a + b, 0);
          if (args.requireExactText && args.keywords.length > 0 && !args.keywords.some(keyword => normalized.includes(keyword))) {
            features.exactTextGate = -30;
          }
          // Action affinity: the inferred action constrains what kind of
          // element can possibly satisfy the intent. A typing intent must
          // resolve to an editable control, never a button — regardless of
          // how well the button's label happens to match.
          const editable = tagName === 'input' || tagName === 'textarea' || el.isContentEditable;
          if (args.inferredAction === 'type') {
            features.actionAffinity = editable ? 12 : -30;
          } else if (args.inferredAction === 'select') {
            features.actionAffinity = tagName === 'select' ? 12 : -20;
          } else if (args.inferredAction === 'click') {
            features.actionAffinity = (tagName === 'button' || el.getAttribute('role') === 'button') ? 3 : 0;
          }
          if (tagName === 'a' && /pricing|docs|login|sign|dashboard|settings|account/.test(normalized)) features.navHeuristic = 2;
          if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') features.disabledPenalty = -25;

          let external = false;
          if (href && args.noExternal) {
            try { external = new URL(href).host !== args.currentHost; } catch { external = false; }
            if (external) features.externalPenalty = -40;
          }

          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const topElement = document.elementFromPoint(centerX, centerY);
          const obstructed = !!topElement && topElement !== el && !el.contains(topElement);
          if (obstructed) features.obstructionPenalty = -12;

          const score = Object.values(features).reduce((a, b) => a + b, 0);
          const keywordSum = features.keywordMatch;
          return {
            id,
            tagName,
            label: label.slice(0, 180),
            href,
            score,
            disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
            obstructed,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            external,
            keywordContributions,
            queryBonus,
            structuralScore: score - keywordSum - queryBonus,
            features
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
      requireExactText: constraints.requireExactText === true,
      inferredAction
    });
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
    /** Caller-declared postconditions verified after execution (url_contains, text_present, ...). */
    expect?: PageExpectation[];
    /** Per-call permission to optimize the intent (strip filler, ground the
     *  target against visible labels, separate the value) before compiling.
     *  Also granted globally via promptOptimization in splice.config.json.
     *  Applied rewrites are reported in plan.intentOptimization. */
    optimizeIntent?: boolean;
  }): Promise<VerifiedActionPlan> {
    const { constraints = {}, execute = false, includeVision, expect } = input;
    let { intent, value } = input;
    if (!intent || intent.trim().length === 0) throw new Error('Intent is required.');

    await this.ensureHealthy();

    // Prompt optimization is opt-in: per call via optimizeIntent, or standing
    // via config. Never applied silently — the rewrite travels in the plan.
    let intentOptimization: VerifiedActionPlan['intentOptimization'];
    const optimizationPermitted = input.optimizeIntent === true || (input.optimizeIntent !== false && this.promptOptimizationAuto);
    if (optimizationPermitted) {
      const optimization = await this.optimizeIntent(intent).catch(() => null);
      // Routing suggestions and multi-step chains are advice for the caller,
      // not something a single compile call may act on — only single-intent
      // textual rewrites are applied here.
      if (optimization?.changed && !optimization.toolSuggestion && !optimization.steps) {
        intentOptimization = {
          original: intent,
          optimized: optimization.optimized,
          transformations: optimization.transformations,
          estimatedTokensSaved: optimization.estimatedTokensSaved,
        };
        intent = optimization.optimized;
        if (value === undefined && optimization.value !== undefined) value = optimization.value;
      }
    }

    const structure = this.assessIntentStructure(intent);
    if (!structure.structured) {
      const suggestedIntents = await this.collectIntentSuggestions().catch(() => [] as string[]);
      // Suggestion-only rescue: even without optimization permission, show
      // what the optimizer would have made of this prompt. Advice, not action.
      if (!optimizationPermitted) {
        const hint = await this.optimizeIntent(intent).catch(() => null);
        if (hint?.changed && hint.optimized !== intent && this.assessIntentStructure(hint.optimized).structured) {
          suggestedIntents.unshift(hint.optimized);
        }
      }
      const plan: VerifiedActionPlan = {
        intent,
        confidence: 0,
        risk: 'high',
        plan: [],
        preconditions: ['The intent must name an action and a target visible on the page.'],
        postconditions: ['No action executed.'],
        evidence: [structure.reason ?? 'Intent is too vague to compile.'],
        alternatives: [],
        needsClarification: true,
        clarification: {
          reason: structure.reason ?? 'Intent is too vague to compile.',
          suggestedIntents,
          guidance: 'Restate the intent as action + target (e.g. \'click "Place order"\', \'type jane@x.com into "Email"\'). Optionally declare the outcome you expect via expect so success is verified, not assumed.'
        }
      };
      if (intentOptimization) plan.intentOptimization = intentOptimization;
      this.saveMicroSnapshot('verified_action_plan', { intent, confidence: 0, risk: 'high', executable: false, needsClarification: true });
      return plan;
    }
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

    const candidates = await this.rankIntentCandidates(keywords, inferredAction, currentHost, constraints);

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
      if (intentOptimization) plan.intentOptimization = intentOptimization;
      this.saveMicroSnapshot('verified_action_plan', { intent, confidence: plan.confidence, risk: plan.risk, executable: false });
      return plan;
    }

    // Map this decision onto the session's J-space map and screen its
    // geometry for hazards. Pure local math over the already-instrumented
    // ranking — the map and the detector build themselves as the agent acts.
    // Detections are advisory: they land in plan.evidence, never block.
    try {
      const geometry = exploreJSpace(intent, keywords, candidates);
      this.jSpaceMap.record(observationFromReport(geometry, 'action', currentUrl));
      const findings = this.jSpaceDetector.screen(geometry).filter((f) => f.severity !== 'info');
      for (const f of findings) {
        evidence.push(`J-space detector [${f.severity}]: ${f.title}. ${f.recommendation}`);
      }
      if (findings.length > 0) {
        const worst = findings.find((f) => f.severity === 'critical') ?? findings[0];
        this.saveMicroSnapshot('jspace_detection', {
          severity: worst.severity,
          detectionType: worst.type,
          title: worst.title.slice(0, 120),
          count: findings.length,
          intent: intent.slice(0, 100),
        });
      }
    } catch { /* the map and detector must never block an action */ }

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
        why: `Best semantic and visual match: "${cleanLabel(best.label) || best.tagName}" scored ${best.score}.`
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
    // Attaches by default (budgeted); explicit true bypasses the budget,
    // explicit false opts out.
    const attachVision = includeVision === true || (includeVision === undefined && this.consumeVisionBudget());
    if (attachVision && best.id) {
      try {
        plan.targetPreview = await this.captureNodeScreenshot(best.id);
      } catch (e) {
        plan.evidence.push(`Vision preview unavailable: ${errorMessage(e)}`);
      }
    } else if (includeVision === undefined && this.visionByDefault) {
      plan.evidence.push('Auto-vision budget exhausted for this session — pass includeVision: true to force a target preview.');
    }

    if (execute && plan.plan.length > 0 && confidence >= 0.45 && !best.disabled && !best.obstructed) {
      const step = plan.plan[0];
      const actionId = await this.interact(step.target, step.action, step.value);
      if (actionId) plan.actionId = actionId;
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
      const heuristicsPassed = domainStillAllowed && (changed || intentVisible || obstructionResolved || validationProgress || afterDiagnosis.state === 'ready');

      // Declared postconditions: poll until they hold or the budget expires,
      // so a slow render doesn't fail an expectation that was about to pass.
      let expectationResults: PageAssertionResult['results'] | undefined;
      let expectationsPassed = true;
      if (expect && expect.length > 0) {
        const deadline = Date.now() + 5_000;
        let assertion = await this.assertPageState(expect);
        while (!assertion.passed && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          assertion = await this.assertPageState(expect);
        }
        expectationResults = assertion.results;
        expectationsPassed = assertion.passed;
      }
      const passed = heuristicsPassed && expectationsPassed;

      // Delta-first: compare against the baseline captured at compile time.
      const delta = await this.getSemanticDelta(intent).catch(() => null);
      const deltaSummary = delta && 'summary' in delta ? delta.summary : null;

      plan.verification = {
        executed: true,
        passed,
        ...(expectationResults ? { expectations: expectationResults } : {}),
        evidence: [
          ...(expectationResults
            ? [expectationsPassed
                ? `All ${expectationResults.length} declared expectation(s) verified.`
                : `Declared expectation(s) failed: ${expectationResults.filter(r => !r.passed).map(r => `${r.kind}("${r.value}") — actual: ${r.actual}`).join('; ')}.`]
            : []),
          changed ? `Page changed from "${beforeTitle || beforeUrl}" to "${afterTitle || afterUrl}".` : 'No URL or title change observed.',
          intentVisible ? 'Post-action page text still contains intent terms.' : 'Intent terms were not found in the post-action body text.',
          obstructionResolved ? 'The previous UI obstruction is no longer present.' : 'No obstruction-resolution signal observed.',
          validationProgress ? 'Validation-blocking signals did not increase after the action.' : 'No validation-progress signal observed.',
          deltaSummary ? `Delta since action: ${deltaSummary}.` : 'No delta computed.',
          `Post-action diagnosis: ${afterDiagnosis.state}.`,
          domainStillAllowed ? 'Domain constraint passed.' : 'Domain constraint failed.'
        ]
      };
      if (delta && 'summary' in delta) plan.delta = delta;

      // Learning loop: if this action verifiably recovered a non-ready state,
      // remember the (domain, state) → action pattern for future diagnoses.
      if (passed && diagnosis.state !== 'ready') {
        this.recoveryMemory.recordSuccess(currentHost, diagnosis.state, intent, inferredAction, best.label || best.tagName);
        this.pushLiveFeed('recovery_learned', `${diagnosis.state} recovered via "${intent}" on ${currentHost}`);
      }
    } else {
      plan.verification = {
        executed: false,
        passed: false,
        evidence: [
          execute ? 'Execution skipped because confidence/preconditions were insufficient.' : 'Execution was not requested.',
          ...(expect && expect.length > 0 ? ['Declared expectations were not checked — nothing executed.'] : []),
          `Top candidate: ${best.id} (${best.label || best.tagName}).`
        ]
      };
    }

    if (intentOptimization) {
      plan.intentOptimization = intentOptimization;
      plan.evidence.push(`Intent optimized before compilation: "${intentOptimization.original}" → "${intentOptimization.optimized}" (${intentOptimization.transformations.join('; ')}).`);
    }
    this.saveMicroSnapshot('verified_action_plan', {
      intent,
      target: best.id,
      confidence: plan.confidence,
      risk: plan.risk,
      executed: plan.verification?.executed,
      passed: plan.verification?.passed,
      expectDeclared: (expect?.length ?? 0) > 0,
      why: plan.plan[0]?.why,
      expectedOutcome: plan.expectedOutcome
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

  private recordPageEvent(type: PageEventRecord['type'], branchId: string, detail: Record<string, unknown>) {
    this.pageEvents.push({ type, branchId, timestamp: Date.now(), detail });
    if (this.pageEvents.length > this.MAX_PAGE_EVENTS) this.pageEvents.shift();
  }

  /**
   * Out-of-band page events (dialogs, popups, downloads) since an optional
   * lookback window. These are events a DOM-only observer never sees.
   */
  getPageEvents(options: { sinceMs?: number; type?: PageEventRecord['type']; limit?: number } = {}): {
    events: PageEventRecord[];
    total: number;
    summary: string;
  } {
    const { sinceMs, type, limit = 25 } = options;
    const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : 0;
    const filtered = this.pageEvents.filter(e =>
      e.timestamp >= cutoff && (type === undefined || e.type === type)
    );
    const events = filtered.slice(-limit);
    const counts = { dialog: 0, popup: 0, download: 0 } as Record<string, number>;
    for (const e of filtered) counts[e.type] = (counts[e.type] || 0) + 1;
    const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    return {
      events,
      total: filtered.length,
      summary: parts.length > 0 ? `Captured ${parts.join(', ')}.` : 'No out-of-band page events captured.'
    };
  }

  /**
   * Network cognition: what has the page's network actually been doing?
   * Answers "did my submit fire a request, and did it succeed?" without a
   * screenshot or a tree read.
   */
  getNetworkActivity(options: {
    urlContains?: string;
    failedOnly?: boolean;
    sinceMs?: number;
    limit?: number;
  } = {}): NetworkActivitySummary {
    const { urlContains, failedOnly, sinceMs, limit = 50 } = options;
    const telemetry = this.telemetry.get(this.activeBranch);
    if (!telemetry) throw new Error('Telemetry not initialized');

    const now = Date.now();
    const cutoff = sinceMs !== undefined ? now - sinceMs : 0;
    const all = telemetry.getNetworkRecords();
    const needle = urlContains?.toLowerCase();

    const matches = all.filter(r => {
      if (r.startedAt < cutoff) return false;
      if (needle && !r.url.toLowerCase().includes(needle)) return false;
      if (failedOnly && !(r.failure || (r.status !== undefined && r.status >= 400))) return false;
      return true;
    });

    const byStatusClass: Record<string, number> = {};
    let completed = 0;
    let failed = 0;
    let pending = 0;
    for (const r of matches) {
      if (r.failure) { failed++; byStatusClass.failed = (byStatusClass.failed || 0) + 1; continue; }
      if (r.status === undefined) { pending++; byStatusClass.pending = (byStatusClass.pending || 0) + 1; continue; }
      completed++;
      if (r.status >= 400) failed++;
      const cls = `${Math.floor(r.status / 100)}xx`;
      byStatusClass[cls] = (byStatusClass[cls] || 0) + 1;
    }

    const worst = [...matches].reverse().find(r => r.failure || (r.status !== undefined && r.status >= 400));
    const insight = worst
      ? `Most recent problem: ${worst.method} ${worst.url.slice(0, 120)} → ${worst.failure || worst.status}.`
      : pending > 0
        ? `${pending} request${pending === 1 ? '' : 's'} still in flight; the page may not have settled.`
        : matches.length > 0
          ? `All ${matches.length} matching requests completed cleanly.`
          : 'No matching network activity.';

    return {
      total: matches.length,
      completed,
      failed,
      pending,
      byStatusClass,
      window: { fromMs: cutoff || (matches[0]?.startedAt ?? now), toMs: now },
      requests: matches.slice(-limit),
      insight
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
           const healedActionId = await this.captureActionAnchor('interact');
           this.saveMicroSnapshot('interact', { action, elementId, value, agentId, selfHealed: true, actionId: healedActionId });
           return healedActionId;
        }
      }

      this.metrics.preventedErrors++;
      throw new Error(`Element ${elementId} not found or not visible after 3s. Self-healing failed.`);
    }

    await this.performAction(element, action, value);

    // Stability check after interaction
    await this.waitForStability(2000);
    this.lastKnownUrls.set(this.activeBranch, page.url());
    const actionId = await this.captureActionAnchor('interact');
    this.saveMicroSnapshot('interact', { action, elementId, value, agentId, actionId });
    return actionId;
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
      case 'hover': await element.hover(); break;
      case 'clear': await element.fill(''); break;
      case 'check': await element.check(); break;
      case 'uncheck': await element.uncheck(); break;
      case 'scroll_into_view': await element.scrollIntoViewIfNeeded(); break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Batch verified form fill: resolve every field by its human label, fill
   * them all, verify each by reading the value back, and report validation
   * state — one call instead of a fill/observe round-trip per field.
   */
  async fillForm(input: {
    fields: Array<{ field: string; value: string }>;
    submitIntent?: string;
    agentId?: string;
  }): Promise<FormFillReport> {
    const { fields, submitIntent, agentId } = input;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error('fillForm requires at least one { field, value } entry.');
    }

    this.coordinator.verifyOwnership(this.activeBranch, agentId);
    await this.ensureHealthy();
    // Stamp data-splice-id attributes so controls are addressable.
    await this.getSemanticTree(fields.map(f => f.field).join(' '), 'UX', 1200);
    const page = this.getActivePage();

    // One in-page pass builds a label index of every visible form control.
    const controls = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.05 &&
          rect.width > 0 && rect.height > 0;
      };

      const labelFor = (el: HTMLElement): string => {
        const parts: string[] = [];
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) parts.push((label as HTMLElement).innerText);
        }
        const wrapping = el.closest('label');
        if (wrapping) parts.push((wrapping as HTMLElement).innerText);
        // aria-labelledby references other elements by id — the accessible name
        // source for most custom widgets.
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
          for (const ref of labelledby.split(/\s+/)) {
            const r = document.getElementById(ref);
            if (r) parts.push(r.innerText || r.textContent || '');
          }
        }
        for (const attr of ['aria-label', 'placeholder', 'name', 'title']) {
          const v = el.getAttribute(attr);
          if (v) parts.push(v);
        }
        // Fall back to the nearest preceding text (common for div-styled forms).
        if (parts.length === 0) {
          const prev = el.previousElementSibling as HTMLElement | null;
          if (prev && prev.innerText) parts.push(prev.innerText);
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      };

      // Classify a control into how it must be filled. Native elements win by
      // tag; everything else is an ARIA/custom widget resolved by role or
      // contenteditable, so custom design-system inputs no longer fall through.
      const kindOf = (el: HTMLElement): string => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') return 'select';
        if (tag === 'textarea') return 'textarea';
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          return 'text';
        }
        if (el.isContentEditable) return 'contenteditable';
        const role = (el.getAttribute('role') || '').toLowerCase();
        if (role === 'checkbox' || role === 'switch' || role === 'radio') return 'aria-toggle';
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') return 'aria-textbox';
        return 'text';
      };

      const nativeSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea';
      const widgetSelector = '[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"], [role="checkbox"], [role="switch"], [role="radio"]';
      const seen = new Set<Element>();
      const controlEls: HTMLElement[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${nativeSelector}, ${widgetSelector}`))) {
        if (seen.has(el)) continue;
        seen.add(el);
        controlEls.push(el);
      }

      const ariaDisabled = (el: HTMLElement) =>
        (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

      let stamp = 0;
      return controlEls
        .filter(isVisible)
        .map(el => {
          // Custom widgets often lack a semantic-tree id (the extractor only
          // stamps native controls). Assign a stable handle here so they are
          // addressable by the same locator as everything else.
          let id = el.getAttribute('data-splice-id');
          if (!id) {
            id = `splice-form-${stamp++}`;
            el.setAttribute('data-splice-id', id);
          }
          return {
            id,
            tag: el.tagName.toLowerCase(),
            kind: kindOf(el),
            type: el.getAttribute('type') || (el.tagName.toLowerCase() === 'select' ? 'select' : 'text'),
            label: labelFor(el).slice(0, 160),
            disabled: ariaDisabled(el),
            required: (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true'
          };
        });
    });

    const results: FormFieldResult[] = [];
    const claimed = new Set<string>();

    const ambiguousFields: string[] = [];
    for (const request of fields) {
      const keywords = this.tokenizeIntent(request.field);
      // Score controls by label keyword overlap; a field may not claim a
      // control another field already claimed. Track the runner-up so a
      // near-tie can be flagged instead of silently guessing wrong.
      const scored = controls
        .filter(control => !claimed.has(control.id))
        .map(control => {
          const normalized = control.label.toLowerCase();
          let score = 0;
          if (normalized === request.field.toLowerCase()) score += 40;
          for (const keyword of keywords) {
            if (normalized === keyword) score += 24;
            else if (normalized.includes(keyword)) score += 10;
          }
          // Type affinity: "email" hints at type=email, etc.
          if (keywords.some(k => control.type.includes(k))) score += 8;
          return { control, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0]?.control ?? null;
      const bestScore = scored[0]?.score ?? 0;
      const runnerUp = scored[1];
      // Near-tie on a different control → the label was too generic to trust.
      const ambiguous = !!runnerUp && bestScore > 0 && runnerUp.score / bestScore >= 0.85;

      if (!best || bestScore <= 0) {
        results.push({ field: request.field, value: request.value, status: 'not_found' });
        continue;
      }
      if (ambiguous) ambiguousFields.push(request.field);
      const meta = {
        control: best.kind,
        ambiguous: ambiguous || undefined,
        alternativeLabel: ambiguous ? runnerUp!.control.label : undefined,
      };

      if (best.disabled) {
        claimed.add(best.id);
        results.push({
          field: request.field, value: request.value, status: 'skipped_disabled',
          targetId: best.id, matchedLabel: best.label, score: bestScore, ...meta
        });
        continue;
      }

      claimed.add(best.id);
      const locator = page.locator(`[data-splice-id="${best.id}"]`).first();
      const truthy = /^(true|yes|on|1|checked)$/i.test(request.value);
      try {
        if (best.kind === 'select') {
          await locator.selectOption({ label: request.value }).catch(async () => {
            await locator.selectOption(request.value);
          });
        } else if (best.kind === 'checkbox' || best.kind === 'radio') {
          if (truthy) await locator.check(); else await locator.uncheck();
        } else if (best.kind === 'aria-toggle') {
          // Custom checkbox/switch/radio: toggle via click only if the desired
          // state differs from the current aria-checked state.
          const current = (await locator.getAttribute('aria-checked')) === 'true';
          if (current !== truthy) await locator.click();
        } else {
          // Native text/textarea, contenteditable, and ARIA textboxes. fill()
          // covers inputs, textareas, and contenteditable; for a stubborn
          // custom textbox, fall back to click + keyboard entry.
          try {
            await locator.fill(request.value);
          } catch {
            await locator.click();
            await page.keyboard.press('Control+A').catch(() => {});
            await page.keyboard.type(request.value);
          }
        }

        // Readback verification + validity in one pass, across every kind.
        const state = await locator.evaluate((el: any, expected: string) => {
          const role = (el.getAttribute('role') || '').toLowerCase();
          const nativeCheck = el.type === 'checkbox' || el.type === 'radio';
          const ariaToggle = role === 'checkbox' || role === 'switch' || role === 'radio';
          let actual: string;
          if (nativeCheck) actual = String(el.checked);
          else if (ariaToggle) actual = el.getAttribute('aria-checked') === 'true' ? 'true' : 'false';
          else if (el.isContentEditable) actual = (el.textContent ?? '').trim();
          else actual = String(el.value ?? el.getAttribute('value') ?? '');
          const valid = typeof el.checkValidity === 'function'
            ? el.checkValidity()
            : el.getAttribute('aria-invalid') !== 'true';
          return { actual, valid, validationMessage: el.validationMessage || '' };
        }, request.value);

        let matches: boolean;
        if (best.kind === 'checkbox' || best.kind === 'radio' || best.kind === 'select') {
          matches = true; // the underlying call threw on failure
        } else if (best.kind === 'aria-toggle') {
          matches = state.actual === String(truthy);
        } else {
          matches = state.actual === request.value;
        }

        results.push({
          field: request.field,
          value: request.value,
          status: matches ? 'filled' : 'readback_mismatch',
          targetId: best.id,
          matchedLabel: best.label,
          score: bestScore,
          ...meta,
          validationMessage: state.valid ? undefined : state.validationMessage || 'Field reports invalid state.'
        });
      } catch (e) {
        results.push({
          field: request.field, value: request.value, status: 'failed',
          targetId: best.id, matchedLabel: best.label, score: bestScore, ...meta,
          validationMessage: errorMessage(e).slice(0, 160)
        });
      }
    }

    // Post-fill form readiness: remaining invalid controls (native + ARIA) and
    // whether a submit control exists and is enabled.
    const readiness = await page.evaluate(() => {
      const invalid: string[] = [];
      const nameOf = (el: Element) =>
        el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id || el.tagName.toLowerCase();
      document.querySelectorAll<HTMLInputElement>('input, select, textarea').forEach(el => {
        if (typeof el.checkValidity === 'function' && !el.checkValidity()) invalid.push(nameOf(el));
      });
      document.querySelectorAll('[aria-invalid="true"]').forEach(el => {
        const n = nameOf(el);
        if (!invalid.includes(n)) invalid.push(n);
      });
      const submitCandidates = Array.from(document.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"], button, [role="button"]'))
        .filter(b => /submit|continue|save|sign|log ?in|register|create|checkout|next|confirm|send|search|apply|pay|order|place/i.test(b.innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || ''));
      const isDisabled = (b: Element) => (b as HTMLButtonElement).disabled === true || b.getAttribute('aria-disabled') === 'true';
      const submitFound = submitCandidates.length > 0;
      const submitEnabled = !submitFound ? null : submitCandidates.some(b => !isDisabled(b));
      return { invalid, submitFound, submitEnabled };
    });

    const filledCount = results.filter(r => r.status === 'filled').length;
    const failedCount = results.length - filledCount;
    const formReady = readiness.invalid.length === 0 && readiness.submitEnabled !== false;
    // A submit control exists but is disabled → filled yet not submittable.
    const submittable = readiness.submitFound ? readiness.submitEnabled === true : undefined;
    // Each field beyond the first would normally cost an interact + observe.
    const estimatedTokensSaved = Math.max(0, fields.length - 1) * 500;
    this.metrics.tokensSavedEstimate += estimatedTokensSaved;

    const report: FormFillReport = {
      fields: results,
      filledCount,
      failedCount,
      invalidFields: readiness.invalid,
      formReady,
      estimatedTokensSaved,
      summary: `Filled ${filledCount}/${fields.length} fields. ` +
        (ambiguousFields.length > 0 ? `${ambiguousFields.length} ambiguous match(es): ${ambiguousFields.slice(0, 3).join(', ')} — confirm before trusting. ` : '') +
        (readiness.invalid.length > 0 ? `${readiness.invalid.length} control(s) still invalid: ${readiness.invalid.slice(0, 4).join(', ')}. ` : 'No invalid controls remain. ') +
        (readiness.submitEnabled === null ? 'No submit control detected.' : readiness.submitEnabled ? 'Submit control is enabled.' : 'Submit control is present but not submittable (disabled).')
    };
    if (submittable !== undefined) report.submittable = submittable;
    if (ambiguousFields.length > 0) report.ambiguousFields = ambiguousFields;

    if (submitIntent) {
      if (formReady) {
        const plan = await this.compileVerifiedAction({ intent: submitIntent, execute: true });
        const executed = plan.verification?.executed === true;
        report.submit = {
          requested: true,
          executed,
          passed: plan.verification?.passed,
          reason: executed ? 'submitted' : 'form_not_ready',
          evidence: plan.needsClarification && plan.clarification
            ? [plan.clarification.reason, ...plan.clarification.suggestedIntents.slice(0, 3).map(s => `Try: ${s}`)]
            : plan.verification?.evidence?.slice(0, 5)
        };
      } else {
        // Honest, specific reason the form was not submitted.
        const reason: NonNullable<FormFillReport['submit']>['reason'] =
          readiness.submitEnabled === false ? 'not_submittable'
          : !readiness.submitFound ? 'no_submit_control'
          : 'form_not_ready';
        const evidenceByReason: Record<string, string> = {
          not_submittable: 'Submit skipped: a submit control exists but is disabled. Some required field is still invalid or a client-side gate is unmet.',
          no_submit_control: 'Submit skipped: no submit-like control was found on the page.',
          form_not_ready: `Submit skipped: the form is not ready (${readiness.invalid.length} invalid control(s)).`
        };
        report.submit = {
          requested: true,
          executed: false,
          reason,
          evidence: [evidenceByReason[reason]]
        };
      }
    }

    await this.waitForStability(2000);
    const actionId = await this.captureActionAnchor('fill_form');
    if (actionId) report.actionId = actionId;
    this.saveMicroSnapshot('fill_form', {
      fields: fields.length,
      filled: filledCount,
      formReady,
      submitted: report.submit?.executed === true,
      agentId,
      actionId
    });
    return report;
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

  /**
   * Schema-driven data extraction. The agent names the fields it wants and
   * Splice finds the best repeating structure on the page — a table, a set of
   * repeated cards, or label/value pairs — and returns clean rows. No
   * selectors, no tree walking, no prompt-side scraping.
   */
  async extractStructured(input: {
    fields: ExtractionField[];
    maxRows?: number;
  }): Promise<StructuredExtraction> {
    const { fields, maxRows = 50 } = input;
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error('extractStructured requires at least one field.');
    }

    await this.ensureHealthy();
    const page = this.getActivePage();
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

    const specs = fields.map(f => ({
      name: f.name,
      keywords: this.tokenizeIntent(`${f.name} ${f.hint || ''}`)
    }));

    const raw = await page.evaluate((args: { specs: Array<{ name: string; keywords: string[] }>; maxRows: number }) => {
      const { specs, maxRows } = args;
      const clean = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const matchScore = (text: string, keywords: string[]): number => {
        const normalized = text.toLowerCase();
        let score = 0;
        for (const keyword of keywords) {
          if (normalized === keyword) score += 3;
          else if (normalized.includes(keyword)) score += 1;
        }
        return score;
      };
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      type Candidate = { method: 'table' | 'repeated-group' | 'label-pairs'; rows: Array<Record<string, string>>; coverage: number };
      const candidates: Candidate[] = [];

      // ── Strategy 1: tables with matchable headers ──────────────────────
      for (const table of Array.from(document.querySelectorAll('table')).filter(isVisible)) {
        const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
        const headRow = headerCells.length > 0
          ? headerCells
          : Array.from(table.querySelector('tr')?.querySelectorAll('th, td') || []);
        if (headRow.length === 0) continue;
        const headers = headRow.map(c => clean((c as HTMLElement).innerText));

        // Map each requested field to its best header column.
        const columnFor: Record<string, number> = {};
        for (const spec of specs) {
          let bestIdx = -1;
          let bestScore = 0;
          headers.forEach((h, idx) => {
            const score = matchScore(h, spec.keywords);
            if (score > bestScore) { bestScore = score; bestIdx = idx; }
          });
          if (bestIdx >= 0) columnFor[spec.name] = bestIdx;
        }
        const mapped = Object.keys(columnFor).length;
        if (mapped === 0) continue;

        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
        const dataRows = bodyRows.length > 0
          ? bodyRows
          : Array.from(table.querySelectorAll('tr')).slice(headerCells.length > 0 ? 0 : 1);
        const rows: Array<Record<string, string>> = [];
        for (const tr of dataRows.slice(0, maxRows)) {
          const cells = Array.from(tr.querySelectorAll('td, th')).map(c => clean((c as HTMLElement).innerText));
          if (cells.every(c => c.length === 0)) continue;
          const row: Record<string, string> = {};
          for (const [name, idx] of Object.entries(columnFor)) {
            if (cells[idx] !== undefined) row[name] = cells[idx];
          }
          if (Object.keys(row).length > 0) rows.push(row);
        }
        if (rows.length > 0) candidates.push({ method: 'table', rows, coverage: mapped / specs.length });
      }

      // ── Strategy 2: repeated sibling groups (cards, list items) ────────
      const parents = new Set<Element>();
      document.querySelectorAll('ul, ol, div, section, tbody').forEach(p => { if (isVisible(p)) parents.add(p); });
      for (const parent of parents) {
        const children = Array.from(parent.children) as HTMLElement[];
        if (children.length < 3) continue;
        // Group children by tag+class signature; take the dominant group.
        const groups = new Map<string, HTMLElement[]>();
        for (const child of children) {
          const sig = `${child.tagName}.${child.className}`;
          if (!groups.has(sig)) groups.set(sig, []);
          groups.get(sig)!.push(child);
        }
        const dominant = [...groups.values()].sort((a, b) => b.length - a.length)[0];
        if (!dominant || dominant.length < 3) continue;

        const rows: Array<Record<string, string>> = [];
        const found: Record<string, number> = {};
        for (const item of dominant.slice(0, maxRows)) {
          const row: Record<string, string> = {};
          for (const spec of specs) {
            // Prefer descendants whose class/attribute names the field, then
            // "Label: value" patterns inside the item text.
            let value = '';
            const descendants = Array.from(item.querySelectorAll<HTMLElement>('*')).slice(0, 60);
            let bestScore = 0;
            for (const d of descendants) {
              const meta = `${d.className} ${d.getAttribute('data-field') || ''} ${d.getAttribute('itemprop') || ''} ${d.getAttribute('aria-label') || ''}`;
              const score = matchScore(meta, spec.keywords);
              if (score > bestScore && d.childElementCount === 0 && clean(d.innerText).length > 0) {
                bestScore = score;
                value = clean(d.innerText);
              }
            }
            if (!value) {
              const text = item.innerText || '';
              for (const keyword of spec.keywords) {
                const rx = new RegExp(`${keyword}\\s*[:\\-–]\\s*([^\\n]+)`, 'i');
                const m = text.match(rx);
                if (m) { value = clean(m[1]); break; }
              }
            }
            if (value) { row[spec.name] = value.slice(0, 200); found[spec.name] = (found[spec.name] || 0) + 1; }
          }
          if (Object.keys(row).length > 0) rows.push(row);
        }
        if (rows.length >= 3) {
          const coverage = specs.filter(s => (found[s.name] || 0) >= rows.length * 0.5).length / specs.length;
          if (coverage > 0) candidates.push({ method: 'repeated-group', rows, coverage });
        }
      }

      // ── Strategy 3: single-record label/value pairs ────────────────────
      {
        const row: Record<string, string> = {};
        // dt/dd pairs
        const pairs: Array<{ label: string; value: string }> = [];
        document.querySelectorAll('dt').forEach(dt => {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === 'DD') pairs.push({ label: clean((dt as HTMLElement).innerText), value: clean((dd as HTMLElement).innerText) });
        });
        // "Label: value" lines in the visible body
        const bodyLines = (document.body?.innerText || '').split('\n').slice(0, 400);
        for (const line of bodyLines) {
          const m = line.match(/^([^:]{2,40}):\s+(.{1,200})$/);
          if (m) pairs.push({ label: clean(m[1]), value: clean(m[2]) });
        }
        for (const spec of specs) {
          let bestScore = 0;
          for (const pair of pairs) {
            const score = matchScore(pair.label, spec.keywords);
            if (score > bestScore && pair.value) { bestScore = score; row[spec.name] = pair.value.slice(0, 200); }
          }
        }
        if (Object.keys(row).length > 0) {
          candidates.push({ method: 'label-pairs', rows: [row], coverage: Object.keys(row).length / specs.length });
        }
      }

      // Pick the candidate with the best coverage; break ties toward more rows.
      candidates.sort((a, b) => b.coverage - a.coverage || b.rows.length - a.rows.length);
      return candidates[0] || null;
    }, { specs, maxRows });

    if (!raw) {
      return {
        method: 'none',
        rows: [],
        rowCount: 0,
        confidence: 0,
        fieldCoverage: Object.fromEntries(fields.map(f => [f.name, 0])),
        summary: 'No table, repeated group, or label/value structure matched the requested fields.'
      };
    }

    const fieldCoverage: Record<string, number> = {};
    for (const f of fields) {
      const present = raw.rows.filter((r: Record<string, string>) => r[f.name] !== undefined).length;
      fieldCoverage[f.name] = raw.rows.length > 0 ? Number((present / raw.rows.length).toFixed(2)) : 0;
    }

    const extraction: StructuredExtraction = {
      method: raw.method,
      rows: raw.rows,
      rowCount: raw.rows.length,
      confidence: Number(Math.min(1, raw.coverage).toFixed(2)),
      fieldCoverage,
      summary: `Extracted ${raw.rows.length} row(s) via ${raw.method} with ${Math.round(raw.coverage * 100)}% field coverage.`
    };

    this.pushLiveFeed('extract', extraction.summary);
    this.saveMicroSnapshot('extract_structured', {
      method: raw.method,
      rows: raw.rows.length,
      fields: fields.map(f => f.name)
    });
    return extraction;
  }

  /**
   * Cheap post-action verification: evaluate a list of expectations against
   * the live page in one pass. Costs a fraction of a tree read — ideal for
   * checking postconditions between actions.
   */
  async assertPageState(expectations: PageExpectation[]): Promise<PageAssertionResult> {
    if (!Array.isArray(expectations) || expectations.length === 0) {
      throw new Error('assertPageState requires at least one expectation.');
    }

    await this.ensureHealthy();
    const page = this.getActivePage();
    const url = page.url();
    const title = await page.title().catch(() => '');

    const domChecks = await page.evaluate((exps: Array<{ kind: string; value: string }>) => {
      const bodyText = (document.body?.innerText || '');
      const lowerBody = bodyText.toLowerCase();
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0.05 && rect.width > 0 && rect.height > 0;
      };
      const findVisible = (needle: string): string | null => {
        const lower = needle.toLowerCase();
        const els = document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [role], h1, h2, h3, h4, label, [aria-label], li, td, th, p, span, div');
        for (const el of els) {
          const label = [
            el.childElementCount === 0 ? el.innerText : '',
            el.getAttribute('aria-label'),
            el.getAttribute('placeholder'),
            el.getAttribute('name')
          ].filter(Boolean).join(' ').toLowerCase();
          if (label.includes(lower) && isVisible(el)) {
            return (el.innerText || el.getAttribute('aria-label') || '').slice(0, 80);
          }
        }
        return null;
      };
      return exps.map(exp => {
        const value = exp.value.toLowerCase();
        switch (exp.kind) {
          case 'text_present': {
            const idx = lowerBody.indexOf(value);
            return { relevant: true, passed: idx >= 0, actual: idx >= 0 ? bodyText.slice(Math.max(0, idx - 20), idx + value.length + 40).replace(/\s+/g, ' ').trim() : 'Text not found in visible body.' };
          }
          case 'text_absent': {
            const idx = lowerBody.indexOf(value);
            return { relevant: true, passed: idx < 0, actual: idx < 0 ? 'Text absent as expected.' : bodyText.slice(Math.max(0, idx - 20), idx + value.length + 40).replace(/\s+/g, ' ').trim() };
          }
          case 'element_visible': {
            const found = findVisible(exp.value);
            return { relevant: true, passed: found !== null, actual: found ?? 'No visible element matched.' };
          }
          case 'element_hidden': {
            const found = findVisible(exp.value);
            return { relevant: true, passed: found === null, actual: found === null ? 'No visible element matched, as expected.' : `Still visible: ${found}` };
          }
          default:
            return { relevant: false, passed: false, actual: '' };
        }
      });
    }, expectations).catch(() => expectations.map(() => ({ relevant: false, passed: false, actual: 'Page evaluation failed (mid-navigation?).' })));

    const results = expectations.map((exp, i) => {
      if (exp.kind === 'url_contains') {
        const passed = url.toLowerCase().includes(exp.value.toLowerCase());
        return { kind: exp.kind, value: exp.value, passed, actual: url };
      }
      if (exp.kind === 'title_contains') {
        const passed = title.toLowerCase().includes(exp.value.toLowerCase());
        return { kind: exp.kind, value: exp.value, passed, actual: title };
      }
      const check = domChecks[i];
      return { kind: exp.kind, value: exp.value, passed: check.passed, actual: check.actual };
    });

    const passed = results.every(r => r.passed);
    const failedKinds = results.filter(r => !r.passed).map(r => `${r.kind}("${r.value}")`);
    const summary = passed
      ? `All ${results.length} expectation(s) hold.`
      : `${failedKinds.length}/${results.length} expectation(s) failed: ${failedKinds.join(', ')}.`;
    this.saveMicroSnapshot('assert_page_state', { expectations: results.length, passed, summary });
    return { passed, results, url, title, summary };
  }

  /**
   * Browser history navigation with the same stabilization pipeline as
   * navigate(): back, forward, or reload.
   */
  async historyNavigate(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string; actionId: string | null }> {
    await this.ensureHealthy();
    const page = this.getActivePage();
    if (direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else if (direction === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });

    await this.waitForStability();
    await this.dismissCommonBanners();
    const url = page.url();
    this.lastKnownUrls.set(this.activeBranch, url);
    this.coordinator.updateBranchStatus(this.activeBranch, url);
    const actionId = await this.captureActionAnchor('history_navigate');
    this.saveMicroSnapshot('history_navigate', { direction, url, actionId });
    return { url, title: await page.title().catch(() => ''), actionId };
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
    // Bounded: a detached or perpetually-animating target must not stall the
    // calling tool for Playwright's default 30s.
    const buffer = await element.screenshot({ timeout: 3_000, animations: 'disabled' });
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
        box.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;border:1.5px solid #10b981;background:rgba(16,185,129,0.07);border-radius:4px;box-sizing:border-box;pointer-events:none;z-index:999998;`;

        const label = document.createElement('div');
        label.className = 'splice-vision-box';
        label.innerText = id;
        label.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${Math.max(0, rect.top + window.scrollY - 18)}px;background:#059669;color:#fff;font:600 10px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 6px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,0.35);white-space:nowrap;pointer-events:none;z-index:999999;`;

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

  /**
   * Multi-modal "what's visible?": a viewport screenshot with numbered
   * highlights over interactive elements, plus a structured map of the
   * complex widgets a DOM-only observer under-reports — video, canvas,
   * sliders, drag targets, carousels, dense grids, running animations.
   * Bridges the sight gap on UIs where the semantic tree alone misleads.
   */
  async inspectViewport(options: { maxHighlights?: number; includeScreenshot?: boolean } = {}): Promise<ViewportInspection> {
    const { maxHighlights = 40, includeScreenshot = true } = options;
    await this.ensureHealthy();
    // Ensure elements carry data-splice-id handles before we draw and map them.
    await this.getSemanticTree('visible interactive elements', 'UX', 300).catch(() => null);
    const page = this.getActivePage();

    const adviceByKind: Record<ViewportWidget['kind'], string> = {
      video: 'Native video: focus it, then interact press Space/k to toggle playback; state shows live playing/position.',
      audio: 'Native audio: focus it, then interact press Space to toggle playback.',
      canvas: 'Canvas renders pixels the DOM cannot describe — rely on the screenshot; coordinate clicks need execute_script.',
      iframe: 'Embedded document: its internals do not appear in this page\'s semantic tree.',
      slider: 'Slider: focus it, then interact press ArrowRight/ArrowLeft to step the value.',
      draggable: 'Drag-and-drop element: pointer dragging is not a click — prefer a keyboard alternative or execute_script.',
      dropzone: 'File/drag drop area: look for an associated file input or button alternative.',
      carousel: 'Carousel: content rotates — use its next/prev controls; a screenshot captures only the current slide.',
      dense_grid: 'Dense grid: prefer extract_structured over reading cells from the tree one by one.',
    };

    const data = await page.evaluate(async (max: number) => {
      // Let fonts and pending layout settle so highlights align with pixels.
      try { await (document as any).fonts?.ready; } catch { /* non-fatal */ }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inViewport = (rect: DOMRect) =>
        rect.width > 3 && rect.height > 3 && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.05;
      };
      const describe = (el: HTMLElement) => (
        el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('src') || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 80);
      const toRect = (rect: DOMRect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });

      // Single overlay root: one node to clean up, no page-layout impact.
      const overlay = document.createElement('div');
      overlay.id = 'splice-viewport-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483645;font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;';
      document.body.appendChild(overlay);

      // Labels dodge each other: place above the box when there is room,
      // inside it otherwise, and nudge below any label already occupying
      // that spot so dense clusters stay readable.
      const placedLabels: Array<{ x: number; y: number; w: number; h: number }> = [];
      const LABEL_H = 16;
      const drawBox = (rect: DOMRect, text: string, theme: 'interactive' | 'widget') => {
        const border = theme === 'interactive' ? '#10b981' : '#f59e0b';
        const fill = theme === 'interactive' ? 'rgba(16,185,129,0.07)' : 'rgba(245,158,11,0.07)';
        const labelBg = theme === 'interactive' ? '#059669' : '#d97706';
        const box = document.createElement('div');
        box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:1.5px ${theme === 'widget' ? 'dashed' : 'solid'} ${border};background:${fill};border-radius:4px;box-sizing:border-box;`;
        overlay.appendChild(box);

        const estWidth = 14 + text.length * 6.2;
        const lx = Math.min(Math.max(2, rect.left), vw - estWidth - 4);
        let ly = rect.top >= LABEL_H + 2 ? rect.top - LABEL_H - 2 : rect.top + 2;
        for (let guard = 0; guard < 8; guard++) {
          const hit = placedLabels.find(p => lx < p.x + p.w && lx + estWidth > p.x && ly < p.y + p.h && ly + LABEL_H > p.y);
          if (!hit) break;
          ly = hit.y + hit.h + 2;
        }
        placedLabels.push({ x: lx, y: ly, w: estWidth, h: LABEL_H });

        const label = document.createElement('div');
        label.textContent = text;
        label.style.cssText = `position:fixed;left:${lx}px;top:${ly}px;height:${LABEL_H}px;display:flex;align-items:center;padding:0 6px;background:${labelBg};color:#fff;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,0.35);white-space:nowrap;`;
        overlay.appendChild(label);
      };

      // Complex widgets first: they claim their elements so the numbered
      // pass will not double-box a slider or video as "interactive" too.
      const widgets: Array<{ kind: string; spliceId?: string; label: string; rect: ReturnType<typeof toRect>; state?: Record<string, unknown> }> = [];
      const widgetEls = new Set<Element>();
      const pushWidget = (el: HTMLElement, kind: string, state?: Record<string, unknown>) => {
        if (widgetEls.has(el) || !isVisible(el)) return;
        const rect = el.getBoundingClientRect();
        if (!inViewport(rect)) return;
        // Skip nested duplicates: a carousel inside a carousel is one carousel.
        const contained = widgets.some(w => w.kind === kind &&
          rect.left >= w.rect.x - 2 && rect.top >= w.rect.y - 2 &&
          rect.right <= w.rect.x + w.rect.width + 2 && rect.bottom <= w.rect.y + w.rect.height + 2);
        if (contained) return;
        widgetEls.add(el);
        widgets.push({ kind, spliceId: el.getAttribute('data-splice-id') || undefined, label: describe(el) || kind, rect: toRect(rect), state });
        const badge = kind === 'video' ? (state && (state as any).playing ? 'video ▶' : 'video ⏸') : kind.replace('_', ' ');
        drawBox(rect, badge, 'widget');
      };

      document.querySelectorAll<HTMLVideoElement>('video').forEach(v => pushWidget(v, 'video', {
        playing: !v.paused && !v.ended, currentTime: Math.round(v.currentTime), duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null, muted: v.muted, hasControls: v.controls,
      }));
      document.querySelectorAll<HTMLAudioElement>('audio').forEach(a => pushWidget(a, 'audio', { playing: !a.paused && !a.ended, muted: a.muted }));
      document.querySelectorAll<HTMLElement>('canvas').forEach(c => pushWidget(c, 'canvas'));
      document.querySelectorAll<HTMLIFrameElement>('iframe').forEach(f => pushWidget(f, 'iframe', { src: (f.src || '').slice(0, 120) }));
      document.querySelectorAll<HTMLInputElement>('input[type="range"], [role="slider"]').forEach(s => pushWidget(s, 'slider', {
        value: s.value ?? s.getAttribute('aria-valuenow'), min: s.min || s.getAttribute('aria-valuemin'), max: s.max || s.getAttribute('aria-valuemax'),
      }));
      document.querySelectorAll<HTMLElement>('[draggable="true"]').forEach(d => pushWidget(d, 'draggable'));
      document.querySelectorAll<HTMLElement>('[class*="dropzone" i], [class*="drop-zone" i], [class*="droparea" i], [aria-dropeffect]').forEach(d => pushWidget(d, 'dropzone'));
      document.querySelectorAll<HTMLElement>('[class*="carousel" i], [class*="swiper" i], [class*="slick" i], [data-carousel]').forEach(c => pushWidget(c, 'carousel'));
      document.querySelectorAll<HTMLElement>('[role="grid"], table').forEach(g => {
        const cells = g.querySelectorAll('td, th, [role="gridcell"]').length;
        if (cells >= 40) pushWidget(g, 'dense_grid', { cellCount: cells });
      });

      // Measured before freezing animations for the capture.
      const animatedElementCount = typeof document.getAnimations === 'function'
        ? new Set(document.getAnimations().filter(a => a.playState === 'running').map(a => (a.effect as KeyframeEffect | null)?.target).filter(Boolean)).size
        : 0;

      // Numbered highlights in reading order (top→bottom, left→right) so the
      // numbers follow the visual flow of the page.
      const interactiveSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]';
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))
        .filter(el => el.getAttribute('data-splice-id') && !widgetEls.has(el) && isVisible(el))
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => inViewport(rect))
        .sort((a, b) => (Math.round(a.rect.top / 24) - Math.round(b.rect.top / 24)) || (a.rect.left - b.rect.left))
        .slice(0, max);
      const interactive = candidates.map(({ el, rect }, index) => {
        drawBox(rect, String(index + 1), 'interactive');
        return {
          n: index + 1,
          spliceId: el.getAttribute('data-splice-id') as string,
          label: describe(el),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          rect: toRect(rect),
        };
      });

      const legend = document.createElement('div');
      legend.textContent = `Splice · ${interactive.length} interactive · ${widgets.length} widget${widgets.length === 1 ? '' : 's'}`;
      legend.style.cssText = 'position:fixed;right:8px;bottom:8px;padding:3px 9px;background:rgba(17,24,39,0.85);color:#e5e7eb;border-radius:999px;box-shadow:0 1px 6px rgba(0,0,0,0.4);';
      overlay.appendChild(legend);

      // Freeze animations/transitions so the capture is crisp — a spinner
      // caught mid-blur or a mid-transition panel misleads a vision model.
      const freeze = document.createElement('style');
      freeze.id = 'splice-viewport-freeze';
      freeze.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
      document.head.appendChild(freeze);

      return { interactive, widgets, animatedElementCount };
    }, maxHighlights);

    let screenshot = '';
    try {
      if (includeScreenshot) {
        const buffer = await page.screenshot({ timeout: 10_000 }); // viewport only — dense UIs stay legible
        screenshot = buffer.toString('base64');
      }
    } finally {
      // Overlay and freeze style must never outlive the capture.
      await page.evaluate(() => {
        document.getElementById('splice-viewport-overlay')?.remove();
        document.getElementById('splice-viewport-freeze')?.remove();
      }).catch(() => {});
    }

    const widgets: ViewportWidget[] = data.widgets.map(w => ({
      ...w,
      kind: w.kind as ViewportWidget['kind'],
      advice: adviceByKind[w.kind as ViewportWidget['kind']],
    }));
    const widgetCounts = widgets.reduce<Record<string, number>>((acc, w) => { acc[w.kind] = (acc[w.kind] || 0) + 1; return acc; }, {});
    const widgetPart = Object.entries(widgetCounts).map(([kind, count]) => `${count} ${kind}`).join(', ');
    const summary =
      `${data.interactive.length} interactive element(s) highlighted in the viewport` +
      (widgetPart ? `; complex widgets: ${widgetPart}` : '; no complex widgets detected') +
      (data.animatedElementCount > 0 ? `; ${data.animatedElementCount} element(s) animating — expect DOM-diff churn` : '') + '.';

    this.pushLiveFeed('inspect_viewport', summary.slice(0, 80));
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      screenshot,
      interactive: data.interactive,
      widgets,
      animatedElementCount: data.animatedElementCount,
      summary,
    };
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

  // -------------------------
  // SESSION ISOLATION PRIMITIVES
  // -------------------------
  // A session is a named, parallel, isolated browser identity — one account.
  // Every session gets its own BrowserContext (cookies and storage are already
  // partitioned per context by Playwright), its own deterministic fingerprint
  // (distinct UA/platform/WebGL/timezone per account, stable across restarts),
  // and an optional encrypted storage-state file so its login survives process
  // restarts. Sessions live as `session:<name>` branches, so they inherit the
  // full observation, reliability, and recovery machinery for free.

  /** Read a session's persisted (encrypted) storage state, if any. */
  private readSessionState(name: string): any | undefined {
    const statePath = this.sessions.statePath(name);
    if (!fs.existsSync(statePath)) return undefined;
    try {
      return JSON.parse(this.vault.readDecrypted(statePath));
    } catch (e) {
      console.error(`[Splice Sessions] Could not read saved state for "${name}": ${errorMessage(e)}`);
      return undefined;
    }
  }

  private sessionSummary(name: string): {
    name: string;
    label?: string;
    branchId: string;
    live: boolean;
    active: boolean;
    seed: string;
    persistent: boolean;
    hasSavedState: boolean;
    url: string | null;
    fingerprint: { userAgent: string; platform: string; timezoneId: string; viewport: { width: number; height: number } } | null;
  } {
    const key = sanitizeSessionName(name);
    const branchId = sessionBranchId(key);
    const record = this.sessions.get(key);
    const live = this.contexts.has(branchId);
    const fp = this.fingerprints.get(branchId) ?? (record ? resolveFingerprint(record.seed) : undefined);
    return {
      name: key,
      label: record?.label,
      branchId,
      live,
      active: this.activeBranch === branchId,
      seed: record?.seed ?? key,
      persistent: record?.persistent ?? true,
      hasSavedState: this.sessions.hasState(key),
      url: live ? (this.lastKnownUrls.get(branchId) ?? this.pages.get(branchId)?.url() ?? null) : null,
      fingerprint: fp
        ? { userAgent: fp.userAgent, platform: fp.platform, timezoneId: fp.timezoneId, viewport: fp.viewport }
        : null,
    };
  }

  /**
   * Spawn (or attach to) an isolated per-account browser identity and make it
   * the active branch. Idempotent: calling it again with the same name attaches
   * to the existing live session instead of duplicating it. Restores any saved
   * login for the account, then optionally navigates to a starting URL.
   */
  async createSession(
    name: string,
    opts: { label?: string; seed?: string; persistent?: boolean; url?: string; agentId?: string } = {}
  ) {
    await this.ensureHealthy();
    const key = sanitizeSessionName(name);
    const branchId = sessionBranchId(key);

    const record = this.sessions.upsert({
      name: key,
      label: opts.label,
      seed: opts.seed,
      persistent: opts.persistent,
    });

    if (!this.contexts.has(branchId)) {
      const fingerprint = resolveFingerprint(record.seed);
      const savedState = this.readSessionState(key);
      await this.createBranch(branchId, savedState, fingerprint);
      this.pushLiveFeed(
        'session_spawn',
        `Spawned session "${key}" (${fingerprint.platform}${savedState ? ', restored login' : ''})`
      );
    }

    this.activeBranch = branchId;
    if (opts.agentId) this.coordinator.acquireOwnership(branchId, opts.agentId);

    if (opts.url) {
      await this.navigate(opts.url);
    }
    this.coordinator.updateBranchStatus(branchId, this.pages.get(branchId)?.url() ?? 'about:blank');
    this.sessions.touch(key);
    return this.sessionSummary(key);
  }

  /** Switch the active branch to an existing session, spawning it if dormant. */
  async switchSession(name: string) {
    const key = sanitizeSessionName(name);
    if (!this.contexts.has(sessionBranchId(key))) {
      if (!this.sessions.get(key)) throw new Error(`No session named "${key}". Create it first with create_session.`);
      // Registered but not live (e.g. after a restart) — respawn its identity.
      return this.createSession(key);
    }
    this.activeBranch = sessionBranchId(key);
    this.sessions.touch(key);
    this.pushLiveFeed('session_switch', `Active session: ${key}`);
    return this.sessionSummary(key);
  }

  /**
   * Persist a session's current cookies + storage to its encrypted state file
   * so the login survives a restart. Defaults to the active session.
   */
  async saveSession(name?: string) {
    const branchId = name ? sessionBranchId(sanitizeSessionName(name)) : this.activeBranch;
    if (!isSessionBranch(branchId)) {
      throw new Error('save_session targets a session. The active branch is not a session — pass a session name.');
    }
    const context = this.contexts.get(branchId);
    if (!context) throw new Error(`Session "${sessionNameFromBranch(branchId)}" is not live.`);
    const key = sessionNameFromBranch(branchId);
    const state = await context.storageState();
    this.vault.writeEncrypted(this.sessions.statePath(key), JSON.stringify(state));
    this.sessions.upsert({ name: key, persistent: true });
    this.pushLiveFeed('session_save', `Saved login for session "${key}"`);
    return this.sessionSummary(key);
  }

  /** List every known identity, merging durable registry with live state. */
  listSessions() {
    const names = new Set<string>(this.sessions.list().map((r) => r.name));
    for (const branchId of this.contexts.keys()) {
      if (isSessionBranch(branchId)) names.add(sessionNameFromBranch(branchId));
    }
    return {
      activeSession: isSessionBranch(this.activeBranch) ? sessionNameFromBranch(this.activeBranch) : null,
      sessions: Array.from(names).map((n) => this.sessionSummary(n)),
    };
  }

  /**
   * Tear down a session. Closes its live context and removes it from the
   * registry. When purge is true, its saved login is also deleted from disk.
   */
  async destroySession(name: string, opts: { purge?: boolean } = {}) {
    const key = sanitizeSessionName(name);
    const branchId = sessionBranchId(key);
    const existedLive = this.contexts.has(branchId);
    if (existedLive) {
      this.expectingShutdown = true;
      try {
        await this.contexts.get(branchId)?.close().catch(() => {});
      } finally {
        this.expectingShutdown = false;
      }
      this.contexts.delete(branchId);
      this.pages.delete(branchId);
      this.telemetry.delete(branchId);
      this.fingerprints.delete(branchId);
      this.lastKnownUrls.delete(branchId);
      this.crashedBranches.delete(branchId);
      this.treeSnapshots.delete(branchId);
    }
    const existedRegistered = this.sessions.remove(key, { purge: opts.purge });
    // If we just closed the active session, fall back to main.
    if (this.activeBranch === branchId) {
      this.activeBranch = this.contexts.has('main') ? 'main' : (this.contexts.keys().next().value ?? 'main');
    }
    this.pushLiveFeed('session_destroy', `Removed session "${key}"${opts.purge ? ' (login purged)' : ''}`);
    return { name: key, wasLive: existedLive, wasRegistered: existedRegistered, purged: !!opts.purge };
  }

  /**
   * The agent's public identity: the active branch's coherent fingerprint plus
   * the Web Bot Auth directory (JWK Set) an origin fetches to verify signed
   * requests. This is what get_stealth_profile returns.
   */
  getStealthProfile() {
    const fp = this.fingerprints.get(this.activeBranch);
    return {
      activeBranch: this.activeBranch,
      session: isSessionBranch(this.activeBranch) ? sessionNameFromBranch(this.activeBranch) : null,
      fingerprint: fp ?? null,
      webBotAuth: {
        keyId: this.webBotAuth.keyId(),
        signatureAgentUrl: this.webBotAuth.signatureAgentUrl,
        directory: this.webBotAuth.getDirectory(),
      },
    };
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

  /**
   * Live, ephemeral session introspection: exactly what the agent has been
   * thinking (intents, target reasoning, diagnosis evidence) and what
   * happened (actions, waits, outcomes), straight from the in-memory
   * behavior log. Nothing is written to disk and no event is recorded for
   * the introspection itself — observing the session does not change it.
   */
  getSessionTrace(options: { limit?: number; type?: string; sinceMs?: number; includeRaw?: boolean } = {}): {
    totalEvents: number;
    returned: number;
    windowMs: number;
    thinking: string[];
    events?: BehaviorEvent[];
    ephemeral: true;
  } {
    const { limit = 200, type, sinceMs, includeRaw = false } = options;
    const cutoff = sinceMs !== undefined ? Date.now() - sinceMs : 0;
    const matched = this.behaviorLog.filter(
      (e) => e.timestamp >= cutoff && (type === undefined || e.type === type)
    );
    const window = matched.slice(-Math.max(1, limit));
    const startedAt = window[0]?.timestamp ?? Date.now();
    return {
      totalEvents: this.behaviorLog.length,
      returned: window.length,
      windowMs: window.length > 0 ? window[window.length - 1].timestamp - startedAt : 0,
      thinking: window.map((e) => `[+${((e.timestamp - startedAt) / 1000).toFixed(1)}s] ${summarizeEvent(e)}`),
      ...(includeRaw ? { events: window } : {}),
      ephemeral: true,
    };
  }

  /**
   * Amateur Jacobian lens: how sensitive is the agent's target choice to its
   * own words? For each intent token, the ranking is re-run without it
   * (finite differences over the real scorer) to show which words are
   * load-bearing. With deep: true the exact analytic J-space is explored on
   * top — token geometry, dominant sensitivity mode, and the precise
   * reweighting boundaries where the choice would flip — plus a consistency
   * check between the analytic prediction and the finite-difference rerun.
   * Recent action→page sensitivity is read from the in-memory delta log.
   */
  async runJacobianLens(intent: string, options: { deep?: boolean; topCandidates?: number } = {}): Promise<{
    intent: string;
    tokens: string[];
    winner: { label: string; score: number } | null;
    runnerUp?: { label: string; score: number };
    margin: number | null;
    perToken: Array<{
      token: string;
      newWinner: string | null;
      winnerChanged: boolean;
      topScoreDelta: number;
      marginDelta: number | null;
    }>;
    actionImpact: Array<{ at: number; summary: string }>;
    jSpace?: JSpaceReport;
    consistency?: { agreements: number; comparisons: number; note: string };
    /** Hazards the J-space detector found in this decision's geometry. */
    detections?: Array<{ severity: string; type: string; title: string; recommendation: string }>;
    insight: string;
    ephemeral: true;
  }> {
    if (!intent || intent.trim().length === 0) throw new Error('An intent is required.');
    await this.ensureHealthy();

    const tokens = this.tokenizeIntent(intent).slice(0, 8);
    if (tokens.length === 0) throw new Error(`Intent "${intent}" has no rankable tokens to perturb.`);
    const inferredAction = this.inferActionFromIntent(intent);
    const currentHost = (() => {
      try { return new URL(this.getActivePage().url()).host; } catch { return ''; }
    })();

    const baseline = await this.rankIntentCandidates(tokens, inferredAction, currentHost);
    const winner = baseline[0] ?? null;
    const runnerUp = baseline[1];
    const margin = winner && runnerUp ? winner.score - runnerUp.score : null;

    // Finite differences: leave each token out and re-run the real ranking.
    const perToken: Array<{ token: string; newWinner: string | null; winnerChanged: boolean; topScoreDelta: number; marginDelta: number | null }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const reduced = tokens.filter((_, idx) => idx !== i);
      const ranked = reduced.length > 0 ? await this.rankIntentCandidates(reduced, inferredAction, currentHost) : [];
      const newTop = ranked[0] ?? null;
      const newMargin = newTop && ranked[1] ? newTop.score - ranked[1].score : null;
      perToken.push({
        token: tokens[i],
        newWinner: newTop ? cleanLabel(newTop.label).slice(0, 80) : null,
        winnerChanged: !!winner && (!newTop || newTop.id !== winner.id),
        topScoreDelta: (newTop?.score ?? 0) - (winner?.score ?? 0),
        marginDelta: margin !== null && newMargin !== null ? Number((newMargin - margin).toFixed(3)) : null,
      });
    }

    // Action→page sensitivity: what each recent action actually perturbed.
    const actionImpact = this.behaviorLog
      .filter((e) => e.type === 'semantic_delta')
      .slice(-8)
      .map((e) => ({ at: e.timestamp, summary: String(e.data.summary ?? '').slice(0, 140) }));

    // Every probe with a winner lands on the session's J-space map and gets
    // screened by the hazard detector, deep or not — the exploration is pure
    // local math over the instrumented ranking, computed once and reused.
    let exploration: JSpaceReport | undefined;
    let detections: JSpaceDetection[] = [];
    if (winner) {
      try {
        exploration = exploreJSpace(intent, tokens, baseline, options.topCandidates ?? 6);
        this.jSpaceMap.record(observationFromReport(exploration, 'lens', this.getActivePage().url()));
        detections = this.jSpaceDetector.screen(exploration);
      } catch { /* mapping and detection must never fail a probe */ }
    }

    let jSpace: JSpaceReport | undefined;
    let consistency: { agreements: number; comparisons: number; note: string } | undefined;
    if (options.deep && winner && exploration) {
      jSpace = exploration;
      // Cross-check: analytic winner with token i zeroed vs the FD rerun.
      let agreements = 0;
      for (let i = 0; i < tokens.length; i++) {
        const analyticScores = baseline.map((c) => c.score - (c.keywordContributions[i] ?? 0));
        const analyticWinner = baseline[analyticScores.indexOf(Math.max(...analyticScores))];
        const fdWinner = perToken[i].newWinner;
        if (fdWinner !== null && cleanLabel(analyticWinner.label).slice(0, 80) === fdWinner) agreements++;
      }
      consistency = {
        agreements,
        comparisons: tokens.length,
        note: agreements === tokens.length
          ? 'Analytic J-space predictions match the finite-difference reruns exactly.'
          : 'Disagreements come from the token-joint terms (query-phrase bonus, exact-text penalty) that the linear J holds constant.',
      };
    }

    const flips = perToken.filter((p) => p.winnerChanged).map((p) => p.token);
    const insight = winner
      ? flips.length > 0
        ? `Load-bearing token(s): ${flips.join(', ')} — removing any of them changes the chosen target away from "${cleanLabel(winner.label).slice(0, 60)}".`
        : `The choice of "${cleanLabel(winner.label).slice(0, 60)}" is stable under every single-token deletion${margin !== null ? ` (margin ${margin})` : ''}.`
      : 'No candidate scored at all — the intent tokens match nothing on this page.';

    this.saveMicroSnapshot('jacobian_lens', {
      intent: intent.slice(0, 100),
      tokens,
      winner: winner ? cleanLabel(winner.label).slice(0, 80) : null,
      flips,
      deep: options.deep === true,
    });

    return {
      intent,
      tokens,
      winner: winner ? { label: cleanLabel(winner.label).slice(0, 80), score: winner.score } : null,
      ...(runnerUp ? { runnerUp: { label: cleanLabel(runnerUp.label).slice(0, 80), score: runnerUp.score } } : {}),
      margin,
      perToken,
      actionImpact,
      ...(jSpace ? { jSpace } : {}),
      ...(consistency ? { consistency } : {}),
      ...(detections.length > 0
        ? { detections: detections.map((d) => ({ severity: d.severity, type: d.type, title: d.title, recommendation: d.recommendation })) }
        : {}),
      insight,
      ephemeral: true,
    };
  }

  /**
   * A compiled decision, retold in plain language: what was chosen and why,
   * what came second and by how much, which single word the choice hangs on,
   * whether it verified, and whether this session's confidence has been
   * trustworthy. Reads the behavior log and the J-space map; touches nothing.
   */
  explainLastDecision(intent?: string): DecisionExplanation {
    const plans = this.behaviorLog.filter((e) => e.type === 'verified_action_plan');
    let planEvent: BehaviorEvent | null = null;
    if (intent && intent.trim().length > 0) {
      const needle = intent.trim().toLowerCase();
      planEvent = [...plans].reverse().find((e) => String(e.data.intent ?? '').toLowerCase().includes(needle)) ?? null;
    } else {
      planEvent = plans.length > 0 ? plans[plans.length - 1] : null;
    }
    const observation = planEvent
      ? this.jSpaceMap.findLatestByIntent(String(planEvent.data.intent ?? ''))
      : intent
        ? this.jSpaceMap.findLatestByIntent(intent)
        : this.jSpaceMap.latest();
    return explainDecision(planEvent, observation, buildCalibration(this.behaviorLog));
  }

  /** The session's confidence-calibration record (see Cognition.ts). */
  getCalibration(): CalibrationReport {
    return buildCalibration(this.behaviorLog);
  }

  /**
   * Intent experiment: race several phrasings of the same intent against the
   * live page — the original, the optimizer's rewrite, an inert-token-stripped
   * cut, an exact-label quote, and any caller-supplied variants — and measure
   * each in J-space (winner, margin, robustness, flip distance, confidence).
   * Nothing executes; ranking is compile-time only. The recommendation is the
   * phrasing that elects the consensus target most robustly with the fewest
   * tokens. If phrasings disagree on the target, that disagreement IS the
   * finding — the intent is ambiguous on this page.
   */
  async runIntentExperiment(intent: string, extraVariants: string[] = [], topCandidates = 6): Promise<{
    intent: string;
    variants: Array<{
      name: string;
      phrase: string;
      winner: string | null;
      margin: number | null;
      robust: boolean | null;
      /** Distance to nearest flip boundary; null = unflippable by any single token. */
      flipDistance: number | null;
      winnerProbability: number | null;
      effectiveDimension: number | null;
      tokenCount: number;
      inertTokens: string[];
    }>;
    consensus: { agreed: boolean; winner: string | null; distinctWinners: string[] };
    recommendation: { name: string; phrase: string; reason: string } | null;
    interpretation: string[];
    method: string;
    ephemeral: true;
  }> {
    if (!intent || intent.trim().length === 0) throw new Error('An intent is required.');
    await this.ensureHealthy();
    const currentHost = (() => {
      try { return new URL(this.getActivePage().url()).host; } catch { return ''; }
    })();

    // Evaluate one phrasing: rank against the real page, explore its J-space.
    const evaluate = async (name: string, phrase: string) => {
      const tokens = this.tokenizeIntent(phrase).slice(0, 8);
      const empty = {
        name, phrase, winner: null as string | null, winnerId: null as string | null,
        margin: null as number | null, robust: null as boolean | null,
        flipDistance: null as number | null, winnerProbability: null as number | null,
        effectiveDimension: null as number | null, tokenCount: tokens.length, inertTokens: [] as string[],
      };
      if (tokens.length === 0) return empty;
      const ranking = await this.rankIntentCandidates(tokens, this.inferActionFromIntent(phrase), currentHost);
      if (!ranking[0] || ranking[0].score <= 0) return empty;
      const report = exploreJSpace(phrase, tokens, ranking, topCandidates);
      const reachable = report.flipBoundaries.filter((f) => !f.unreachable && typeof f.distance === 'number');
      const nearest = reachable.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
      return {
        name, phrase,
        winner: report.winner,
        winnerId: ranking[0].id,
        margin: Number(report.margin.toFixed(3)),
        robust: report.winnerRobustToTokenDeletion,
        flipDistance: nearest ? nearest.distance! : null,
        winnerProbability: report.workspace?.winnerProbability ?? null,
        effectiveDimension: report.workspace?.effectiveDimension ?? null,
        tokenCount: tokens.length,
        inertTokens: report.geometry.inertTokens,
      };
    };

    // Build the variant set. Order matters only for display; dedupe by text.
    const candidates: Array<{ name: string; phrase: string }> = [{ name: 'original', phrase: intent }];
    const optimization = await this.optimizeIntent(intent).catch(() => null);
    if (optimization?.changed && optimization.optimized && !optimization.toolSuggestion) {
      candidates.push({ name: 'optimized', phrase: optimization.optimized });
    }
    const baseline = await evaluate('original', intent);
    if (baseline.inertTokens.length > 0) {
      let strippedPhrase = intent;
      for (const t of baseline.inertTokens) {
        strippedPhrase = strippedPhrase.replace(new RegExp(`\\s*\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
      }
      strippedPhrase = strippedPhrase.replace(/\s+/g, ' ').trim();
      if (strippedPhrase.length >= 3) candidates.push({ name: 'inert-stripped', phrase: strippedPhrase });
    }
    if (baseline.winner) {
      const verb = { click: 'click', type: 'type into', select: 'select', focus: 'focus', press: 'press' }[this.inferActionFromIntent(intent)];
      const label = baseline.winner.replace(/"/g, '').trim();
      if (label.length > 0) candidates.push({ name: 'label-quoted', phrase: `${verb} "${label}"` });
    }
    for (let i = 0; i < extraVariants.length && i < 4; i++) {
      candidates.push({ name: `custom-${i + 1}`, phrase: extraVariants[i] });
    }
    const seen = new Set<string>();
    const variantSpecs = candidates.filter((c) => {
      const key = c.phrase.trim().toLowerCase();
      if (seen.has(key) || key.length === 0) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);

    const variants = [];
    for (const spec of variantSpecs) {
      variants.push(spec.name === 'original' ? baseline : await evaluate(spec.name, spec.phrase));
    }

    // Consensus: do the phrasings even agree on what to act on?
    const rankable = variants.filter((v) => v.winnerId !== null);
    const winnerIds = [...new Set(rankable.map((v) => v.winnerId as string))];
    const idCounts = new Map<string, number>();
    for (const v of rankable) idCounts.set(v.winnerId as string, (idCounts.get(v.winnerId as string) ?? 0) + 1);
    const consensusId = [...idCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const consensusWinner = rankable.find((v) => v.winnerId === consensusId)?.winner ?? null;
    const agreed = winnerIds.length <= 1;

    // Recommend: among phrasings electing the consensus target, prefer
    // unflippable > farthest flip boundary > widest margin > fewest tokens.
    const contenders = rankable.filter((v) => v.winnerId === consensusId);
    contenders.sort((a, b) => {
      const robustDiff = Number(b.robust) - Number(a.robust);
      if (robustDiff !== 0) return robustDiff;
      const aFlip = a.flipDistance ?? Infinity;
      const bFlip = b.flipDistance ?? Infinity;
      if (aFlip !== bFlip) return bFlip - aFlip;
      if ((a.margin ?? 0) !== (b.margin ?? 0)) return (b.margin ?? 0) - (a.margin ?? 0);
      return a.tokenCount - b.tokenCount;
    });
    const best = contenders[0] ?? null;
    const recommendation = best
      ? {
          name: best.name,
          phrase: best.phrase,
          reason: `Elects "${best.winner}" ${best.robust ? 'robustly (no single word can flip it)' : 'with the strongest available footing'}${
            best.flipDistance === null ? ', unflippable by any single-token reweighting' : `, nearest flip at ${best.flipDistance}`
          }, margin ${best.margin}, ${best.tokenCount} token(s).`,
        }
      : null;

    const interpretation: string[] = [];
    interpretation.push(
      agreed
        ? `All ${rankable.length} rankable phrasing(s) elect the same target${consensusWinner ? ` ("${consensusWinner}")` : ''} — the intent is unambiguous on this page; pick the cheapest robust phrasing.`
        : `Phrasings DISAGREE on the target (${winnerIds.length} distinct winners across ${rankable.length} phrasings) — the intent is ambiguous on this page. That is the finding: quote the exact label of the element you mean.`
    );
    if (recommendation) {
      interpretation.push(`Recommended phrasing: ${recommendation.phrase} — ${recommendation.reason}`);
    } else {
      interpretation.push('No phrasing produced a scoring winner — the intent matches nothing actionable on this page.');
    }
    const weakest = rankable.filter((v) => v.robust === false);
    if (weakest.length > 0 && agreed) {
      interpretation.push(`Fragile phrasing(s) to avoid: ${weakest.map((v) => v.name).join(', ')} — a single word carries each.`);
    }

    this.saveMicroSnapshot('intent_experiment', {
      intent: intent.slice(0, 100),
      variantsTested: variants.length,
      agreed,
      recommended: recommendation?.phrase.slice(0, 100) ?? null,
    });

    return {
      intent,
      variants: variants.map(({ winnerId: _winnerId, ...v }) => v),
      consensus: {
        agreed,
        winner: consensusWinner,
        distinctWinners: winnerIds.map((id) => rankable.find((v) => v.winnerId === id)?.winner ?? id).filter((w): w is string => w !== null),
      },
      recommendation,
      interpretation,
      method:
        'Each phrasing is tokenized and ranked by the real production scorer against the live page (compile-time only; nothing executes), ' +
        'then measured in its J-space: margin, robustness to token deletion, flip-boundary distance, and softmax confidence. ' +
        'Variants are deterministic rewrites (optimizer, inert-token strip, exact-label quote) plus any caller-supplied phrasings.',
      ephemeral: true,
    };
  }

  /**
   * Chain-of-thought behavior report: reconstructs what the agent observed,
   * decided, and did this session, scores action quality and observation
   * economy, and emits prioritized self-improvement recommendations. Written
   * as machine-readable JSON (feed it back to the agent at the start of the
   * next run — or mid-run on long traversals) plus a markdown rendering.
   */
  generateBehaviorReport(): { digest: BehaviorReportDigest; jsonPath: string; markdownPath: string } {
    const digest = buildBehaviorReport({
      events: this.behaviorLog,
      metrics: this.metrics,
      journalStats: this.journalStatsProvider ? (this.journalStatsProvider() as BehaviorReportDigest['journal']) : undefined,
      recoveryMemoryStats: this.recoveryMemory ? { totalPatterns: this.recoveryMemory.getStats().totalPatterns } : undefined,
    });
    const behaviorDir = path.join(this.spliceDir, 'behavior');
    fs.mkdirSync(behaviorDir, { recursive: true });
    const stamp = Date.now();
    const jsonPath = path.join(behaviorDir, `behavior-${stamp}.json`);
    const markdownPath = path.join(behaviorDir, `behavior-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(digest, null, 2), { mode: 0o600 });
    fs.writeFileSync(markdownPath, renderBehaviorMarkdown(digest), { mode: 0o600 });
    this.pushLiveFeed('behavior_report', `${digest.episodes.length} episode(s), ${digest.selfImprovement.length} recommendation(s)`);
    return { digest, jsonPath, markdownPath };
  }

  /**
   * The live J-space map: every decision this session, aggregated into its
   * decision geometry — dimensionality, carrying concepts, fragility,
   * recurring dead-weight tokens, recommendations, and the hazard-detector
   * summary. Reads the in-memory map; persists nothing.
   */
  getJSpaceMap(): JSpaceMapReport {
    return {
      ...this.jSpaceMap.buildReport(),
      hazards: this.jSpaceDetector.summarize(this.jSpaceMap.all()),
    };
  }

  /**
   * The J-space detector's session log: every hazard found in decision
   * geometry (near-ties, aliased candidates, boundary proximity, concept
   * conflicts, …) plus live session-trend detections (unstable targets,
   * fragility streaks, chronic ambiguity). Advisory only — detections attach
   * to plan evidence but never block or rescore an action.
   */
  getJSpaceDetections(options: { severity?: 'all' | 'warning' | 'critical'; limit?: number } = {}): DetectionSummary & { ephemeral: true } {
    const limit = Math.max(1, Math.min(50, options.limit ?? 10));
    const summary = this.jSpaceDetector.summarize(this.jSpaceMap.all(), 50);
    const recent =
      options.severity === 'critical'
        ? summary.recent.filter((d) => d.severity === 'critical')
        : options.severity === 'warning'
          ? summary.recent.filter((d) => d.severity !== 'info')
          : summary.recent;
    return { ...summary, recent: recent.slice(0, limit), ephemeral: true };
  }

  /**
   * Persist the session's J-space map to .splice/jspace/ as JSON + markdown —
   * the same pattern as behavior reports. Called on demand (get_jspace_map
   * with persist: true) and automatically at session close, so every session
   * that compiled at least one action leaves a decision-geometry report behind.
   */
  generateJSpaceReport(): { report: JSpaceMapReport; jsonPath: string; markdownPath: string } {
    const report = this.getJSpaceMap();
    const jspaceDir = path.join(this.spliceDir, 'jspace');
    fs.mkdirSync(jspaceDir, { recursive: true });
    const stamp = Date.now();
    const jsonPath = path.join(jspaceDir, `jspace-${stamp}.json`);
    const markdownPath = path.join(jspaceDir, `jspace-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.writeFileSync(markdownPath, renderJSpaceMapMarkdown(report), { mode: 0o600 });
    this.jSpaceReportWrittenAt = stamp;
    this.pushLiveFeed('jspace_report', `${report.observations} decision(s) mapped, ${report.recommendations.length} recommendation(s)`);
    return { report, jsonPath, markdownPath };
  }

  /**
   * Train of thought: the session's cognition events reconstructed as a typed
   * thinking transcript (observe → believe → decide → act → verify), each
   * decision annotated with its J-space why and any geometry hazards, plus
   * thinking-pattern analysis (blind retries, thought loops, dithering,
   * hesitation, unverified streaks) and a ranked chain-of-thinking
   * optimization plan merging every introspection engine's advice. Persisted
   * to .splice/thought/ as JSON + markdown, like the other reports.
   */
  /** Build the live train-of-thought report without persisting anything —
   *  shared by generateThoughtReport (which persists) and the dashboard. */
  private buildThoughtNow(maxSteps = 200): TrainOfThoughtReport {
    const digest = buildBehaviorReport({
      events: this.behaviorLog,
      metrics: this.metrics,
      journalStats: this.journalStatsProvider ? (this.journalStatsProvider() as BehaviorReportDigest['journal']) : undefined,
      recoveryMemoryStats: this.recoveryMemory ? { totalPatterns: this.recoveryMemory.getStats().totalPatterns } : undefined,
    });
    const mapReport = this.jSpaceMap.buildReport();
    return buildTrainOfThought(
      {
        events: this.behaviorLog,
        observations: this.jSpaceMap.all(),
        hazards: this.jSpaceDetector.summarize(this.jSpaceMap.all(), 50),
        calibration: digest.calibration,
        behaviorRecommendations: digest.selfImprovement,
        mapRecommendations: mapReport.recommendations,
      },
      Math.max(20, Math.min(500, maxSteps))
    );
  }

  generateThoughtReport(options: { maxSteps?: number } = {}): { report: TrainOfThoughtReport; jsonPath: string; markdownPath: string } {
    const report = this.buildThoughtNow(options.maxSteps ?? 200);
    const thoughtDir = path.join(this.spliceDir, 'thought');
    fs.mkdirSync(thoughtDir, { recursive: true });
    const stamp = Date.now();
    const jsonPath = path.join(thoughtDir, `thought-${stamp}.json`);
    const markdownPath = path.join(thoughtDir, `thought-${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.writeFileSync(markdownPath, renderTrainOfThoughtMarkdown(report), { mode: 0o600 });
    this.thoughtReportWrittenAt = stamp;
    this.pushLiveFeed('thought_report', `${report.stepCount} step(s), ${report.optimizations.length} optimization(s)`);
    return { report, jsonPath, markdownPath };
  }

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
        const jspace = ${toJs(this.getJSpaceMap())};
        const calibration = ${toJs(this.getCalibration())};
        const thought = ${toJs((() => { const t = this.buildThoughtNow(60); return { ...t, stream: t.stream.slice(-5) }; })())};

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
        const statTokens = document.getElementById('stat-tokens');
        if (statTokens) {
          const saved = metrics.tokensSavedEstimate ?? 0;
          statTokens.textContent = saved >= 10000 ? \`\${Math.round(saved / 1000)}k\` : String(saved);
          statTokens.title = \`~\${saved} tokens saved by pruning and deltas; ~\${metrics.redundantObservationTokens ?? 0} re-sent by unchanged full reads\`;
        }
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

        // ─── J-Space Map (session decision geometry) ─────────────────────
        const jspaceEl = document.getElementById('jspace-map');
        if (jspaceEl) {
          if (!jspace.observations) {
            jspaceEl.innerHTML = empty('No decisions mapped yet — the map fills itself as compile_verified_action and run_jacobian_lens run.');
          } else {
            const traj = jspace.trajectory || [];
            const maxDim = Math.max(1, ...traj.map(p => p.effectiveDimension || 0));
            const bars = traj.map(p => {
              const height = Math.max(8, Math.round(((p.effectiveDimension || 0.4) / maxDim) * 100));
              const cls = (p.flipDistance != null && p.flipDistance <= 0.5) ? 'boundary' : (!p.robust ? 'fragile' : '');
              const conf = p.winnerProbability != null ? ' · conf ' + Math.round(p.winnerProbability * 100) + '%' : '';
              const dim = p.effectiveDimension != null ? ' · dim ' + p.effectiveDimension : '';
              return \`<div class="jspace-bar \${cls}" style="height:\${height}%" title="\${esc(p.intent)} → \${esc(p.winner)}\${dim}\${conf}"></div>\`;
            }).join('');
            const statVal = (value, warn) => \`<span class="tax-value \${warn ? 'nonzero' : 'zero'}">\${esc(String(value))}</span>\`;
            const stats = [
              \`<div class="tax-row"><span class="tax-label">Decisions Mapped</span>\${statVal(jspace.observations, false)}</div>\`,
              \`<div class="tax-row"><span class="tax-label">Mean Effective Dimension</span>\${statVal(jspace.dimensionality ? jspace.dimensionality.mean : '—', false)}</div>\`,
              \`<div class="tax-row"><span class="tax-label">Mean Winner Confidence</span>\${statVal(jspace.confidence ? Math.round(jspace.confidence.mean * 100) + '%' : '—', jspace.confidence ? jspace.confidence.mean < 0.5 : false)}</div>\`,
              \`<div class="tax-row"><span class="tax-label">Robust Choices</span>\${statVal(jspace.fragility.robustDecisions + '/' + jspace.observations, jspace.fragility.fragileDecisions > 0)}</div>\`,
              \`<div class="tax-row"><span class="tax-label">Near Flip Boundary</span>\${statVal(jspace.fragility.nearBoundary.length, jspace.fragility.nearBoundary.length > 0)}</div>\`,
            ].join('');
            const maxSens = Math.max(1e-9, ...jspace.conceptLeaderboard.map(c => c.meanAbsSensitivity));
            const concepts = jspace.conceptLeaderboard.slice(0, 6).map(c => \`
              <div>
                <div class="tax-row"><span class="tax-label">\${esc(c.concept)}</span><span class="tax-value zero">\${c.meanAbsSensitivity} · dominant ×\${c.timesDominant}</span></div>
                <div class="conf-bar"><div class="conf-fill" style="width:\${Math.max(4, Math.round((c.meanAbsSensitivity / maxSens) * 100))}%"></div></div>
              </div>
            \`).join('');
            const fragileCards = jspace.fragility.nearBoundary.slice(0, 3).map(f => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(f.intent)}</div>
                  <div class="tag amber">flip @ \${f.distance}</div>
                </div>
                <div class="card-body">Chose "\${esc(f.winner)}" — reweighting "\${esc(f.token)}" flips it\${f.rival ? ' to "' + esc(f.rival) + '"' : ''}.</div>
              </div>
            \`).join('');
            const recs = (jspace.recommendations || []).slice(0, 3).map(r => \`<div class="agent-directive">\${esc(r)}</div>\`).join('');
            jspaceEl.innerHTML = \`
              <div class="jspace-panel">\${stats}</div>
              <div class="jspace-panel">
                <div class="jspace-strip">\${bars}</div>
                <div class="jspace-legend">
                  <span><b>bars</b> effective dimension per decision, oldest → newest</span>
                  <span style="color:var(--amber)">■ fragile</span>
                  <span style="color:var(--red)">■ near flip boundary</span>
                </div>
              </div>
              \${concepts ? \`<div class="jspace-panel"><div class="jspace-legend"><b>concept leaderboard</b> mean |∂P(winner)| per axis</div>\${concepts}</div>\` : ''}
              \${fragileCards}
              \${recs}
            \`;
          }
        }

        // ─── Confidence Calibration (does confidence track outcomes?) ────
        const calEl = document.getElementById('calibration-feed');
        if (calEl) {
          if (!calibration.samples) {
            calEl.innerHTML = empty('No executed actions to calibrate yet — calibration builds as verified actions run.');
          } else {
            const gapPts = Math.round((calibration.calibrationGap ?? 0) * 100);
            const verdictTag = calibration.verdict === 'well-calibrated' ? 'green' : calibration.verdict === 'insufficient-data' ? 'blue' : 'amber';
            const bandRows = calibration.bands.filter(b => b.count > 0).map(b => \`
              <div>
                <div class="tax-row"><span class="tax-label">\${esc(b.band)} stated</span><span class="tax-value zero">\${b.count} action(s) · \${b.passRate !== null ? Math.round(b.passRate * 100) + '% verified' : 'n/a'}</span></div>
                <div class="conf-bar"><div class="conf-fill \${b.passRate !== null && b.passRate < 0.5 ? 'verylow' : b.passRate !== null && b.passRate < 0.8 ? 'low' : ''}" style="width:\${Math.round((b.passRate ?? 0) * 100)}%"></div></div>
              </div>
            \`).join('');
            const surpriseCards = calibration.surprises.slice(0, 2).map(s => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(s.intent)}</div>
                  <div class="tag red">\${Math.round(s.confidence * 100)}% → failed</div>
                </div>
                <div class="card-body">Compiled confident, failed verification\${s.expectedOutcome ? ' — expected: ' + esc(s.expectedOutcome) : ''}.</div>
              </div>
            \`).join('');
            calEl.innerHTML = \`
              <div class="jspace-panel">
                <div class="tax-row"><span class="tax-label">Verdict</span><span class="tax-value \${verdictTag === 'green' ? 'zero' : 'nonzero'}"><span class="tag \${verdictTag}">\${esc(calibration.verdict)}</span></span></div>
                <div class="tax-row"><span class="tax-label">Executed Actions</span><span class="tax-value zero">\${calibration.samples}</span></div>
                <div class="tax-row"><span class="tax-label">Brier Score</span><span class="tax-value zero">\${calibration.brierScore ?? '—'}</span></div>
                <div class="tax-row"><span class="tax-label">Confidence − Pass Rate</span><span class="tax-value \${Math.abs(gapPts) > 15 ? 'nonzero' : 'zero'}">\${gapPts > 0 ? '+' : ''}\${gapPts}pt</span></div>
                \${bandRows}
              </div>
              \${surpriseCards}
            \`;
          }
        }

        // ─── J-Space Detector (hazards in decision geometry) ─────────────
        const detectorEl = document.getElementById('jspace-detector-feed');
        if (detectorEl) {
          const hz = jspace.hazards;
          if (!hz || (hz.total === 0 && hz.sessionTrends.length === 0)) {
            detectorEl.innerHTML = \`<div class="empty" style="color:var(--green);border-color:rgba(65,230,162,0.2)">✓ No hazards detected — decision geometry has been clean.</div>\`;
          } else {
            const sevTag = (s) => s === 'critical' ? 'red' : s === 'warning' ? 'amber' : 'blue';
            const meter = \`
              <div class="jspace-panel">
                <div class="tax-row"><span class="tax-label">Critical</span><span class="tax-value \${hz.bySeverity.critical > 0 ? 'nonzero' : 'zero'}">\${hz.bySeverity.critical}</span></div>
                <div class="tax-row"><span class="tax-label">Warning</span><span class="tax-value \${hz.bySeverity.warning > 0 ? 'nonzero' : 'zero'}">\${hz.bySeverity.warning}</span></div>
                <div class="tax-row"><span class="tax-label">Info</span><span class="tax-value zero">\${hz.bySeverity.info}</span></div>
                \${hz.sessionTrends.length ? \`<div class="tax-row"><span class="tax-label">Session Trends</span><span class="tax-value nonzero">\${hz.sessionTrends.length}</span></div>\` : ''}
              </div>
            \`;
            const cards = [...hz.sessionTrends, ...hz.recent].slice(0, 4).map(d => \`
              <div class="info-card">
                <div class="card-head">
                  <div class="card-title">\${esc(d.title)}</div>
                  <div class="tag \${sevTag(d.severity)}">\${esc(d.severity)}</div>
                </div>
                <div class="card-body">\${esc(d.recommendation)}</div>
              </div>
            \`).join('');
            detectorEl.innerHTML = meter + cards;
          }
        }

        // ─── Train of Thought (thinking shape + optimization) ────────────
        const thoughtEl = document.getElementById('thought-feed');
        if (thoughtEl) {
          if (!thought.stepCount) {
            thoughtEl.innerHTML = empty('No cognition events yet — the train of thought builds as the agent works.');
          } else {
            const palette = { observe: 'var(--blue)', believe: 'var(--amber)', decide: 'var(--purple)', act: 'var(--green)', verify: 'var(--brand-a)', wait: 'var(--quiet)', recover: 'var(--red)', introspect: 'var(--muted)' };
            const active = Object.entries(thought.tempo.shares).filter(([, v]) => v > 0);
            const segs = active.map(([k, v]) => \`<div class="thought-seg" style="flex:\${v};background:\${palette[k] || 'var(--quiet)'}" title="\${esc(k)} \${Math.round(v * 100)}%"></div>\`).join('');
            const legend = active.map(([k, v]) => \`<span><b style="color:\${palette[k] || 'var(--quiet)'}">■</b> \${esc(k)} \${Math.round(v * 100)}%</span>\`).join('');
            const chips = thought.patterns.map(p => \`<span class="tag \${p.severity === 'good' ? 'green' : p.severity === 'high' ? 'red' : 'amber'}">\${esc(p.pattern)} ×\${p.occurrences}</span>\`).join('');
            const opts = thought.optimizations.slice(0, 3).map(o => \`<div class="agent-directive">\${o.rank}. [\${esc(o.priority)}] \${esc(o.change)}</div>\`).join('');
            const lastSteps = thought.stream.map(s => \`<div class="log-line"><div class="mono">\${esc(s.kind)}</div><div class="log-msg">\${esc(s.summary)}</div></div>\`).join('');
            thoughtEl.innerHTML = \`
              <div class="jspace-panel">
                <div class="thought-bar">\${segs}</div>
                <div class="jspace-legend">\${legend}</div>
                <div class="jspace-legend">tempo \${thought.tempo.eventsPerMinute} thought(s)/min · \${thought.stepCount} step(s) this session</div>
              </div>
              \${chips ? \`<div class="jspace-panel"><div class="jspace-legend"><b>thinking patterns</b></div><div style="display:flex;flex-wrap:wrap;gap:6px">\${chips}</div></div>\` : ''}
              \${opts}
              \${lastSteps ? \`<div class="jspace-panel"><div class="jspace-legend"><b>latest thoughts</b></div>\${lastSteps}</div>\` : ''}
            \`;
          }
        }

        const deltaFeed = document.getElementById('delta-feed');
        const deltas = microSnapshots.filter(s => s.type === 'semantic_delta').slice(0, 4);
        if (deltaFeed) {
          deltaFeed.innerHTML = deltas.length
            ? deltas.map(d => {
              const mutations = (d.added ?? 0) + (d.removed ?? 0) + (d.changed ?? 0);
              const kind = d.urlChanged ? 'navigation' : (mutations ? 'mutation' : 'stable');
              const details = [
                (d.addedSample || []).length ? \`New: \${d.addedSample.map(esc).join(', ')}.\` : '',
                (d.removedSample || []).length ? \`Removed: \${d.removedSample.map(esc).join(', ')}.\` : '',
                (d.changedSample || []).length ? \`Changed: \${d.changedSample.map(esc).join(' | ')}.\` : '',
              ].filter(Boolean).join(' ');
              return \`
                <div class="info-card">
                  <div class="card-head">
                    <div class="card-title">\${esc(d.summary || 'State change')}</div>
                    <div class="tag \${kind === 'navigation' ? 'blue' : (kind === 'mutation' ? 'amber' : 'green')}">\${kind}</div>
                  </div>
                  <div class="card-body">\${details || 'No element-level changes since the previous snapshot.'}</div>
                </div>
              \`;
            }).join('')
            : empty('Call get_semantic_tree_optimized with deltaOnly: true to record incremental state changes.');
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
                      \${p.tokensReturnedEstimate ? \`<span>tokens <b>\${p.tokensReturnedEstimate}</b></span>\` : ''}
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

  /**
   * Deterministic WCAG audit of the active page. Findings are worst-first
   * with per-rule fix guidance; the report also explains how each failure
   * class degrades agent operation (unlabeled controls break label-based
   * targeting, nameless buttons vanish from intent ranking).
   */
  async runAccessibilityAudit(): Promise<A11yAuditReport> {
    await this.ensureHealthy();
    const page = this.getActivePage();

    const raw = await page.evaluate(() => {
      const findings: Array<{ rule: string; element: string; detail: string; fix: string }> = [];
      const describe = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const name = el.getAttribute('name');
        const text = (el as HTMLElement).innerText?.trim().slice(0, 40);
        return `<${tag}${id}${name ? ` name="${name}"` : ''}>${text ? ` "${text}"` : ''}`;
      };
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };

      // image-alt: informative images must describe themselves (alt="" opts out).
      for (const img of Array.from(document.querySelectorAll('img'))) {
        if (!img.hasAttribute('alt') && isVisible(img)) {
          findings.push({
            rule: 'image-alt',
            element: describe(img) + (img.src ? ` src="${img.src.slice(0, 60)}"` : ''),
            detail: 'Image has no alt attribute.',
            fix: 'Add alt text describing the image, or alt="" if purely decorative.',
          });
        }
      }

      // control-label: every visible form control needs a programmatic label.
      for (const control of Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'))) {
        if (!isVisible(control)) continue;
        const labelled =
          (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) ||
          control.closest('label') ||
          control.getAttribute('aria-label') ||
          control.getAttribute('aria-labelledby') ||
          control.getAttribute('title');
        if (!labelled) {
          findings.push({
            rule: 'control-label',
            element: describe(control),
            detail: 'Form control has no programmatic label (label[for], wrapping label, aria-label, aria-labelledby, or title).',
            fix: 'Associate a <label for> with the control, or add aria-label.',
          });
        }
      }

      // accessible-name: buttons and links must expose a name.
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"]'))) {
        if (!isVisible(el)) continue;
        const name =
          el.innerText?.trim() ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('title') ||
          el.querySelector('img[alt]')?.getAttribute('alt')?.trim() ||
          (el as HTMLInputElement).value;
        if (!name) {
          findings.push({
            rule: 'accessible-name',
            element: describe(el),
            detail: 'Interactive element has no accessible name.',
            fix: 'Add visible text, aria-label, or alt text on the contained image.',
          });
        }
      }

      // document-language / document-title.
      if (!document.documentElement.getAttribute('lang')) {
        findings.push({
          rule: 'document-language',
          element: '<html>',
          detail: 'The document has no lang attribute.',
          fix: 'Set <html lang="…"> to the page language.',
        });
      }
      if (!document.title || document.title.trim().length === 0) {
        findings.push({
          rule: 'document-title',
          element: '<title>',
          detail: 'The document has no title.',
          fix: 'Give the page a descriptive <title>.',
        });
      }

      // heading-order: start at h1, never skip down more than one level.
      const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).filter(isVisible);
      let previousLevel = 0;
      for (const heading of headings) {
        const level = Number(heading.tagName[1]);
        if ((previousLevel === 0 && level !== 1) || (previousLevel > 0 && level > previousLevel + 1)) {
          findings.push({
            rule: 'heading-order',
            element: describe(heading),
            detail: previousLevel === 0
              ? `First heading is <h${level}>; documents should begin at <h1>.`
              : `Heading level jumps from <h${previousLevel}> to <h${level}>.`,
            fix: 'Keep heading levels sequential so the document outline is navigable.',
          });
        }
        previousLevel = level;
      }

      // color-contrast: WCAG AA ratio on visible text with resolvable backgrounds.
      const luminance = (rgb: string): number | null => {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return null;
        if (m[4] !== undefined && Number(m[4]) < 1) return null; // translucent — skip, cannot resolve
        const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const effectiveBackground = (el: Element): number | null => {
        let node: Element | null = el;
        while (node) {
          const bg = window.getComputedStyle(node).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return luminance(bg);
          node = node.parentElement;
        }
        return luminance('rgb(255, 255, 255)'); // browser default canvas
      };
      const textElements = Array.from(document.querySelectorAll<HTMLElement>('p, span, a, button, label, li, td, th, h1, h2, h3, h4, h5, h6, div'))
        .filter((el) => isVisible(el) && el.childElementCount === 0 && (el.innerText?.trim().length ?? 0) > 0)
        .slice(0, 200);
      for (const el of textElements) {
        const style = window.getComputedStyle(el);
        const fg = luminance(style.color);
        const bg = effectiveBackground(el);
        if (fg === null || bg === null) continue;
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        const fontSize = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const isLarge = fontSize >= 24 || (fontSize >= 18.66 && bold);
        const required = isLarge ? 3 : 4.5;
        if (ratio < required) {
          findings.push({
            rule: 'color-contrast',
            element: describe(el),
            detail: `Contrast ratio ${ratio.toFixed(2)}:1 is below the ${required}:1 minimum for this text size.`,
            fix: 'Darken the text or lighten the background until the ratio meets WCAG AA.',
          });
        }
      }

      // positive-tabindex: authors must not fight the natural focus order.
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('[tabindex]'))) {
        const tabindex = Number(el.getAttribute('tabindex'));
        if (Number.isFinite(tabindex) && tabindex > 0) {
          findings.push({
            rule: 'positive-tabindex',
            element: describe(el),
            detail: `tabindex="${tabindex}" overrides the natural focus order.`,
            fix: 'Use tabindex="0" and let DOM order define focus sequence.',
          });
        }
      }

      // duplicate-id: repeated ids break label[for] and ARIA references.
      const seen = new Map<string, number>();
      for (const el of Array.from(document.querySelectorAll('[id]'))) {
        seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
      }
      for (const [id, count] of seen) {
        if (count > 1) {
          findings.push({
            rule: 'duplicate-id',
            element: `#${id}`,
            detail: `id "${id}" appears ${count} times.`,
            fix: 'Make ids unique — duplicates break label associations and ARIA references.',
          });
        }
      }

      // aria-hidden-focus: hidden-from-AT subtrees must not contain focusables.
      for (const hidden of Array.from(document.querySelectorAll('[aria-hidden="true"]'))) {
        const focusable = hidden.querySelector('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable && isVisible(focusable)) {
          findings.push({
            rule: 'aria-hidden-focus',
            element: describe(focusable),
            detail: 'Focusable element inside an aria-hidden="true" subtree.',
            fix: 'Remove aria-hidden, or make descendants unfocusable (tabindex="-1", disabled).',
          });
        }
      }

      return { findings, url: window.location.href, title: document.title };
    });

    const findings = sortFindings(
      raw.findings.map((f) => ({
        ...f,
        wcag: A11Y_RULES[f.rule]?.wcag ?? 'WCAG',
        severity: A11Y_RULES[f.rule]?.severity ?? 'moderate',
      }))
    );
    const report = summarizeAudit(raw.url, raw.title, findings);
    this.saveMicroSnapshot('accessibility_audit', {
      url: report.url,
      score: report.score,
      findings: report.findings.length,
      bySeverity: report.bySeverity,
    });
    return report;
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
    // Session-end reports: every session that mapped at least one decision
    // leaves its geometry AND its train of thought behind for the next run
    // to read. Skipped when nothing new happened since the last persist.
    const lastMapped = this.jSpaceMap.lastObservedAt;
    if (lastMapped !== null && lastMapped > this.jSpaceReportWrittenAt) {
      try {
        this.generateJSpaceReport();
      } catch (e) {
        console.error('[Splice] J-space session report failed:', errorMessage(e));
      }
    }
    const lastThought = this.behaviorLog.length > 0 ? this.behaviorLog[this.behaviorLog.length - 1].timestamp : null;
    if (this.behaviorLog.length >= 5 && lastThought !== null && lastThought > this.thoughtReportWrittenAt) {
      try {
        this.generateThoughtReport();
      } catch (e) {
        console.error('[Splice] Train-of-thought session report failed:', errorMessage(e));
      }
    }
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

/**
 * Token efficiency: trim a verified action plan to what an agent needs to
 * decide its next step — the ranked plan, confidence/risk, the outcome
 * forecast, and the verification verdict with a delta summary. Alternatives,
 * compile-time evidence, and the full delta are dropped. Used by the
 * compile_verified_action tool when compact: true is requested.
 */
export function compactVerifiedPlan(plan: VerifiedActionPlan): Record<string, unknown> {
  const slim: Record<string, unknown> = {
    intent: plan.intent,
    confidence: plan.confidence,
    risk: plan.risk,
    plan: plan.plan,
  };
  if (plan.expectedOutcome) slim.expectedOutcome = plan.expectedOutcome;
  if (plan.targetPreview) slim.targetPreview = plan.targetPreview;
  if (plan.actionId) slim.actionId = plan.actionId;
  if (plan.needsClarification) {
    slim.needsClarification = true;
    slim.clarification = plan.clarification;
  }
  if (plan.verification) {
    slim.verification = {
      executed: plan.verification.executed,
      passed: plan.verification.passed,
      evidence: plan.verification.evidence.slice(0, 3),
      ...(plan.verification.expectations ? { expectations: plan.verification.expectations } : {}),
    };
  }
  if (plan.delta) slim.deltaSummary = plan.delta.summary;
  return slim;
}
