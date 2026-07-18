#!/usr/bin/env node
/**
 * Introspection-stack unit tests — pure math and logic, no browser.
 *
 * Everything the introspection stack computes (J-space geometry, the session
 * map, hazard detection, calibration, decision explanations, the train of
 * thought, session-learned prompt optimization) is deterministic local math
 * over recorded structures. These tests pin that math with hand-computed
 * cases so a regression in any engine fails loudly without needing Chromium.
 *
 * Run: npm run test:introspection
 */

import { exploreJSpace, buildDecisionWorkspace, cleanLabel, type JSpaceCandidate } from './src/JSpace.js';
import { JSpaceMap, observationFromReport, renderJSpaceMapMarkdown } from './src/JSpaceMap.js';
import { JSpaceDetector, screenDecision, screenTrends, readoutEntropy, DETECTOR_THRESHOLDS } from './src/JSpaceDetector.js';
import { buildCalibration, calibrationSentence, explainDecision } from './src/Cognition.js';
import { buildTrainOfThought } from './src/TrainOfThought.js';
import { optimizePrompt } from './src/PromptOptimizer.js';
import type { BehaviorEvent } from './src/BehaviorReport.js';

type Result = { name: string; status: 'PASS' | 'FAIL'; detail: string };
const results: Result[] = [];

function check(name: string, fn: () => string) {
  try {
    results.push({ name, status: 'PASS', detail: fn() });
  } catch (error: any) {
    results.push({ name, status: 'FAIL', detail: error?.message ?? String(error) });
  }
}

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ─── Shared fixtures ────────────────────────────────────────────────────────

/** Candidate factory: score is exactly the sum of its parts, like production. */
function candidate(id: string, label: string, contribs: number[], features: Record<string, number>, extra: { queryBonus?: number; structural?: number } = {}): JSpaceCandidate {
  const queryBonus = extra.queryBonus ?? 0;
  const structuralScore = extra.structural ?? 0;
  return {
    id,
    label,
    score: contribs.reduce((a, b) => a + b, 0) + queryBonus + structuralScore,
    keywordContributions: contribs,
    queryBonus,
    structuralScore,
    features,
  };
}

const sorted = (cands: JSpaceCandidate[]) => [...cands].sort((a, b) => b.score - a.score);

function planEvent(intent: string, at: number, data: Record<string, unknown> = {}): BehaviorEvent {
  return { type: 'verified_action_plan', timestamp: at, data: { intent, ...data } };
}

// ─── JSpace: exact flip-boundary math ───────────────────────────────────────

check('JSpace flip boundary matches hand computation', () => {
  // Winner W: contribs [10, 2] + structural 3 = 15. Rival R: [6, 4] + 3 = 13.
  // Margin 2. Token 0 leverage delta = 10 − 6 = 4 → requiredWeight = 1 − 2/4
  // = 0.5, distance 0.5, downweight. Token 1 delta = 2 − 4 = −2 →
  // requiredWeight = 1 + 2/2 = 2, distance 1, upweight.
  const report = exploreJSpace('click alpha beta', ['alpha', 'beta'], sorted([
    candidate('w', 'Alpha Save', [10, 2], { keywordMatch: 12 }, { structural: 3 }),
    candidate('r', 'Beta Save', [6, 4], { keywordMatch: 10 }, { structural: 3 }),
  ]));
  const alpha = report.flipBoundaries.find((f) => f.token === 'alpha')!;
  const beta = report.flipBoundaries.find((f) => f.token === 'beta')!;
  expect(!alpha.unreachable && approx(alpha.requiredWeight!, 0.5) && alpha.direction === 'downweight', `alpha boundary wrong: ${JSON.stringify(alpha)}`);
  expect(!beta.unreachable && approx(beta.requiredWeight!, 2) && beta.direction === 'upweight', `beta boundary wrong: ${JSON.stringify(beta)}`);
  expect(report.margin === 2 && report.winner === 'Alpha Save', 'margin/winner wrong');
  return `alpha flips at w=0.5 (downweight), beta at w=2 (upweight), margin 2 — exactly as computed by hand`;
});

check('JSpace robustness: deleting a token flips iff the math says so', () => {
  // Deleting token 0 (winner 15→5, rival 13→7) flips; report must say fragile.
  const fragile = exploreJSpace('x', ['alpha', 'beta'], sorted([
    candidate('w', 'W', [10, 2], { k: 12 }, { structural: 3 }),
    candidate('r', 'R', [6, 4], { k: 10 }, { structural: 3 }),
  ]));
  expect(fragile.winnerRobustToTokenDeletion === false, 'expected fragile');
  // Massive margin: no single deletion can flip.
  const robust = exploreJSpace('x', ['alpha'], sorted([
    candidate('w', 'W', [30], { k: 30 }),
    candidate('r', 'R', [2], { k: 2 }),
  ]));
  expect(robust.winnerRobustToTokenDeletion === true, 'expected robust');
  return 'fragile and robust cases both classified correctly';
});

check('JSpace geometry: inert and redundant tokens identified', () => {
  const report = exploreJSpace('x', ['live', 'dead', 'twin'], sorted([
    candidate('a', 'A', [8, 0, 8], { k: 16 }),
    candidate('b', 'B', [4, 0, 4], { k: 8 }),
  ]));
  expect(report.geometry.inertTokens.includes('dead'), 'dead token not flagged inert');
  expect(report.geometry.redundantPairs.some((p) => (p.a === 'live' && p.b === 'twin')), 'identical rows not flagged redundant');
  return `inert: [${report.geometry.inertTokens}], redundant: live+twin (cos 1.0)`;
});

check('Decision workspace: dimensionality and softmax follow the features', () => {
  // Two candidates differing on exactly one concept → effectively 1-D.
  // Scores mirror the feature sums, as in production (A: 10+30, B: 10).
  const ws = buildDecisionWorkspace(sorted([
    candidate('a', 'A', [10], { queryMatch: 30, keywordMatch: 10 }, { queryBonus: 30 }),
    candidate('b', 'B', [10], { queryMatch: 0, keywordMatch: 10 }),
  ]))!;
  expect(approx(ws.effectiveDimension, 1, 0.01), `expected 1-D, got ${ws.effectiveDimension}`);
  expect(ws.winnerProbability > 0.5 && ws.winnerProbability < 1, 'softmax out of range');
  expect(ws.decisionJacobian[0].concept === 'queryMatch', 'discriminating concept should top the decision Jacobian');
  return `1-D workspace, winner P=${ws.winnerProbability}, carried by queryMatch`;
});

check('cleanLabel strips URLs but never empties a label', () => {
  expect(cleanLabel('Pricing data:text/html,abc%20def') === 'Pricing', 'data: URL not stripped');
  expect(cleanLabel('Docs https://example.com/docs') === 'Docs', 'https URL not stripped');
  const urlOnly = cleanLabel('https://example.com/only-identity');
  expect(urlOnly.length > 0, 'URL-only label must fall back, not vanish');
  return 'URLs stripped for display; URL-only labels keep a raw-prefix fallback';
});

// ─── JSpaceMap: aggregation ─────────────────────────────────────────────────

check('JSpaceMap aggregates observations and finds recurring dead weight', () => {
  const map = new JSpaceMap();
  for (let i = 0; i < 3; i++) {
    map.record(observationFromReport(
      exploreJSpace(`click thing ${i} blorp`, ['thing', `t${i}`, 'blorp'], sorted([
        candidate('a', 'Thing', [9, 3, 0], { keywordMatch: 12, actionAffinity: 3 }, { structural: 3 }),
        candidate('b', 'Other', [2, 1, 0], { keywordMatch: 3, actionAffinity: 3 }, { structural: 3 }),
      ])),
      i === 0 ? 'lens' : 'action'
    ));
  }
  const report = map.buildReport();
  expect(report.observations === 3 && report.bySource.action === 2 && report.bySource.lens === 1, 'source counts wrong');
  expect(map.recurringInertTokens().includes('blorp'), 'recurring inert token missed');
  expect(report.dimensionality !== null && report.conceptLeaderboard.length > 0, 'aggregates missing');
  expect(map.findLatestByIntent('click thing 2 blorp') !== null, 'findLatestByIntent failed');
  const md = renderJSpaceMapMarkdown(report);
  expect(md.includes('# Splice J-Space Session Map') && md.includes('Concept leaderboard'), 'markdown incomplete');
  return `3 observations aggregated; "blorp" flagged recurring inert; markdown renders`;
});

// ─── JSpaceDetector: every hazard class + dedupe ────────────────────────────

check('Detector: ambiguous_readout + aliased_candidates on identical twins', () => {
  const report = exploreJSpace('click delete', ['delete'], sorted([
    candidate('a', 'Delete', [12], { keywordMatch: 12, actionAffinity: 3 }, { structural: 3 }),
    candidate('b', 'Delete', [12], { keywordMatch: 12, actionAffinity: 3 }, { structural: 3 }),
  ]));
  const found = screenDecision(report);
  const types = found.map((f) => f.type);
  expect(types.includes('ambiguous_readout'), 'near-tie not detected');
  expect(types.includes('aliased_candidates'), 'aliasing not detected');
  expect(found.find((f) => f.type === 'aliased_candidates')!.severity === 'critical', 'winner/runner-up aliasing must be critical');
  return `twins detected: ${types.join(', ')}`;
});

check('Detector: concept_conflict when the winner carries a heavy penalty', () => {
  const report = exploreJSpace('click pay', ['pay'], sorted([
    candidate('a', 'Pay now', [24], { keywordMatch: 24, obstructionPenalty: -12 }),
    candidate('b', 'Cancel', [2], { keywordMatch: 2 }),
  ]));
  const found = screenDecision(report);
  expect(found.some((f) => f.type === 'concept_conflict'), 'obstructed winner not flagged');
  return 'obstructed winner flagged as concept_conflict';
});

check('Detector: inert_majority and clean pages stay quiet', () => {
  const noisy = screenDecision(exploreJSpace('x', ['zorp', 'blorp', 'save'], sorted([
    candidate('a', 'Save', [0, 0, 40], { keywordMatch: 40 }),
    candidate('b', 'Other', [0, 0, 4], { keywordMatch: 4 }),
  ])));
  expect(noisy.some((f) => f.type === 'inert_majority'), 'inert majority not flagged');
  const clean = screenDecision(exploreJSpace('x', ['save'], sorted([
    candidate('a', 'Save', [40], { keywordMatch: 40, actionAffinity: 3 }, { structural: 3 }),
    candidate('b', 'Other', [4], { keywordMatch: 4, actionAffinity: 3 }, { structural: 3 }),
  ])));
  expect(clean.length === 0, `clean decision should produce no findings, got ${clean.map((f) => f.type)}`);
  return 'inert majority flagged; a strong clean decision produces zero findings';
});

check('Detector trends: unstable_target and chronic_ambiguity', () => {
  const mk = (winner: string, p: number, at: number) => ({
    timestamp: at, source: 'action' as const, intent: 'click wobble', winner,
    margin: 0.5, tokens: ['wobble'], inertTokens: [], robust: false, winnerProbability: p,
  });
  const trends = screenTrends([mk('A', 0.5, 1), mk('B', 0.5, 2), mk('A', 0.5, 3), mk('B', 0.5, 4)]);
  expect(trends.some((t) => t.type === 'unstable_target' && t.severity === 'critical'), 'unstable target missed');
  expect(trends.some((t) => t.type === 'chronic_ambiguity'), 'chronic ambiguity missed');
  return 'page drift and chronic ambiguity both detected from history';
});

check('Detector log dedupes repeats; entropy behaves at the extremes', () => {
  const detector = new JSpaceDetector();
  const twins = () => exploreJSpace('click delete', ['delete'], sorted([
    candidate('a', 'Delete', [12], { keywordMatch: 12 }),
    candidate('b', 'Delete', [12], { keywordMatch: 12 }),
  ]));
  const first = detector.screen(twins());
  const second = detector.screen(twins());
  expect(first.length > 0 && second.length === first.length, 'screen must still RETURN findings on repeats');
  expect(detector.size === first.length, `log must dedupe: size ${detector.size} vs findings ${first.length}`);
  expect(approx(readoutEntropy([10, 10], 8), 1, 0.001), 'tie entropy should be 1');
  expect(readoutEntropy([100, 0], 8) < 0.01, 'runaway winner entropy should be ~0');
  return `log deduped (${detector.size} distinct), returns stay per-decision; entropy 1.0 at tie, ~0 at runaway`;
});

// ─── Cognition: calibration + explanation ───────────────────────────────────

check('Calibration: hand-computed Brier, gap, and verdicts', () => {
  // Three executed actions at 0.9 confidence: pass, fail, fail.
  // Brier = ((0.9−1)² + (0.9)² + (0.9)²) / 3 = (0.01 + 0.81 + 0.81)/3 = 0.543̄
  // gap = 0.9 − 1/3 = 0.5667 → overconfident.
  const over = buildCalibration([
    planEvent('a', 1, { executed: true, passed: true, confidence: 0.9 }),
    planEvent('b', 2, { executed: true, passed: false, confidence: 0.9 }),
    planEvent('c', 3, { executed: true, passed: false, confidence: 0.9 }),
  ]);
  expect(approx(over.brierScore!, 0.543, 0.001), `Brier ${over.brierScore} != 0.543`);
  expect(over.verdict === 'overconfident', `verdict ${over.verdict}`);
  expect(over.surprises.length === 2, 'both high-confidence failures must be surprises');
  const under = buildCalibration([
    planEvent('a', 1, { executed: true, passed: true, confidence: 0.3 }),
    planEvent('b', 2, { executed: true, passed: true, confidence: 0.3 }),
    planEvent('c', 3, { executed: true, passed: true, confidence: 0.3 }),
  ]);
  expect(under.verdict === 'underconfident', `verdict ${under.verdict}`);
  expect(buildCalibration([]).verdict === 'insufficient-data', 'empty must be insufficient-data');
  expect(calibrationSentence(over).includes('overconfident'), 'sentence must carry the verdict');
  return `Brier 0.543 exact; overconfident/underconfident/insufficient all classified`;
});

check('Explanation degrades gracefully and tells the full story when it can', () => {
  const none = explainDecision(null, null, buildCalibration([]));
  expect(none.found === false && none.story.length > 0, 'empty case must still explain itself');
  const map = new JSpaceMap();
  map.record(observationFromReport(
    exploreJSpace('click save', ['save'], sorted([
      candidate('a', 'Save', [12], { keywordMatch: 12, actionAffinity: 3 }, { structural: 3 }),
      candidate('b', 'Cancel', [2], { keywordMatch: 2, actionAffinity: 3 }, { structural: 3 }),
    ])), 'action'
  ));
  const full = explainDecision(
    planEvent('click save', Date.now(), { executed: true, passed: true, confidence: 0.8, risk: 'low', target: 'a', why: 'Best match.' }),
    map.latest(),
    buildCalibration([planEvent('click save', 1, { executed: true, passed: true, confidence: 0.8 })])
  );
  expect(full.found === true, 'full case must be found');
  const text = full.story.join(' ');
  expect(/Save/.test(text) && /verification passed/.test(text), 'story must name the winner and the outcome');
  expect(full.decision?.runnerUp === 'Cancel', 'runner-up missing from decision');
  return `graceful empty case; full story names winner, runner-up, outcome (${full.story.length} lines)`;
});

// ─── Train of thought: patterns + collapse integrity ────────────────────────

check('Thought patterns: each detector fires on its synthetic stream', () => {
  const t0 = 1_000_000;
  const events: BehaviorEvent[] = [
    // over_observation: 3 straight reads.
    { type: 'semantic_tree', timestamp: t0 + 1, data: {} },
    { type: 'semantic_tree', timestamp: t0 + 2, data: {} },
    { type: 'semantic_tree', timestamp: t0 + 3, data: {} },
    // hesitation_loop: 3 straight diagnoses.
    { type: 'agent_state_diagnosis', timestamp: t0 + 4, data: { state: 'ready', confidence: 0.7 } },
    { type: 'agent_state_diagnosis', timestamp: t0 + 5, data: { state: 'ready', confidence: 0.7 } },
    { type: 'agent_state_diagnosis', timestamp: t0 + 6, data: { state: 'ready', confidence: 0.7 } },
    // blind_retry + thought_loop + unverified_streak: fail then identical re-runs.
    planEvent('click x', t0 + 7, { executed: true, passed: false, confidence: 0.8, expectDeclared: false }),
    planEvent('click x', t0 + 8, { executed: true, passed: false, confidence: 0.8, expectDeclared: false }),
    planEvent('click x', t0 + 9, { executed: true, passed: true, confidence: 0.8, expectDeclared: false }),
  ];
  const report = buildTrainOfThought({
    events,
    observations: [],
    hazards: { total: 0, bySeverity: { info: 0, warning: 0, critical: 0 }, byType: {}, recent: [], sessionTrends: [], interpretation: '' },
    calibration: buildCalibration(events),
    behaviorRecommendations: [],
    mapRecommendations: [],
  });
  const byPattern = Object.fromEntries(report.patterns.map((p) => [p.pattern, p.occurrences]));
  expect((byPattern.over_observation ?? 0) >= 1, 'over_observation missed');
  expect((byPattern.hesitation_loop ?? 0) >= 1, 'hesitation_loop missed');
  expect((byPattern.blind_retry ?? 0) >= 2, `blind_retry expected 2, got ${byPattern.blind_retry}`);
  expect((byPattern.thought_loop ?? 0) >= 1, 'thought_loop missed');
  expect((byPattern.unverified_streak ?? 0) >= 1, 'unverified_streak missed');
  expect(report.optimizations.length > 0 && report.optimizations[0].priority === 'high', 'high-priority optimization must lead the plan');
  return `all five negative patterns fire: ${Object.entries(byPattern).map(([k, v]) => `${k}×${v}`).join(', ')}`;
});

check('Thought stream collapses repeats without hiding them from detectors', () => {
  const t0 = 2_000_000;
  const events: BehaviorEvent[] = Array.from({ length: 5 }, (_, i) => ({
    type: 'semantic_tree', timestamp: t0 + i, data: {},
  } as BehaviorEvent));
  const report = buildTrainOfThought({
    events,
    observations: [],
    hazards: { total: 0, bySeverity: { info: 0, warning: 0, critical: 0 }, byType: {}, recent: [], sessionTrends: [], interpretation: '' },
    calibration: buildCalibration([]),
    behaviorRecommendations: [],
    mapRecommendations: [],
  });
  expect(report.stepCount === 5, `stepCount must count raw thoughts (got ${report.stepCount})`);
  expect(report.stream.length === 1 && /\(×5\)$/.test(report.stream[0].summary), 'stream must collapse 5 identical reads to one ×5 step');
  expect(report.patterns.some((p) => p.pattern === 'over_observation'), 'collapse must not hide the over_observation run');
  return 'stream shows one ×5 step; raw count and pattern detection unaffected';
});

check('Adaptive pivot after failure is recognized as the healthy pattern', () => {
  const t0 = 3_000_000;
  const events: BehaviorEvent[] = [
    planEvent('click x', t0 + 1, { executed: true, passed: false, confidence: 0.8 }),
    { type: 'wait_for', timestamp: t0 + 2, data: {} },
    planEvent('click x', t0 + 3, { executed: true, passed: true, confidence: 0.8 }),
    planEvent('click y', t0 + 4, { executed: true, passed: false, confidence: 0.8 }),
    planEvent('click "Exact Y"', t0 + 5, { executed: true, passed: true, confidence: 0.9 }),
  ];
  const report = buildTrainOfThought({
    events,
    observations: [],
    hazards: { total: 0, bySeverity: { info: 0, warning: 0, critical: 0 }, byType: {}, recent: [], sessionTrends: [], interpretation: '' },
    calibration: buildCalibration(events),
    behaviorRecommendations: [],
    mapRecommendations: [],
  });
  const adaptive = report.patterns.find((p) => p.pattern === 'adaptive_failure_response');
  const blind = report.patterns.find((p) => p.pattern === 'blind_retry');
  expect(adaptive !== undefined && adaptive.occurrences === 2, `expected 2 adaptive responses, got ${adaptive?.occurrences}`);
  expect(blind === undefined, 'wait-then-retry and rephrase must not count as blind retries');
  return 'wait-then-retry and rephrase both classified as adaptive, not blind';
});

// ─── PromptOptimizer: session hints ─────────────────────────────────────────

check('Session hints strip learned dead weight, but never on-page words or quotes', () => {
  const labels = [{ kind: 'click' as const, label: 'Save widget' }];
  // 'blorp' is learned-inert and absent from labels → stripped.
  const stripped = optimizePrompt('click save blorp', labels, { inertTokens: ['blorp'] });
  expect(!/blorp/.test(stripped.optimized), `"blorp" survived: ${stripped.optimized}`);
  expect(stripped.transformations.some((t) => /session-learned/.test(t)), 'session-learned transformation must be reported');
  // 'widget' is learned-inert but IS on this page → kept.
  const kept = optimizePrompt('click the save widget', [], { inertTokens: ['widget'] });
  const keptOnPage = optimizePrompt('click save widget', labels, { inertTokens: ['widget'] });
  expect(/widget/.test(keptOnPage.optimized) || keptOnPage.groundedTo === 'Save widget', `on-page word wrongly stripped: ${keptOnPage.optimized}`);
  // Quoted spans are never rewritten.
  const quoted = optimizePrompt('click "keep blorp here"', [], { inertTokens: ['blorp'] });
  expect(/keep blorp here/.test(quoted.optimized), `quoted span rewritten: ${quoted.optimized}`);
  void kept;
  return 'learned dead weight stripped with report; on-page words and quoted spans protected';
});

// ─── Report ─────────────────────────────────────────────────────────────────

let failures = 0;
for (const r of results) {
  if (r.status === 'FAIL') failures++;
  console.log(`${r.status} ${r.name} - ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} introspection checks passed`);
if (failures > 0) process.exit(1);
