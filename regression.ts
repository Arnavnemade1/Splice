#!/usr/bin/env node
/**
 * Regression suite over the synthetic fixture pack (fixtures/pages.ts).
 *
 * Each block replays a known failure pattern — dynamic menus, async form
 * validation, skeleton screens, framework re-mount churn, stacked overlays —
 * and asserts that Splice's cognition APIs (diagnoseAgentState, waitFor,
 * fillForm, compileVerifiedAction, getSemanticDelta, assertPageState) handle
 * it the way agents depend on. Run with `npm run test:regression`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserManager } from './src/BrowserManager.js';
import { startSyntheticFixtureServer } from './fixtures/pages.js';

type Result = { name: string; status: 'PASS' | 'FAIL'; detail: string };
const results: Result[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail: detail || '' });
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  } catch (error: any) {
    results.push({ name, status: 'FAIL', detail: error?.message || String(error) });
    console.error(`FAIL ${name} - ${error?.message || error}`);
  }
}

async function main() {
  const fixture = await startSyntheticFixtureServer();
  const browser = new BrowserManager();

  try {
    await step('Regression: browser initialization', async () => {
      await browser.init();
      return `fixture pack at ${fixture.url}`;
    });

    // ── Dynamic menus: items enter the DOM only after the trigger is clicked ──

    await step('Dynamic menu: submenu items are absent before the trigger is clicked', async () => {
      await browser.navigate(`${fixture.url}/menu`);
      const tree = await browser.getSemanticTree('open products menu', 'UX');
      const serialized = JSON.stringify(tree);
      if (serialized.includes('Quarterly reports')) throw new Error('Closed menu leaked its items into the semantic tree.');
      if (!serialized.includes('Products')) throw new Error('Menu trigger missing from the semantic tree.');
      return 'closed menu hides items; trigger visible';
    });

    await step('Dynamic menu: late-rendered items are observable via wait_for', async () => {
      const plan = await browser.compileVerifiedAction({ intent: 'click "Products"', execute: true });
      if (!plan.verification?.executed) throw new Error('Menu trigger click was not executed.');
      const wait = await browser.waitFor([{ kind: 'text_present', value: 'quarterly reports' }], { timeoutMs: 4000, pollIntervalMs: 100 });
      if (!wait.satisfied) throw new Error(`Menu items never became observable (timedOut: ${wait.timedOut}).`);
      const visible = await browser.assertPageState([
        { kind: 'element_visible', value: 'quarterly reports' },
        { kind: 'element_visible', value: 'billing exports' },
      ]);
      if (!visible.passed) throw new Error(`Late menu items not visible after wait: ${visible.summary}`);
      return `menu items observable after ${wait.elapsedMs}ms (${wait.pollCount} polls)`;
    });

    await step('Dynamic menu: clicking a late-rendered item verifies its declared postcondition', async () => {
      const plan = await browser.compileVerifiedAction({
        intent: 'click "Quarterly reports"',
        execute: true,
        constraints: { noNavigationOutsideDomain: true },
        expect: [
          { kind: 'url_contains', value: '/menu/reports' },
          { kind: 'text_present', value: 'Quarterly reports archive' },
        ],
      });
      if (!plan.verification?.executed || !plan.verification.passed) {
        throw new Error(`Late menu item click did not verify: ${JSON.stringify(plan.verification)}`);
      }
      return 'late-rendered menuitem clicked; url + content postconditions held';
    });

    // ── Form validation: async availability checks and gated submits ──

    await step('Form validation: pristine required form diagnoses as validation_blocked', async () => {
      await browser.navigate(`${fixture.url}/form`);
      const diagnosis = await browser.diagnoseAgentState('create account', ['navigate signup']);
      if (diagnosis.state !== 'validation_blocked') throw new Error(`Expected validation_blocked, got ${diagnosis.state}.`);
      if (diagnosis.signals.disabledControls < 1) throw new Error('Disabled submit was not counted.');
      return `${diagnosis.state} with ${diagnosis.signals.disabledControls} disabled control(s)`;
    });

    await step('Form validation: async server rejection surfaces and keeps the form blocked', async () => {
      const report = await browser.fillForm({
        fields: [
          { field: 'work email', value: 'taken@example.com' },
          { field: 'choose password', value: 'short' },
        ],
      });
      if (report.filledCount !== 2) throw new Error(`Expected both fields filled, got ${report.filledCount}.`);
      const rejected = await browser.waitFor([{ kind: 'text_present', value: 'already registered' }], { timeoutMs: 3000, pollIntervalMs: 100 });
      if (!rejected.satisfied) throw new Error('Async availability rejection never surfaced.');
      const state = await browser.assertPageState([
        { kind: 'text_present', value: 'already registered' },
        { kind: 'text_present', value: 'at least 8 characters' },
      ]);
      if (!state.passed) throw new Error(`Validation errors not visible: ${state.summary}`);
      const diagnosis = await browser.diagnoseAgentState('create account');
      if (diagnosis.state !== 'validation_blocked') throw new Error(`Expected validation_blocked after rejection, got ${diagnosis.state}.`);
      if (diagnosis.signals.invalidFields < 1) throw new Error('aria-invalid fields were not counted.');
      return `server rejection + short password diagnosed: ${diagnosis.signals.invalidFields} invalid field(s)`;
    });

    await step('Form validation: fill_form refuses to submit a still-blocked form', async () => {
      const report = await browser.fillForm({
        fields: [{ field: 'confirm password', value: 'different-value' }],
        submitIntent: 'click "Create account"',
      });
      if (report.submit?.executed) throw new Error('A blocked form must not be submitted.');
      if (report.submit?.reason !== 'not_submittable') throw new Error(`Expected not_submittable, got ${report.submit?.reason}.`);
      return 'submit honestly withheld while validation is failing';
    });

    await step('Form validation: valid values unlock and verify the submit', async () => {
      await browser.navigate(`${fixture.url}/form`);
      const report = await browser.fillForm({
        fields: [
          { field: 'work email', value: 'fresh@example.com' },
          { field: 'choose password', value: 'correct-horse-9' },
          { field: 'confirm password', value: 'correct-horse-9' },
          { field: 'agree to terms', value: 'yes' },
        ],
      });
      if (report.filledCount !== 4) throw new Error(`Expected 4 filled fields, got ${report.filledCount}: ${JSON.stringify(report.fields)}`);
      const available = await browser.waitFor([{ kind: 'text_present', value: 'email available' }], { timeoutMs: 3000, pollIntervalMs: 100 });
      if (!available.satisfied) throw new Error('Async availability approval never surfaced.');
      const plan = await browser.compileVerifiedAction({
        intent: 'click "Create account"',
        execute: true,
        constraints: { noNavigationOutsideDomain: true },
        expect: [
          { kind: 'url_contains', value: '/form/success' },
          { kind: 'text_present', value: 'Account created for fresh@example.com' },
        ],
      });
      if (!plan.verification?.executed || !plan.verification.passed) {
        throw new Error(`Unlocked submit did not verify: ${JSON.stringify(plan.verification)}`);
      }
      return 'async check passed, submit unlocked, postconditions verified';
    });

    // ── Late content: skeleton screens and stalled loads ──

    await step('Late content: skeleton resolves and wait_for observes it', async () => {
      await browser.navigate(`${fixture.url}/late`);
      const wait = await browser.waitFor([{ kind: 'text_present', value: 'team velocity report' }], { timeoutMs: 5000, pollIntervalMs: 150 });
      if (!wait.satisfied) throw new Error(`Late content never appeared (timedOut: ${wait.timedOut}).`);
      if (wait.pollCount < 2) throw new Error(`Expected multiple polls across the 1s skeleton, got ${wait.pollCount}.`);
      return `content in ${wait.elapsedMs}ms over ${wait.pollCount} polls`;
    });

    await step('Late content: incremental load-more appends observable entries', async () => {
      const plan = await browser.compileVerifiedAction({ intent: 'click "Load more entries"', execute: true });
      if (!plan.verification?.executed) throw new Error('Load-more click was not executed.');
      const wait = await browser.waitFor([{ kind: 'text_present', value: 'entry from march' }], { timeoutMs: 3000, pollIntervalMs: 100 });
      if (!wait.satisfied) throw new Error('Appended entry never became observable.');
      return `appended entry observable after ${wait.elapsedMs}ms`;
    });

    await step('Late content: stalled load times out honestly and flags loading indicators', async () => {
      await browser.navigate(`${fixture.url}/late?stall=1`);
      const wait = await browser.waitFor([{ kind: 'text_present', value: 'team velocity report' }], { timeoutMs: 1200, pollIntervalMs: 150 });
      if (wait.satisfied || !wait.timedOut) throw new Error('Stalled skeleton should have timed out.');
      if (!wait.hint) throw new Error('Timeout result is missing its diagnostic hint.');
      const diagnosis = await browser.diagnoseAgentState('read team velocity report');
      if (diagnosis.signals.loadingIndicators < 1) throw new Error(`Stalled spinner was not counted as a loading indicator: ${JSON.stringify(diagnosis.signals)}`);
      return `honest timeout + ${diagnosis.signals.loadingIndicators} loading indicator(s) flagged (state: ${diagnosis.state})`;
    });

    // ── Re-render churn: framework re-mounts must not read as page changes ──

    await step('Re-render churn: re-mounted nodes do not leak into added/removed', async () => {
      await browser.navigate(`${fixture.url}/rerender`);
      await browser.getSemanticTree('catalog baseline', 'UX');
      await sleep(900); // let at least one full re-mount cycle elapse
      const delta = await browser.getSemanticDelta('catalog baseline');
      if ('fullTreeRequired' in delta) throw new Error(`Churn delta fell back to the full tree: ${delta.reason}`);
      const leaked = [...delta.added, ...delta.removed].filter((n) => (n.text || '').includes('Aurora lamp'));
      if (leaked.length > 0) throw new Error(`Re-mounted catalog leaked into added/removed: ${JSON.stringify(leaked)}`);
      const rewritten = (delta.rewrittenIds || []).filter((r) => (r.text || '').includes('Buy the'));
      return rewritten.length > 0
        ? `${rewritten.length} re-mounted node(s) classified as rewrittenIds`
        : 're-mounts produced no add/remove noise';
    });

    await step('Re-render churn: structural deltas suppress ticker text churn', async () => {
      await browser.getSemanticDelta('ticker'); // re-baseline with the ticker in scope
      await sleep(700); // let the ticker mutate a few times
      const structural = await browser.getSemanticDelta('ticker', 'UX', undefined, true);
      if ('fullTreeRequired' in structural) throw new Error('Structural delta fell back to the full tree.');
      if (structural.changed.some((c) => c.field === 'text' && c.after.includes('Ticker tick'))) {
        throw new Error(`Ticker churn was not suppressed: ${JSON.stringify(structural.changed)}`);
      }
      if (!structural.textChangesIgnored) throw new Error('textChangesIgnored counter is missing or zero.');
      return `${structural.textChangesIgnored} ticker mutation(s) suppressed`;
    });

    // ── Overlay stack: modal + cookie banner in front of the primary action ──

    await step('Overlay stack: stacked overlays diagnose as ui_obstruction', async () => {
      await browser.navigate(`${fixture.url}/obstruct`);
      const diagnosis = await browser.diagnoseAgentState('continue to dashboard', ['navigate gateway']);
      if (diagnosis.state !== 'ui_obstruction') throw new Error(`Expected ui_obstruction, got ${diagnosis.state}.`);
      if (diagnosis.signals.obstructiveOverlays < 1) throw new Error('Modal was not counted as an obstructive overlay.');
      return `${diagnosis.state} with ${diagnosis.signals.obstructiveOverlays} overlay(s)`;
    });

    await step('Overlay stack: modal close verifies, banner auto-dismisses, action unblocks', async () => {
      const plan = await browser.compileVerifiedAction({
        intent: 'close newsletter modal',
        execute: true,
        constraints: { avoidDestructiveActions: true },
      });
      if (!plan.verification?.executed || !plan.verification.passed) {
        throw new Error(`Modal close did not verify: ${JSON.stringify(plan.verification)}`);
      }
      await browser.dismissCommonBanners();
      const cleared = await browser.assertPageState([
        { kind: 'text_absent', value: 'join our newsletter' },
        { kind: 'text_absent', value: 'we use cookies' },
        { kind: 'element_visible', value: 'continue to dashboard' },
      ]);
      if (!cleared.passed) throw new Error(`Overlays not fully cleared: ${cleared.summary}`);
      const continuePlan = await browser.compileVerifiedAction({
        intent: 'click "Continue to dashboard"',
        execute: true,
        expect: [{ kind: 'url_contains', value: '/obstruct/dashboard' }],
      });
      if (!continuePlan.verification?.executed || !continuePlan.verification.passed) {
        throw new Error(`Unblocked action did not verify: ${JSON.stringify(continuePlan.verification)}`);
      }
      return 'modal closed, banner dismissed, primary action verified';
    });

    // ── Long-horizon endurance: repeated traversal must stay healthy ──

    const ENDURANCE_CYCLES = 3;
    await step(`Endurance: ${ENDURANCE_CYCLES}-cycle traversal across every fixture stays verified`, async () => {
      for (let cycle = 1; cycle <= ENDURANCE_CYCLES; cycle++) {
        // Dynamic menu journey.
        await browser.navigate(`${fixture.url}/menu`);
        const menuPlan = await browser.compileVerifiedAction({ intent: 'click "Products"', execute: true });
        if (!menuPlan.verification?.executed) throw new Error(`Cycle ${cycle}: menu trigger failed.`);
        const menuWait = await browser.waitFor([{ kind: 'text_present', value: 'quarterly reports' }], { timeoutMs: 4000, pollIntervalMs: 100 });
        if (!menuWait.satisfied) throw new Error(`Cycle ${cycle}: menu items never appeared.`);

        // Form journey with async validation.
        await browser.navigate(`${fixture.url}/form`);
        const form = await browser.fillForm({
          fields: [
            { field: 'work email', value: `agent${cycle}@example.com` },
            { field: 'choose password', value: 'correct-horse-9' },
            { field: 'confirm password', value: 'correct-horse-9' },
            { field: 'agree to terms', value: 'yes' },
          ],
        });
        if (form.filledCount !== 4) throw new Error(`Cycle ${cycle}: form fill degraded to ${form.filledCount}/4.`);
        const avail = await browser.waitFor([{ kind: 'text_present', value: 'email available' }], { timeoutMs: 3000, pollIntervalMs: 100 });
        if (!avail.satisfied) throw new Error(`Cycle ${cycle}: async validation never approved.`);
        const submit = await browser.compileVerifiedAction({
          intent: 'click "Create account"',
          execute: true,
          expect: [{ kind: 'url_contains', value: '/form/success' }],
        });
        if (!submit.verification?.passed) throw new Error(`Cycle ${cycle}: submit stopped verifying.`);

        // Late-content journey.
        await browser.navigate(`${fixture.url}/late`);
        const late = await browser.waitFor([{ kind: 'text_present', value: 'team velocity report' }], { timeoutMs: 5000, pollIntervalMs: 150 });
        if (!late.satisfied) throw new Error(`Cycle ${cycle}: skeleton never resolved.`);

        // Obstruction journey.
        await browser.navigate(`${fixture.url}/obstruct`);
        const modal = await browser.compileVerifiedAction({ intent: 'close newsletter modal', execute: true });
        if (!modal.verification?.passed) throw new Error(`Cycle ${cycle}: modal close stopped verifying.`);
        await browser.dismissCommonBanners();
        const through = await browser.compileVerifiedAction({
          intent: 'click "Continue to dashboard"',
          execute: true,
          expect: [{ kind: 'url_contains', value: '/obstruct/dashboard' }],
        });
        if (!through.verification?.passed) throw new Error(`Cycle ${cycle}: unblocked action stopped verifying.`);
      }

      const health = browser.getRuntimeHealth();
      if (!health.browserConnected) throw new Error('Browser disconnected during endurance run.');
      if (health.browserCrashCount > 0) throw new Error(`Endurance run crashed ${health.browserCrashCount} time(s).`);
      return `${ENDURANCE_CYCLES} cycles × 4 journeys verified; 0 crashes, uptime ${(health.uptimeMs / 1000).toFixed(0)}s`;
    });

    // ── Behavior report: the chain of thought must be reconstructable ──

    await step('Behavior report: chain of thought, scores, and recommendations', async () => {
      const { digest, jsonPath, markdownPath } = browser.generateBehaviorReport();
      if (!fs.existsSync(jsonPath) || !fs.existsSync(markdownPath)) throw new Error('Behavior report files were not written.');

      if (digest.episodes.length < 10) throw new Error(`Expected ≥10 navigation episodes, got ${digest.episodes.length}.`);
      if (!digest.narrative.some((line) => line.includes('executed "click "Products""'))) {
        throw new Error('Narrative does not include the executed menu intent.');
      }
      if (!digest.narrative.some((line) => line.includes('diagnosed validation_blocked'))) {
        throw new Error('Narrative does not include the validation diagnosis.');
      }

      const aq = digest.actionQuality;
      if (aq.plansExecuted < 10) throw new Error(`Expected ≥10 executed plans, got ${aq.plansExecuted}.`);
      if (aq.verificationRate === null || aq.verificationRate < 0.9) {
        throw new Error(`Verification rate degraded: ${JSON.stringify(aq)}`);
      }

      const fa = digest.failureAnalysis;
      if (!fa.diagnosisCounts['validation_blocked'] || !fa.diagnosisCounts['ui_obstruction']) {
        throw new Error(`Failure classes missing from analysis: ${JSON.stringify(fa.diagnosisCounts)}`);
      }
      if (fa.unresolvedAtEnd !== null) throw new Error(`Run ended resolved, but report says unresolved: ${fa.unresolvedAtEnd}.`);

      const oe = digest.observationEconomy;
      if (oe.waitsSatisfied < 5) throw new Error(`Expected ≥5 satisfied waits, got ${oe.waitsSatisfied}.`);
      if (oe.waitsTimedOut < 1) throw new Error('The stalled-load timeout is missing from the wait ledger.');

      if (digest.selfImprovement.length < 1) throw new Error('Report produced no self-improvement output.');
      for (const rec of digest.selfImprovement) {
        if (!rec.priority || !rec.observation || !rec.recommendation || !rec.evidence) {
          throw new Error(`Malformed recommendation: ${JSON.stringify(rec)}`);
        }
      }

      const markdown = fs.readFileSync(markdownPath, 'utf8');
      if (!markdown.includes('## Chain of thought') || !markdown.includes('## Self-improvement')) {
        throw new Error('Markdown rendering is missing required sections.');
      }
      return `${digest.episodes.length} episodes, ${aq.plansVerified}/${aq.plansExecuted} verified, ${digest.selfImprovement.length} recommendation(s) at ${path.basename(jsonPath)}`;
    });

    await step('Offline report: journal digest surfaces error chains and advice', async () => {
      const { RunJournal } = await import('./src/RunJournal.js');
      const { buildJournalDigest } = await import('./src/BehaviorReport.js');
      const journal = new RunJournal(path.join(process.cwd(), '.splice'));
      journal.record({ kind: 'tool_call', tool: 'navigate', arguments: { url: fixture.url }, outcome: 'ok', durationMs: 120 });
      journal.record({ kind: 'tool_call', tool: 'compile_verified_action', outcome: 'ok', durationMs: 350 });
      for (let i = 0; i < 3; i++) {
        journal.record({ kind: 'tool_call', tool: 'interact', outcome: 'error', errorCode: 'TARGET_NOT_FOUND', detail: 'stale id', durationMs: 40 });
      }
      journal.close();

      const entries = journal.tail(50);
      const digest = buildJournalDigest(entries);
      fs.unlinkSync(journal.journalPath);

      if (digest.toolCalls !== 5 || digest.errors !== 3) throw new Error(`Bad digest counts: ${JSON.stringify({ toolCalls: digest.toolCalls, errors: digest.errors })}`);
      const interact = digest.tools.find((t) => t.tool === 'interact');
      if (!interact || interact.errors !== 3 || interact.avgDurationMs !== 40) throw new Error(`Per-tool stats wrong: ${JSON.stringify(interact)}`);
      const firstError = digest.errorTimeline[0];
      if (!firstError || !firstError.precededBy.some((p) => p.includes('compile_verified_action'))) {
        throw new Error(`Error timeline lost its preceding-call chain: ${JSON.stringify(firstError)}`);
      }
      const rec = digest.recommendations[0];
      if (!rec || rec.priority !== 'high' || !rec.observation.includes('interact')) {
        throw new Error(`Expected a high-priority recommendation about "interact": ${JSON.stringify(digest.recommendations)}`);
      }
      return `error-heavy tool flagged: ${rec.evidence}`;
    });
  } finally {
    await browser.close().catch(() => {});
    await fixture.close().catch(() => {});
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const reportPath = path.join(process.cwd(), '.splice', `regression-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ ranAt: new Date().toISOString(), passed: results.length - failed, failed, results }, null, 2));

  console.log(`\nRegression report: ${reportPath}`);
  console.log(`${results.length - failed}/${results.length} regression checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
