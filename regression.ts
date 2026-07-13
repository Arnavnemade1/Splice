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

    // ── Prompt optimization: compression, grounding, routing, permission ──

    await step('Prompt optimizer: grounds verbose prompts against real page labels', async () => {
      await browser.navigate(`${fixture.url}/form`);
      const clicky = await browser.optimizeIntent('Could you please click on the create account button for me? Thanks!');
      if (clicky.optimized !== 'click "Create account"') throw new Error(`Bad rewrite: ${JSON.stringify(clicky)}`);
      if (clicky.groundedTo !== 'Create account') throw new Error(`Target not grounded: ${JSON.stringify(clicky)}`);
      if (clicky.estimatedTokensSaved < 5) throw new Error(`Compression under-credited: ${clicky.estimatedTokensSaved}.`);
      const typed = await browser.optimizeIntent('please type agent@example.com into the work email field');
      if (typed.value !== 'agent@example.com') throw new Error(`Value not separated: ${JSON.stringify(typed)}`);
      if (!typed.optimized.startsWith('type into "')) throw new Error(`Type intent malformed: ${typed.optimized}`);
      return `"${clicky.original.slice(0, 40)}…" → ${clicky.optimized} (~${clicky.estimatedTokensSaved} tokens saved)`;
    });

    await step('Prompt optimizer: routes prompts to the right one-call primitive', async () => {
      const wait = await browser.optimizeIntent('wait until the receipt appears');
      if (wait.toolSuggestion?.tool !== 'wait_for') throw new Error(`Wait prompt not routed: ${JSON.stringify(wait.toolSuggestion)}`);
      const assert = await browser.optimizeIntent('verify that the order total is $49');
      if (assert.toolSuggestion?.tool !== 'assert_page_state') throw new Error(`Assertion prompt not routed: ${JSON.stringify(assert.toolSuggestion)}`);
      const action = await browser.optimizeIntent('check the agree to terms checkbox');
      if (action.toolSuggestion) throw new Error(`Control action misrouted as assertion: ${JSON.stringify(action.toolSuggestion)}`);
      const extract = await browser.optimizeIntent('extract the plan names and prices');
      if (extract.toolSuggestion?.tool !== 'extract_structured') throw new Error(`Extraction prompt not routed: ${JSON.stringify(extract.toolSuggestion)}`);
      const form = await browser.optimizeIntent('fill in the form with email as a@b.com and name as Ada');
      const fields = form.toolSuggestion?.args?.fields as Array<{ field: string; value: string }> | undefined;
      if (form.toolSuggestion?.tool !== 'fill_form' || fields?.length !== 2 || fields[1].field !== 'name') {
        throw new Error(`Form prompt not routed cleanly: ${JSON.stringify(form.toolSuggestion)}`);
      }
      const key = await browser.optimizeIntent('press Enter');
      if (key.optimized !== 'press Enter') throw new Error(`Keyboard action mangled: ${key.optimized}`);
      return 'wait_for, assert_page_state, extract_structured, fill_form routed; control actions and key presses untouched';
    });

    await step('Prompt optimizer: permission gates who rewrites what', async () => {
      await browser.navigate(`${fixture.url}/obstruct`);
      await browser.executeScript(`document.getElementById('newsletter')?.remove(); document.getElementById('cookie-banner')?.remove()`);
      // Without permission: the verbose prompt reaches compilation verbatim.
      const untouched = await browser.compileVerifiedAction({ intent: 'please click on the "Continue to dashboard" button' });
      if (untouched.intentOptimization) throw new Error('Intent was rewritten without permission.');
      // Per-call permission: rewrite applied, executed, and reported with the original.
      const optimized = await browser.compileVerifiedAction({
        intent: 'Could you please click on the continue to dashboard button for me?',
        execute: true,
        optimizeIntent: true,
        expect: [{ kind: 'url_contains', value: '/obstruct/dashboard' }],
      });
      if (!optimized.intentOptimization) throw new Error('Per-call permission did not apply the optimization.');
      if (optimized.intentOptimization.original !== 'Could you please click on the continue to dashboard button for me?') {
        throw new Error('Original prompt was not preserved in the plan.');
      }
      if (!optimized.verification?.executed || !optimized.verification.passed) {
        throw new Error(`Optimized intent did not verify: ${JSON.stringify(optimized.verification)}`);
      }
      if (!optimized.evidence.some((e) => e.includes('Intent optimized'))) throw new Error('Rewrite missing from plan evidence.');
      // Standing permission (config): same path, no per-call flag.
      await browser.navigate(`${fixture.url}/form`);
      browser.promptOptimizationAuto = true;
      try {
        const standing = await browser.compileVerifiedAction({ intent: 'please type agent@example.com into the work email field', execute: true });
        if (!standing.intentOptimization) throw new Error('Standing permission did not apply the optimization.');
        if (!standing.verification?.executed) throw new Error('Standing-permission action was not executed.');
        const emailValue = await browser.executeScript(`document.getElementById('email').value`);
        if (emailValue !== 'agent@example.com') throw new Error(`Separated value not typed: "${emailValue}".`);
      } finally {
        browser.promptOptimizationAuto = false;
      }
      return `verbatim without permission; rewritten + verified with per-call and standing permission`;
    });

    await step('Prompt optimizer: splits sequential chains and routes navigation/login', async () => {
      const chain = await browser.optimizeIntent('type agent@example.com into the work email field, then click the create account button');
      if (!chain.steps || chain.steps.length !== 2) throw new Error(`Chain not split: ${JSON.stringify(chain.steps)}`);
      if (chain.steps[0].value !== 'agent@example.com') throw new Error(`Step 1 lost its value: ${JSON.stringify(chain.steps[0])}`);
      if (!chain.steps[1].intent.startsWith('click')) throw new Error(`Step 2 malformed: ${chain.steps[1].intent}`);
      const nav = await browser.optimizeIntent('go to example.com/pricing');
      if (nav.toolSuggestion?.tool !== 'navigate' || (nav.toolSuggestion.args as any)?.url !== 'https://example.com/pricing') {
        throw new Error(`Navigation prompt not routed: ${JSON.stringify(nav.toolSuggestion)}`);
      }
      const login = await browser.optimizeIntent('log in with alice@example.com and password hunter2');
      const loginArgs = login.toolSuggestion?.args as any;
      if (login.toolSuggestion?.tool !== 'fill_form' || loginArgs?.fields?.[1]?.field !== 'password') {
        throw new Error(`Login prompt not routed: ${JSON.stringify(login.toolSuggestion)}`);
      }
      // A multi-step rewrite must never be auto-applied by a single compile call.
      const applied = await browser.compileVerifiedAction({
        intent: 'click "Products", then click "Quarterly reports"',
        optimizeIntent: true,
      });
      if (applied.intentOptimization) throw new Error('Multi-step chain was auto-applied to a single compile call.');
      return 'chains split with per-step values; navigate + login routed; multi-step auto-apply refused';
    });

    // ── Accessibility: seeded violations detected, clean page stays clean ──

    await step('Accessibility audit: every seeded violation class is detected', async () => {
      await browser.navigate(`${fixture.url}/a11y`);
      const report = await browser.runAccessibilityAudit();
      const rules = new Set(report.findings.map((f) => f.rule));
      const expected = ['image-alt', 'control-label', 'accessible-name', 'document-language', 'heading-order', 'color-contrast', 'positive-tabindex', 'duplicate-id', 'aria-hidden-focus'];
      const missed = expected.filter((r) => !rules.has(r));
      if (missed.length > 0) throw new Error(`Rules missed their seeded violations: ${missed.join(', ')} (found: ${[...rules].join(', ')})`);
      if (report.score >= 60) throw new Error(`Seeded page scored too well: ${report.score}.`);
      if (report.findings[0].severity !== 'critical') throw new Error('Findings are not ordered worst-first.');
      if (!report.findings.every((f) => f.wcag && f.fix)) throw new Error('Findings missing WCAG mapping or fix guidance.');
      if (!report.agentImpact.includes('fill_form') && !report.agentImpact.includes('intent ranking')) {
        throw new Error(`Agent impact analysis missing: ${report.agentImpact}`);
      }
      return `${report.findings.length} finding(s) across ${rules.size} rules, score ${report.score}/100`;
    });

    await step('Accessibility audit: a clean page produces zero false positives', async () => {
      await browser.navigate(`${fixture.url}/a11y?clean=1`);
      const report = await browser.runAccessibilityAudit();
      if (report.findings.length !== 0) throw new Error(`False positives on the clean page: ${JSON.stringify(report.findings.map((f) => `${f.rule}: ${f.element}`))}`);
      if (report.score !== 100) throw new Error(`Clean page should score 100, got ${report.score}.`);
      if (report.passedRules.length < 9) throw new Error(`Expected all rules reported as passed, got ${report.passedRules.length}.`);
      return `score 100/100, ${report.passedRules.length} rules verified clean`;
    });

    // ── Introspection: live session trace and the Jacobian lens ──

    await step('Session trace: live chain of thought, filtered, and truly ephemeral', async () => {
      const behaviorDir = path.join(process.cwd(), '.splice', 'behavior');
      const filesBefore = fs.existsSync(behaviorDir) ? fs.readdirSync(behaviorDir).length : 0;

      const trace = browser.getSessionTrace({ limit: 500 });
      if (trace.totalEvents < 50) throw new Error(`Expected a rich session, got ${trace.totalEvents} events.`);
      if (!trace.thinking.some((line) => line.includes('executed "click'))) throw new Error('Trace is missing executed intents.');
      if (!trace.thinking.some((line) => line.includes('diagnosed'))) throw new Error('Trace is missing diagnoses.');
      if (!trace.thinking.some((line) => line.includes('Best semantic and visual match'))) {
        throw new Error('Trace is missing the reasoning behind target choices.');
      }

      const filtered = browser.getSessionTrace({ type: 'agent_state_diagnosis', limit: 20, includeRaw: true });
      if (!filtered.events || filtered.events.length === 0) throw new Error('Type filter returned no events.');
      if (!filtered.events.every((e) => e.type === 'agent_state_diagnosis')) throw new Error('Type filter leaked other event types.');

      const filesAfter = fs.existsSync(behaviorDir) ? fs.readdirSync(behaviorDir).length : 0;
      if (filesAfter !== filesBefore) throw new Error('getSessionTrace persisted something — it must be in-memory only.');
      if (trace.ephemeral !== true) throw new Error('Trace must declare itself ephemeral.');
      return `${trace.returned}/${trace.totalEvents} events narrated live; filters honest; nothing written`;
    });

    await step('Jacobian lens: a well-grounded intent reads as robust', async () => {
      await browser.navigate(`${fixture.url}/menu`);
      await browser.compileVerifiedAction({ intent: 'click "Products"', execute: true });
      await browser.waitFor([{ kind: 'text_present', value: 'quarterly reports' }], { timeoutMs: 4000, pollIntervalMs: 100 });

      const lens = await browser.runJacobianLens('click "Quarterly reports"');
      if (!lens.winner || !lens.winner.label.includes('Quarterly reports')) {
        throw new Error(`Wrong baseline winner: ${JSON.stringify(lens.winner)}`);
      }
      if (lens.perToken.length !== lens.tokens.length) throw new Error('One finite-difference row per token expected.');
      if (lens.perToken.some((t) => t.winnerChanged)) throw new Error('No single-token removal should flip an exact-label intent.');
      if (!lens.insight.includes('stable')) throw new Error(`Insight does not state stability: ${lens.insight}`);
      if (lens.actionImpact.length < 1) throw new Error('Lens is missing the ∂page/∂action section.');
      return `winner "${lens.winner.label}" stable across ${lens.tokens.length} token removals; ${lens.actionImpact.length} action impact(s)`;
    });

    await step('Jacobian lens: a tie-broken intent is exposed as fragile', async () => {
      await browser.navigate(`${fixture.url}/form`);
      // "confirm password" matches the confirm field AND the password field by
      // one token each — the lens must expose that fragility instead of
      // letting the tie-break pass silently.
      const lens = await browser.runJacobianLens('click confirm password');
      const flip = lens.perToken.find((t) => t.winnerChanged);
      if (!flip) throw new Error(`Expected a load-bearing token flip: ${JSON.stringify(lens.perToken)}`);
      if (!lens.insight.includes('Load-bearing')) throw new Error(`Insight does not name the fragility: ${lens.insight}`);
      if (lens.perToken.some((t) => typeof t.topScoreDelta !== 'number')) throw new Error('Sensitivity cells must be numeric.');
      return `flip exposed on "${flip.token}" → ${flip.newWinner}`;
    });

    await step('J-space: exact Jacobian, geometry, spectrum, and flip boundaries', async () => {
      await browser.navigate(`${fixture.url}/menu`);
      await browser.compileVerifiedAction({ intent: 'click "Products"', execute: true });
      await browser.waitFor([{ kind: 'text_present', value: 'quarterly reports' }], { timeoutMs: 4000, pollIntervalMs: 100 });

      const lens = await browser.runJacobianLens('click "Quarterly reports"', { deep: true });
      const js = lens.jSpace;
      if (!js) throw new Error('deep: true did not return the J-space report.');
      if (js.jacobian.length !== js.tokens.length || js.jacobian[0].length !== js.candidates.length) {
        throw new Error(`Jacobian shape mismatch: ${js.jacobian.length}×${js.jacobian[0]?.length} vs ${js.tokens.length} tokens × ${js.candidates.length} candidates.`);
      }
      // Exact values: both tokens partially match only the winner's label (+10 each).
      const qi = js.tokens.indexOf('quarterly');
      if (qi < 0 || js.jacobian[qi][0] !== 10) throw new Error(`Expected exact +10 contribution of "quarterly" to the winner, got ${qi < 0 ? 'no token' : js.jacobian[qi][0]}.`);
      // Geometry: the two tokens pull the same single candidate → collinear rows.
      if (!js.geometry.redundantPairs.some((p) => [p.a, p.b].includes('quarterly'))) {
        throw new Error(`Collinear tokens not detected: ${JSON.stringify(js.geometry)}`);
      }
      // Spectrum: one winner-vs-rest axis → effectively rank one.
      if (js.spectrum.sigma1 <= 0) throw new Error('σ1 must be positive.');
      if (js.spectrum.dominantModeEnergy < 0.99) throw new Error(`Expected rank-one sensitivity, energy ${js.spectrum.dominantModeEnergy}.`);
      if (js.spectrum.sigma2 > 0.01 * js.spectrum.sigma1) throw new Error(`σ2 should be negligible, got ${js.spectrum.sigma2}.`);
      // Flip boundaries: the margin dwarfs any single token's leverage.
      if (!js.flipBoundaries.every((f) => f.unreachable)) throw new Error(`No single-token reweighting should reach the boundary: ${JSON.stringify(js.flipBoundaries)}`);
      if (!js.winnerRobustToTokenDeletion) throw new Error('Winner should be robust to token deletion.');
      // Cross-check: analytic predictions must match the finite-difference reruns.
      if (!lens.consistency || lens.consistency.agreements !== lens.consistency.comparisons) {
        throw new Error(`Analytic/FD disagreement: ${JSON.stringify(lens.consistency)}`);
      }
      if (js.interpretation.length < 3) throw new Error('J-space report is missing its interpretation.');
      return `J ${js.tokens.length}×${js.candidates.length} exact; σ1 ${js.spectrum.sigma1} (energy ${js.spectrum.dominantModeEnergy}); boundary unreachable; analytic = FD ${lens.consistency.agreements}/${lens.consistency.comparisons}`;
    });

    await step('Decision workspace: low-dimensional J-space analog over concept axes', async () => {
      await browser.navigate(`${fixture.url}/menu`);
      await browser.compileVerifiedAction({ intent: 'click "Products"', execute: true });
      await browser.waitFor([{ kind: 'text_present', value: 'quarterly reports' }], { timeoutMs: 4000, pollIntervalMs: 100 });

      const lens = await browser.runJacobianLens('click "Quarterly reports"', { deep: true });
      const ws = lens.jSpace?.workspace;
      if (!ws) throw new Error('deep J-space did not include the decision workspace.');
      // The workspace spans named concept axes and the activation matrix aligns.
      if (!ws.concepts.includes('keywordMatch') || !ws.concepts.includes('actionAffinity')) {
        throw new Error(`Concept axes missing: ${ws.concepts.join(', ')}`);
      }
      if (ws.activations.length < 2 || ws.activations[0].vector.length !== ws.concepts.length) {
        throw new Error('Activation matrix shape does not match the concept axes.');
      }
      // A clean exact-label choice occupies few directions.
      if (!(ws.effectiveDimension >= 1) || ws.effectiveDimension > 2.5) {
        throw new Error(`Expected a low-dimensional workspace (1–2.5), got ${ws.effectiveDimension}.`);
      }
      // Variance shares of the returned directions are a valid partition.
      const shareSum = ws.conceptDirections.reduce((s, d) => s + d.varianceShare, 0);
      if (shareSum > 1.001 || shareSum < 0.5) throw new Error(`Variance shares implausible: sum ${shareSum}.`);
      if (!ws.conceptDirections[0]?.separatesWinner) throw new Error('The winner should separate along the dominant concept direction.');
      // The decision Jacobian is a softmax readout: the winner-leading concept
      // must have positive sensitivity, and confidence must be a probability.
      const kw = ws.decisionJacobian.find((d) => d.concept === 'keywordMatch');
      if (!kw || kw.sensitivity <= 0) throw new Error(`keywordMatch should be a load-bearing concept: ${JSON.stringify(kw)}`);
      if (ws.winnerProbability <= 0.5 || ws.winnerProbability > 1) throw new Error(`Winner probability out of range: ${ws.winnerProbability}.`);
      if (!ws.interpretation.some((l) => l.toLowerCase().includes('not the calling model'))) {
        throw new Error('Workspace must state the honest scope (not the model\'s hidden activations).');
      }
      return `workspace ~${ws.effectiveDimension}-D over ${ws.concepts.length} concepts; winner P=${ws.winnerProbability}; top concept "${ws.decisionJacobian[0].concept}"`;
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
