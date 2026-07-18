/**
 * Splice Train of Thought — the agent's thinking, reconstructed and optimized.
 *
 * The behavior report scores WHAT happened; this module reconstructs HOW the
 * agent thought. Every cognition event is typed into a thought step —
 * observe → believe → decide → act → verify — and each decision step carries
 * its "why" pulled from the J-space map (what won, by how much, which concept
 * carried it, whether the geometry was hazardous). The result reads like an
 * annotated transcript of the agent's reasoning.
 *
 * On top of the stream, THINKING-PATTERN detectors analyze the shape of the
 * reasoning itself — not the outcomes, the sequence:
 *
 *   blind_retry          a failed action re-attempted with the same intent
 *                        and no observation in between (retrying the world
 *                        instead of re-reading it)
 *   thought_loop         the same intent decided 3+ times on the same page —
 *                        circling
 *   over_observation     3+ consecutive reads with no decision between them —
 *                        dithering
 *   hesitation_loop      3+ consecutive diagnoses with no action — analysis
 *                        paralysis
 *   unverified_streak    3+ consecutive executed actions with no declared
 *                        expectations — flying blind on outcomes
 *   adaptive_failure_response  (positive) failures answered with a re-read or
 *                        diagnosis before the next attempt
 *
 * The optimization plan then merges these pattern findings with the behavior
 * report's recommendations, the J-space map's phrasing advice, and the
 * calibration verdict into one ranked list of chain-of-thinking changes.
 *
 * Honest scope, as everywhere in Splice: this reconstructs the agent's
 * OBSERVABLE thinking — the cognition events it produced through Splice —
 * not the calling model's hidden reasoning.
 */

import { summarizeEvent, type BehaviorEvent, type SelfImprovementRecommendation } from './BehaviorReport.js';
import type { JSpaceObservation } from './JSpaceMap.js';
import type { DetectionSummary } from './JSpaceDetector.js';
import { calibrationSentence, type CalibrationReport } from './Cognition.js';

export type ThoughtKind = 'observe' | 'believe' | 'decide' | 'act' | 'verify' | 'wait' | 'recover' | 'introspect';

export interface ThoughtStep {
  index: number;
  offsetMs: number;
  kind: ThoughtKind;
  /** One line of the transcript. */
  summary: string;
  /** The why, for decisions: confidence, J-space geometry, hazards. */
  why?: string;
}

export interface ThinkingPatternFinding {
  pattern:
    | 'blind_retry'
    | 'thought_loop'
    | 'over_observation'
    | 'hesitation_loop'
    | 'unverified_streak'
    | 'adaptive_failure_response';
  /** 'good' marks a healthy pattern worth keeping. */
  severity: 'high' | 'medium' | 'good';
  occurrences: number;
  evidence: string[];
  optimization: string;
}

export interface TrainOfThoughtReport {
  generatedAt: string;
  sessionDurationMs: number;
  stepCount: number;
  tempo: {
    eventsPerMinute: number;
    /** Share of steps spent in each mode of thought. */
    shares: Record<ThoughtKind, number>;
  };
  /** The annotated transcript, oldest → newest (capped by maxSteps). */
  stream: ThoughtStep[];
  patterns: ThinkingPatternFinding[];
  decisionThinking: {
    decisions: number;
    robustShare: number | null;
    meanWinnerProbability: number | null;
    hazardCounts: { critical: number; warning: number };
    calibration: string;
  };
  /** Ranked chain-of-thinking changes, most impactful first. */
  optimizations: Array<{
    rank: number;
    priority: 'high' | 'medium' | 'low';
    change: string;
    evidence: string;
  }>;
  interpretation: string[];
  scope: string;
}

export interface TrainOfThoughtInput {
  events: BehaviorEvent[];
  observations: readonly JSpaceObservation[];
  hazards: DetectionSummary;
  calibration: CalibrationReport;
  behaviorRecommendations: SelfImprovementRecommendation[];
  mapRecommendations: string[];
}

const OBSERVE_TYPES = new Set(['semantic_tree', 'semantic_delta', 'network_activity', 'page_events', 'viewport_inspection', 'extract_structured']);
const INTROSPECT_TYPES = new Set(['jacobian_lens', 'jspace_detection', 'intent_experiment', 'prompt_optimized', 'behavior_report', 'jspace_report']);

function kindOf(event: BehaviorEvent): ThoughtKind {
  if (OBSERVE_TYPES.has(event.type)) return 'observe';
  if (event.type === 'agent_state_diagnosis') return 'believe';
  if (event.type === 'verified_action_plan') return event.data.executed === true ? 'act' : 'decide';
  if (event.type === 'assert_page_state') return 'verify';
  if (event.type === 'wait_for') return 'wait';
  if (event.type === 'navigate' || event.type === 'history_navigate' || event.type === 'interact' || event.type === 'form_fill') return 'act';
  if (event.type === 'crash_recovery' || event.type === 'recovery_learned' || event.type === 'self_heal') return 'recover';
  if (INTROSPECT_TYPES.has(event.type)) return 'introspect';
  return 'observe';
}

const intentKey = (s: unknown) => String(s ?? '').trim().toLowerCase().slice(0, 120);

/** The why for a decision step: compile confidence + J-space geometry + hazards. */
function whyFor(
  event: BehaviorEvent,
  observations: readonly JSpaceObservation[],
  hazards: DetectionSummary
): string | undefined {
  const d = event.data;
  const parts: string[] = [];
  if (typeof d.confidence === 'number') {
    parts.push(`chose at ${Math.round(Number(d.confidence) * 100)}% confidence${d.risk ? ` (${d.risk} risk)` : ''}`);
  }
  if (d.why) parts.push(String(d.why).slice(0, 140));
  const key = intentKey(d.intent);
  // Nearest-in-time observation for this intent (recorded during the compile).
  const obs = [...observations]
    .filter((o) => intentKey(o.intent) === key && o.timestamp <= event.timestamp + 2500)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (obs) {
    const geometry: string[] = [];
    if (obs.runnerUp) geometry.push(`beat "${obs.runnerUp}" by ${Number(obs.margin.toFixed(2))}`);
    if (typeof obs.winnerProbability === 'number') geometry.push(`${Math.round(obs.winnerProbability * 100)}% softmax`);
    geometry.push(obs.robust ? 'robust to any single-word deletion' : 'fragile (one word is load-bearing)');
    const topConcept = obs.conceptSensitivities?.[0];
    if (topConcept && Math.abs(topConcept.sensitivity) > 1e-6) geometry.push(`carried by ${topConcept.concept}`);
    parts.push(`J-space: ${geometry.join(', ')}`);
  }
  const flagged = [...new Set(
    hazards.recent
      .filter((h) => intentKey(h.intent) === key && h.severity !== 'info')
      .map((h) => `${h.severity}: ${h.type}`)
  )];
  if (flagged.length > 0) {
    parts.push(`⚠ ${flagged.join('; ')}`);
  }
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

// ─── Thinking-pattern detectors (over the typed stream) ─────────────────────

function detectPatterns(events: BehaviorEvent[], steps: ThoughtStep[]): ThinkingPatternFinding[] {
  const findings: ThinkingPatternFinding[] = [];
  const push = (f: ThinkingPatternFinding) => { if (f.occurrences > 0) findings.push(f); };

  // blind_retry / adaptive_failure_response: what follows a failed action?
  // Note: compile_verified_action logs an internal tree read + diagnosis on
  // every call, so "did the agent re-observe" cannot be read off event types.
  // The behavioral signal is what CHANGED: re-running the identical words is
  // the blind retry; a changed phrasing, or a navigate/wait first, is a pivot.
  const blind: string[] = [];
  const adaptive: string[] = [];
  const plans = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === 'verified_action_plan');
  for (let p = 0; p < plans.length; p++) {
    const { e, i } = plans[p];
    if (e.data.executed !== true || e.data.passed !== false) continue;
    const next = plans[p + 1];
    if (!next) continue;
    const pivotedBetween = events
      .slice(i + 1, next.i)
      .some((ev) => ev.type === 'navigate' || ev.type === 'history_navigate' || ev.type === 'wait_for');
    const sameIntent = intentKey(next.e.data.intent) === intentKey(e.data.intent);
    if (sameIntent && !pivotedBetween) blind.push(`"${String(e.data.intent).slice(0, 70)}" failed, then re-ran with identical words and no wait/navigation between`);
    else adaptive.push(`"${String(e.data.intent).slice(0, 70)}" failed → ${sameIntent ? 'waited/navigated before retrying' : 'changed approach'}`);
  }
  push({
    pattern: 'blind_retry',
    severity: 'high',
    occurrences: blind.length,
    evidence: blind.slice(0, 4),
    optimization:
      'After a failed verification, never re-run the identical intent: read the failure evidence, take a delta (deltaOnly with sinceLastActionId), and change something — the phrasing (run_intent_experiment), the tool, or the timing (wait_for).',
  });
  push({
    pattern: 'adaptive_failure_response',
    severity: 'good',
    occurrences: adaptive.length,
    evidence: adaptive.slice(0, 3),
    optimization: 'Keep this: failures answered with a change of approach (or an explicit wait) is the correct loop.',
  });

  // thought_loop: same intent decided 3+ times.
  const intentCounts = new Map<string, number>();
  for (const { e } of plans) {
    const key = intentKey(e.data.intent);
    if (key) intentCounts.set(key, (intentCounts.get(key) ?? 0) + 1);
  }
  const loops = [...intentCounts.entries()].filter(([, n]) => n >= 3);
  push({
    pattern: 'thought_loop',
    severity: 'high',
    occurrences: loops.length,
    evidence: loops.map(([k, n]) => `"${k}" compiled ${n}×`).slice(0, 4),
    optimization:
      'An intent compiled 3+ times is a circle, not progress. On the second repeat, change strategy: different phrasing (run_intent_experiment), a different tool (fill_form / wait_for), or back off the page.',
  });

  // over_observation: runs of 3+ consecutive observe steps.
  // hesitation_loop: runs of 3+ consecutive believe steps.
  const runs = (kind: ThoughtKind) => {
    const found: string[] = [];
    let run = 0;
    for (const s of steps) {
      if (s.kind === kind) {
        run++;
      } else if (s.kind === 'introspect') {
        continue; // introspection doesn't break a run of reads or diagnoses
      } else {
        if (run >= 3) found.push(`${run} consecutive ${kind} steps ending at +${(s.offsetMs / 1000).toFixed(1)}s`);
        run = 0;
      }
    }
    if (run >= 3) found.push(`${run} consecutive ${kind} steps at session end`);
    return found;
  };
  const overObs = runs('observe');
  push({
    pattern: 'over_observation',
    severity: 'medium',
    occurrences: overObs.length,
    evidence: overObs.slice(0, 3),
    optimization:
      'Three reads in a row with no decision is dithering. One observation (delta-first) then act; if the page is unclear, diagnose_agent_state answers "what state am I in" cheaper than another read.',
  });
  const hesitation = runs('believe');
  push({
    pattern: 'hesitation_loop',
    severity: 'medium',
    occurrences: hesitation.length,
    evidence: hesitation.slice(0, 3),
    optimization:
      'Repeated diagnoses without action is analysis paralysis. Two identical diagnoses are the ceiling — on the second, act on the recommended next tool or leave the page.',
  });

  // unverified_streak: 3+ consecutive executed actions without declared expectations.
  const executed = plans.filter(({ e }) => e.data.executed === true);
  let streak = 0;
  let worstStreak = 0;
  for (const { e } of executed) {
    if (e.data.expectDeclared === false) streak++;
    else streak = 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  push({
    pattern: 'unverified_streak',
    severity: 'high',
    occurrences: worstStreak >= 3 ? 1 : 0,
    evidence: worstStreak >= 3 ? [`longest run of expectation-less executed actions: ${worstStreak}`] : [],
    optimization:
      'Declare expect postconditions (url_contains, text_present, …) on consequential actions — heuristic verification catches less than declared expectations do, and calibration cannot improve on unmeasured outcomes.',
  });

  return findings;
}

// ─── The report builder ─────────────────────────────────────────────────────

export function buildTrainOfThought(input: TrainOfThoughtInput, maxSteps = 200): TrainOfThoughtReport {
  const events = [...input.events].sort((a, b) => a.timestamp - b.timestamp);
  const startedAt = events[0]?.timestamp ?? Date.now();
  const endedAt = events[events.length - 1]?.timestamp ?? startedAt;
  const sessionDurationMs = endedAt - startedAt;

  const rawSteps: ThoughtStep[] = events.map((e, index) => {
    const kind = kindOf(e);
    const step: ThoughtStep = {
      index,
      offsetMs: e.timestamp - startedAt,
      kind,
      summary: summarizeEvent(e),
    };
    if (kind === 'decide' || kind === 'act') {
      const why = e.type === 'verified_action_plan' ? whyFor(e, input.observations, input.hazards) : undefined;
      if (why) step.why = why;
    }
    return step;
  });

  // Collapse consecutive identical thoughts (e.g. an expectation being polled
  // every 250ms) into one step with a repeat count — the transcript should
  // read like thinking, not like a poll log. Pattern detection runs on the
  // raw steps so repeat counts never hide a loop.
  const steps: ThoughtStep[] = [];
  for (const s of rawSteps) {
    const prev = steps[steps.length - 1];
    if (prev && prev.kind === s.kind && prev.summary.replace(/ \(×\d+\)$/, '') === s.summary) {
      const repeat = Number(prev.summary.match(/ \(×(\d+)\)$/)?.[1] ?? 1) + 1;
      prev.summary = `${s.summary} (×${repeat})`;
      prev.offsetMs = s.offsetMs; // show when the repetition ended
    } else {
      steps.push({ ...s });
    }
  }

  const shares: Record<ThoughtKind, number> = { observe: 0, believe: 0, decide: 0, act: 0, verify: 0, wait: 0, recover: 0, introspect: 0 };
  for (const s of rawSteps) shares[s.kind]++;
  const total = Math.max(1, rawSteps.length);
  for (const k of Object.keys(shares) as ThoughtKind[]) shares[k] = Number((shares[k] / total).toFixed(3));

  const patterns = detectPatterns(events, rawSteps);

  // Decision thinking overlay from the J-space map + detector + calibration.
  const obs = input.observations;
  const withP = obs.filter((o) => typeof o.winnerProbability === 'number');
  const decisionThinking = {
    decisions: obs.length,
    robustShare: obs.length > 0 ? Number((obs.filter((o) => o.robust).length / obs.length).toFixed(3)) : null,
    meanWinnerProbability:
      withP.length > 0 ? Number((withP.reduce((s, o) => s + (o.winnerProbability as number), 0) / withP.length).toFixed(3)) : null,
    hazardCounts: { critical: input.hazards.bySeverity.critical, warning: input.hazards.bySeverity.warning },
    calibration: calibrationSentence(input.calibration),
  };

  // ── The optimization plan: patterns first, then the other engines' advice. ──
  const optimizations: TrainOfThoughtReport['optimizations'] = [];
  const add = (priority: 'high' | 'medium' | 'low', change: string, evidence: string) => {
    optimizations.push({ rank: 0, priority, change, evidence });
  };
  for (const p of patterns) {
    if (p.severity === 'good') continue;
    add(p.severity === 'high' ? 'high' : 'medium', p.optimization, `${p.pattern}: ${p.occurrences} occurrence(s) — ${p.evidence[0] ?? ''}`);
  }
  for (const r of input.behaviorRecommendations) {
    add(r.priority, r.recommendation, r.evidence);
  }
  for (const rec of input.mapRecommendations.slice(0, 2)) {
    if (!/No structural weaknesses/.test(rec)) add('medium', rec, 'J-space map recommendation');
  }
  for (const t of input.hazards.sessionTrends) {
    add(t.severity === 'critical' ? 'high' : 'medium', t.recommendation, `${t.type}: ${t.title}`);
  }
  for (const a of input.calibration.advice.slice(0, 1)) {
    if (input.calibration.verdict === 'overconfident' || input.calibration.verdict === 'underconfident') add('medium', a, `calibration verdict: ${input.calibration.verdict}`);
  }
  const order = { high: 0, medium: 1, low: 2 };
  optimizations.sort((a, b) => order[a.priority] - order[b.priority]);
  const deduped = optimizations
    .filter((o, i) => optimizations.findIndex((x) => x.change === o.change) === i)
    .slice(0, 10)
    .map((o, i) => ({ ...o, rank: i + 1 }));

  const negatives = patterns.filter((p) => p.severity !== 'good');
  const interpretation: string[] = [];
  interpretation.push(
    rawSteps.length === 0
      ? 'No cognition events yet — the train of thought builds itself as the agent works.'
      : `${rawSteps.length} thought step(s) over ${(sessionDurationMs / 1000).toFixed(1)}s: ${Math.round(shares.observe * 100)}% observing, ${Math.round(
          (shares.decide + shares.act) * 100
        )}% deciding/acting, ${Math.round(shares.believe * 100)}% diagnosing, ${Math.round(shares.introspect * 100)}% introspecting.`
  );
  if (rawSteps.length > 0) {
    interpretation.push(
      negatives.length === 0
        ? 'Thinking shape is healthy: no blind retries, loops, dithering, or unverified streaks detected.'
        : `Thinking-shape issues: ${negatives.map((p) => `${p.pattern} ×${p.occurrences}`).join(', ')} — see the optimization plan.`
    );
    interpretation.push(decisionThinking.calibration);
    if (deduped.length > 0) interpretation.push(`Top optimization: ${deduped[0].change}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    sessionDurationMs,
    stepCount: rawSteps.length,
    tempo: {
      eventsPerMinute: sessionDurationMs > 0 ? Number((rawSteps.length / (sessionDurationMs / 60000)).toFixed(1)) : rawSteps.length,
      shares,
    },
    stream: steps.slice(-maxSteps),
    patterns,
    decisionThinking,
    optimizations: deduped,
    interpretation,
    scope:
      'This reconstructs the agent\'s observable thinking — the cognition events it produced through Splice, annotated with its own ' +
      'pre-action decision geometry — not the calling model\'s hidden reasoning.',
  };
}

// ─── Markdown rendering ─────────────────────────────────────────────────────

const KIND_GLYPH: Record<ThoughtKind, string> = {
  observe: '◉ observe',
  believe: '? believe',
  decide: '∴ decide',
  act: '→ act',
  verify: '✓ verify',
  wait: '… wait',
  recover: '↺ recover',
  introspect: '◇ introspect',
};

export function renderTrainOfThoughtMarkdown(report: TrainOfThoughtReport): string {
  const lines: string[] = [];
  lines.push('# Splice Train of Thought');
  lines.push('');
  lines.push(`Generated ${report.generatedAt} · ${report.stepCount} thought step(s) over ${(report.sessionDurationMs / 1000).toFixed(1)}s · tempo ${report.tempo.eventsPerMinute}/min`);
  lines.push('');
  for (const line of report.interpretation) lines.push(`- ${line}`);
  lines.push('');

  lines.push('## Optimization plan');
  lines.push('');
  if (report.optimizations.length === 0) lines.push('Nothing to change — keep the current loop.');
  for (const o of report.optimizations) {
    lines.push(`${o.rank}. **[${o.priority.toUpperCase()}]** ${o.change}`);
    lines.push(`   - Evidence: ${o.evidence}`);
  }
  lines.push('');

  lines.push('## Thinking patterns');
  lines.push('');
  if (report.patterns.length === 0) lines.push('No patterns detected.');
  for (const p of report.patterns) {
    lines.push(`### ${p.severity === 'good' ? '✓' : '⚠'} ${p.pattern} — ${p.occurrences} occurrence(s)`);
    for (const e of p.evidence) lines.push(`- ${e}`);
    lines.push(`- **${p.severity === 'good' ? 'Keep' : 'Change'}:** ${p.optimization}`);
    lines.push('');
  }

  const dt = report.decisionThinking;
  lines.push('## Decision thinking');
  lines.push('');
  lines.push(`- ${dt.decisions} decision(s) mapped in J-space${dt.robustShare !== null ? `; ${Math.round(dt.robustShare * 100)}% robust` : ''}${
    dt.meanWinnerProbability !== null ? `; mean softmax confidence ${Math.round(dt.meanWinnerProbability * 100)}%` : ''
  }`);
  lines.push(`- Geometry hazards: ${dt.hazardCounts.critical} critical, ${dt.hazardCounts.warning} warning`);
  lines.push(`- ${dt.calibration}`);
  lines.push('');

  lines.push('## The train of thought');
  lines.push('');
  lines.push('```');
  for (const s of report.stream) {
    lines.push(`[+${(s.offsetMs / 1000).toFixed(1)}s] ${KIND_GLYPH[s.kind]}  ${s.summary}`);
    if (s.why) lines.push(`         └─ why: ${s.why}`);
  }
  lines.push('```');
  lines.push('');
  lines.push(`> ${report.scope}`);
  lines.push('');
  return lines.join('\n');
}
