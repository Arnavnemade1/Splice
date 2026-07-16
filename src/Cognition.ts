/**
 * Splice Cognition — the agent's mind, measured.
 *
 * Two lenses that go deeper than "what happened":
 *
 *  1. CALIBRATION — does the agent's stated confidence mean anything? Every
 *     compiled action declares a confidence before executing; every executed
 *     action gets verified against real postconditions. Comparing the two
 *     across a session gives the honest answer: a Brier score, a calibration
 *     gap (overconfident vs underconfident), per-band reliability, and the
 *     specific high-confidence actions that failed anyway (the surprises —
 *     where the agent's model of the page diverged from the page).
 *
 *  2. EXPLANATION — a compiled decision, retold in plain language. The data
 *     already exists (the plan's evidence, the decision's J-space
 *     observation, the calibration record); this module turns it into a
 *     story a human can read in ten seconds: what was chosen, why, what came
 *     second, which single word the choice hangs on, and whether this
 *     agent's confidence has been trustworthy this session.
 *
 * Honest scope, same as everywhere in Splice: this measures Splice's own
 * pre-action workspace and verified outcomes — the agent's observable mind,
 * not the calling model's hidden state.
 */

import type { BehaviorEvent } from './BehaviorReport.js';
import type { JSpaceObservation } from './JSpaceMap.js';

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface CalibrationBand {
  /** Human-readable confidence range, e.g. "70–85%". */
  band: string;
  count: number;
  meanConfidence: number;
  /** Fraction of executed actions in this band that verified. */
  passRate: number | null;
}

export interface CalibrationReport {
  /** Executed, verification-checked actions this session. */
  samples: number;
  /** Mean squared error of confidence vs outcome (0 = clairvoyant, 0.25 = coin flip). */
  brierScore: number | null;
  /** Mean confidence − pass rate. Positive = overconfident, negative = underconfident. */
  calibrationGap: number | null;
  verdict: 'well-calibrated' | 'overconfident' | 'underconfident' | 'insufficient-data';
  bands: CalibrationBand[];
  /** Actions compiled at ≥70% confidence whose verification failed — the surprises. */
  surprises: Array<{ intent: string; confidence: number; expectedOutcome?: string }>;
  advice: string[];
}

const BANDS: Array<{ band: string; min: number; max: number }> = [
  { band: '<50%', min: 0, max: 0.5 },
  { band: '50–70%', min: 0.5, max: 0.7 },
  { band: '70–85%', min: 0.7, max: 0.85 },
  { band: '≥85%', min: 0.85, max: 1.01 },
];

/** Build the session's confidence-calibration record from the behavior log. */
export function buildCalibration(events: BehaviorEvent[]): CalibrationReport {
  const round = (v: number, d = 3) => Number(v.toFixed(d));
  const executed = events.filter(
    (e) => e.type === 'verified_action_plan' && e.data.executed === true && typeof e.data.confidence === 'number'
  );
  const samples = executed.map((e) => ({
    intent: String(e.data.intent ?? '').slice(0, 100),
    confidence: Number(e.data.confidence),
    passed: e.data.passed !== false,
    expectedOutcome: e.data.expectedOutcome ? String(e.data.expectedOutcome).slice(0, 160) : undefined,
  }));

  if (samples.length === 0) {
    return {
      samples: 0,
      brierScore: null,
      calibrationGap: null,
      verdict: 'insufficient-data',
      bands: BANDS.map((b) => ({ band: b.band, count: 0, meanConfidence: 0, passRate: null })),
      surprises: [],
      advice: ['No executed actions to calibrate against yet. Calibration builds itself as verified actions run.'],
    };
  }

  const brierScore = round(
    samples.reduce((s, x) => s + Math.pow(x.confidence - (x.passed ? 1 : 0), 2), 0) / samples.length
  );
  const meanConfidence = samples.reduce((s, x) => s + x.confidence, 0) / samples.length;
  const passRate = samples.filter((x) => x.passed).length / samples.length;
  const calibrationGap = round(meanConfidence - passRate);

  const bands = BANDS.map((b) => {
    const inBand = samples.filter((x) => x.confidence >= b.min && x.confidence < b.max);
    return {
      band: b.band,
      count: inBand.length,
      meanConfidence: inBand.length ? round(inBand.reduce((s, x) => s + x.confidence, 0) / inBand.length) : 0,
      passRate: inBand.length ? round(inBand.filter((x) => x.passed).length / inBand.length) : null,
    };
  });

  const surprises = samples
    .filter((x) => x.confidence >= 0.7 && !x.passed)
    .map(({ intent, confidence, expectedOutcome }) => ({ intent, confidence: round(confidence), ...(expectedOutcome ? { expectedOutcome } : {}) }))
    .slice(0, 6);

  // Verdict needs a handful of samples to mean anything.
  const verdict: CalibrationReport['verdict'] =
    samples.length < 3 ? 'insufficient-data'
    : calibrationGap > 0.15 ? 'overconfident'
    : calibrationGap < -0.15 ? 'underconfident'
    : 'well-calibrated';

  const advice: string[] = [];
  if (verdict === 'overconfident') {
    advice.push(
      `Stated confidence runs ${Math.round(calibrationGap * 100)} points above the actual pass rate — treat compile confidence as optimistic and declare expect postconditions so failures surface immediately.`
    );
  } else if (verdict === 'underconfident') {
    advice.push(
      `Actions verify ${Math.round(-calibrationGap * 100)} points more often than confidence suggests — the intents are landing; trust the plan and skip redundant pre-checks.`
    );
  } else if (verdict === 'well-calibrated') {
    advice.push('Confidence has tracked outcomes honestly this session — it is safe to gate execution on it.');
  }
  if (surprises.length > 0) {
    advice.push(
      `${surprises.length} high-confidence action(s) failed verification — read their expectedOutcome vs what actually happened (get_session_trace) to find where the page model diverged.`
    );
  }
  if (verdict === 'insufficient-data' && samples.length > 0) {
    advice.push(`Only ${samples.length} executed action(s) so far — calibration firms up after 3+.`);
  }

  return { samples: samples.length, brierScore, calibrationGap, verdict, bands, surprises, advice };
}

/** One-line calibration summary for embedding in narratives. */
export function calibrationSentence(c: CalibrationReport): string {
  if (c.verdict === 'insufficient-data') {
    return c.samples === 0
      ? 'No calibration data yet this session.'
      : `Calibration still forming (${c.samples} executed action(s) so far).`;
  }
  const gap = Math.round((c.calibrationGap ?? 0) * 100);
  return c.verdict === 'well-calibrated'
    ? `This session the agent's confidence has been trustworthy (${c.samples} actions, Brier ${c.brierScore}).`
    : c.verdict === 'overconfident'
      ? `This session the agent has been overconfident by ~${gap} points (${c.samples} actions) — discount stated confidence accordingly.`
      : `This session the agent has been underconfident by ~${-gap} points (${c.samples} actions) — outcomes beat stated confidence.`;
}

// ─── Decision explanation ────────────────────────────────────────────────────

export interface DecisionExplanation {
  found: boolean;
  intent?: string;
  /** The decision, retold in plain language — read top to bottom. */
  story: string[];
  decision?: {
    winner: string;
    runnerUp?: string;
    margin?: number;
    compileConfidence?: number;
    risk?: string;
    executed?: boolean;
    passed?: boolean;
  };
  /** The single cheapest change that would have flipped the choice, if any. */
  counterfactual?: string;
  calibrationContext: string;
  ephemeral: true;
}

/**
 * Turn a compiled decision's records into a plain-English story. Both inputs
 * are optional — the story degrades gracefully to whatever was recorded.
 */
export function explainDecision(
  planEvent: BehaviorEvent | null,
  observation: JSpaceObservation | null,
  calibration: CalibrationReport
): DecisionExplanation {
  const story: string[] = [];
  const calibrationContext = calibrationSentence(calibration);

  if (!planEvent && !observation) {
    return {
      found: false,
      story: [
        'No compiled decision found to explain. Run compile_verified_action (or run_jacobian_lens) first — every decision is recorded automatically.',
      ],
      calibrationContext,
      ephemeral: true,
    };
  }

  const d = planEvent?.data ?? {};
  const intent = String(d.intent ?? observation?.intent ?? '');
  const winner = observation?.winner ?? String(d.target ?? 'the chosen element');
  const pct = (v: unknown) => `${Math.round(Number(v) * 100)}%`;

  // What was chosen, and why.
  let opening = `Asked to "${intent}", Splice chose **${winner}**`;
  if (typeof d.confidence === 'number') opening += ` at ${pct(d.confidence)} compile confidence${d.risk ? ` (${d.risk} risk)` : ''}`;
  opening += '.';
  if (d.why) opening += ` Reason recorded at compile time: ${String(d.why)}`;
  story.push(opening);

  // How close it was, and what carried it.
  if (observation) {
    if (observation.runnerUp) {
      story.push(
        `The runner-up was "${observation.runnerUp}", ${Number(observation.margin.toFixed(2))} points behind${
          typeof observation.winnerProbability === 'number' ? ` — a ${pct(observation.winnerProbability)} softmax read` : ''
        }.`
      );
    }
    if (observation.conceptSensitivities && observation.conceptSensitivities.length > 0) {
      const top = observation.conceptSensitivities[0];
      if (Math.abs(top.sensitivity) > 1e-6) {
        story.push(
          `The choice was carried mainly by the "${top.concept}" axis${
            typeof observation.effectiveDimension === 'number'
              ? ` (the decision occupied an effectively ${observation.effectiveDimension}-dimensional workspace)`
              : ''
          }.`
        );
      }
    }
    story.push(
      observation.robust
        ? 'It was a robust choice: deleting any single word from the intent still elects the same target.'
        : 'It was a fragile choice: at least one word in the intent is load-bearing — remove it and the target flips.'
    );
    if (observation.inertTokens.length > 0) {
      story.push(
        `Dead weight: ${observation.inertTokens.map((t) => `"${t}"`).join(', ')} matched nothing on the page — the intent works without ${observation.inertTokens.length > 1 ? 'them' : 'it'}.`
      );
    }
  }

  // What was expected, and what actually happened.
  if (d.expectedOutcome) story.push(`Expected at compile time: ${String(d.expectedOutcome)}`);
  if (d.executed === true) {
    story.push(
      d.passed !== false
        ? 'It executed, and verification passed.'
        : 'It executed, but verification FAILED — the page did not respond the way the plan predicted. Check get_session_trace for the delta.'
    );
  } else if (planEvent) {
    story.push('It was compiled but not executed (planning only, or preconditions were not met).');
  }

  story.push(calibrationContext);

  const counterfactual = observation?.nearestFlip
    ? `Cheapest flip: ${observation.nearestFlip.direction === 'upweight' ? 'amplifying' : 'downweighting'} "${observation.nearestFlip.token}" by ${Math.round(
        observation.nearestFlip.distance * 100
      )}% would have elected ${observation.nearestFlip.rival ? `"${observation.nearestFlip.rival}"` : 'the rival'} instead.`
    : undefined;
  if (counterfactual) story.push(counterfactual);

  return {
    found: true,
    intent,
    story,
    decision: {
      winner,
      ...(observation?.runnerUp ? { runnerUp: observation.runnerUp } : {}),
      ...(observation ? { margin: Number(observation.margin.toFixed(3)) } : {}),
      ...(typeof d.confidence === 'number' ? { compileConfidence: Number(d.confidence) } : {}),
      ...(d.risk ? { risk: String(d.risk) } : {}),
      ...(typeof d.executed === 'boolean' ? { executed: d.executed } : {}),
      ...(typeof d.passed === 'boolean' ? { passed: d.passed } : {}),
    },
    ...(counterfactual ? { counterfactual } : {}),
    calibrationContext,
    ephemeral: true,
  };
}
