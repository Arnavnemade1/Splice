/**
 * Splice J-Space Detector — hazard detection over decision geometry.
 *
 * JSpace.ts DESCRIBES a decision's geometry; this module DETECTS when that
 * geometry is dangerous. Every compiled action and lens probe is screened
 * against a battery of detectors, each a precise predicate over quantities
 * the J-space exploration already computes exactly:
 *
 *  per-decision (screen one JSpaceReport):
 *   - ambiguous_readout   near-tie: thin margin, soft softmax, high readout
 *                         entropy — the "choice" is closer to a coin flip
 *                         than a decision
 *   - aliased_candidates  two candidates the scorer literally cannot tell
 *                         apart: near-identical concept activations (cosine)
 *                         or duplicate visible labels at close scores — the
 *                         classic "which Delete button?" hazard
 *   - boundary_proximity  the choice sits within a small reweighting of
 *                         flipping to a rival
 *   - rank_one_intent     every token pushes along one winner-vs-rest axis
 *                         (dominant mode energy ≈ 1): the words are
 *                         redundant, not corroborating
 *   - inert_majority      most of the intent matched nothing — the phrasing
 *                         is mostly noise
 *   - concept_conflict    the winner won DESPITE a strong negative concept
 *                         (obstruction, external domain, disabled-adjacent):
 *                         it prevailed under protest
 *   - dimension_collapse  a crowded field ranked along a single axis with a
 *                         soft readout — weak discrimination
 *
 *  session trends (screen the J-space map's observation history):
 *   - unstable_target     the same intent elected different winners over
 *                         time: the page drifted under the agent
 *   - fragility_trend     a streak of recent decisions made near a boundary
 *                         or fragile to single-token deletion
 *   - chronic_ambiguity   half or more of the session's readouts were soft
 *
 * Detections are advisory: they attach to plan evidence and reports but
 * never block or rescore an action — the caller stays in charge. Honest
 * scope as everywhere: these are hazards in Splice's own pre-action decision
 * workspace, not claims about the calling model's internals.
 */

import type { JSpaceReport } from './JSpace.js';
import type { JSpaceObservation } from './JSpaceMap.js';

export type DetectionSeverity = 'info' | 'warning' | 'critical';

export interface JSpaceDetection {
  type:
    | 'ambiguous_readout'
    | 'aliased_candidates'
    | 'boundary_proximity'
    | 'rank_one_intent'
    | 'inert_majority'
    | 'concept_conflict'
    | 'dimension_collapse'
    | 'unstable_target'
    | 'fragility_trend'
    | 'chronic_ambiguity';
  severity: DetectionSeverity;
  title: string;
  /** Concrete numbers backing the detection — never vibes. */
  evidence: string[];
  /** What to do about it, phrased for the acting agent. */
  recommendation: string;
  intent: string;
  winner?: string;
  at: number;
}

export interface DetectionSummary {
  total: number;
  bySeverity: Record<DetectionSeverity, number>;
  byType: Record<string, number>;
  /** Most recent detections, newest first. */
  recent: JSpaceDetection[];
  /** Trend detections over the session's observation history (computed live). */
  sessionTrends: JSpaceDetection[];
  interpretation: string;
}

/** Detection thresholds, exported so they are inspectable and testable. */
export const DETECTOR_THRESHOLDS = {
  /** ambiguous_readout */
  marginWarning: 2,
  marginCritical: 0.75,
  softmaxWarning: 0.55,
  softmaxCritical: 0.4,
  entropyWarning: 0.9, // normalized readout entropy over top-K
  /** aliased_candidates */
  aliasCosine: 0.995,
  aliasScoreGap: 1.5,
  /** boundary_proximity */
  boundaryWarning: 0.35,
  boundaryCritical: 0.15,
  /** rank_one_intent */
  rankOneEnergy: 0.98,
  /** dimension_collapse */
  collapseDimension: 1.1,
  /** trends */
  fragileWindowSize: 5,
  fragileWindowMin: 3,
  chronicAmbiguityShare: 0.5,
} as const;

const MAX_DETECTIONS = 200;
const T = DETECTOR_THRESHOLDS;

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const cosine = (a: number[], b: number[]) => {
  const na = norm(a);
  const nb = norm(b);
  if (na < 1e-9 || nb < 1e-9) return 0;
  return a.reduce((s, x, i) => s + x * b[i], 0) / (na * nb);
};

/** Normalized Shannon entropy of the softmax readout over the candidate scores
 *  (same temperature as the decision workspace): 1 = uniform coin flip. */
export function readoutEntropy(scores: number[], temperature = 8): number {
  if (scores.length < 2) return 0;
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  const p = exps.map((e) => e / sum);
  const h = -p.reduce((s, x) => s + (x > 1e-12 ? x * Math.log(x) : 0), 0);
  return Number((h / Math.log(scores.length)).toFixed(3));
}

// ─── Per-decision detectors ─────────────────────────────────────────────────

/** Screen one decision's J-space report. Pure; returns findings only. */
export function screenDecision(report: JSpaceReport): JSpaceDetection[] {
  const detections: JSpaceDetection[] = [];
  const at = Date.now();
  const intent = report.intent.slice(0, 120);
  const winner = report.winner;
  const ws = report.workspace;
  const scores = report.candidates.map((c) => c.score);
  const entropy = readoutEntropy(scores);
  const p = ws?.winnerProbability;

  // ambiguous_readout
  const softMargin = report.runnerUp !== undefined && report.margin <= T.marginWarning;
  const softP = typeof p === 'number' && p <= T.softmaxWarning;
  const softEntropy = entropy >= T.entropyWarning && report.candidates.length >= 3;
  if (softMargin || softP || softEntropy) {
    const critical = report.margin <= T.marginCritical || (typeof p === 'number' && p <= T.softmaxCritical);
    detections.push({
      type: 'ambiguous_readout',
      severity: critical ? 'critical' : 'warning',
      title: `Near-tie readout: "${winner}" barely beats "${report.runnerUp ?? 'the field'}"`,
      evidence: [
        `margin ${Number(report.margin.toFixed(2))}`,
        ...(typeof p === 'number' ? [`softmax P(winner) ${Math.round(p * 100)}%`] : []),
        `readout entropy ${entropy} (1 = uniform)`,
      ],
      recommendation:
        'Treat this as a coin flip, not a decision. Quote the exact label of the element you mean, or run run_intent_experiment to find a phrasing that separates them.',
      intent,
      winner,
      at,
    });
  }

  // aliased_candidates: activation-vector near-duplicates or duplicate labels.
  if (ws && ws.activations.length >= 2) {
    for (let i = 0; i < ws.activations.length && detections.length < 12; i++) {
      for (let j = i + 1; j < ws.activations.length; j++) {
        const cos = cosine(ws.activations[i].vector, ws.activations[j].vector);
        const scoreGap = Math.abs((scores[i] ?? 0) - (scores[j] ?? 0));
        const sameLabel =
          ws.activations[i].label.trim().toLowerCase() === ws.activations[j].label.trim().toLowerCase();
        if ((cos >= T.aliasCosine && scoreGap <= T.aliasScoreGap) || (sameLabel && scoreGap <= T.aliasScoreGap)) {
          const involvesChoice = i === 0 && j === 1;
          detections.push({
            type: 'aliased_candidates',
            severity: involvesChoice ? 'critical' : 'warning',
            title: `Indistinguishable candidates: "${ws.activations[i].label}" vs "${ws.activations[j].label}"`,
            evidence: [
              sameLabel ? 'identical visible labels' : `concept-activation cosine ${Number(cos.toFixed(4))}`,
              `score gap ${Number(scoreGap.toFixed(2))}`,
              involvesChoice ? 'the pair IS the winner and runner-up' : 'pair sits below the winner',
            ],
            recommendation:
              'The scorer cannot tell these elements apart — label-based targeting is unsafe here. Disambiguate by surrounding context (row/section text), interact by element id from the semantic tree, or use inspect_viewport to pick visually.',
            intent,
            winner,
            at,
          });
          break; // one aliasing finding per anchor candidate is enough
        }
      }
    }
  }

  // boundary_proximity
  const reachable = report.flipBoundaries.filter((f) => !f.unreachable && typeof f.distance === 'number');
  const nearest = reachable.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
  if (nearest && nearest.distance! <= T.boundaryWarning) {
    detections.push({
      type: 'boundary_proximity',
      severity: nearest.distance! <= T.boundaryCritical ? 'critical' : 'warning',
      title: `Decision made ${Math.round(nearest.distance! * 100)}% from a flip boundary on "${nearest.token}"`,
      evidence: [
        `${nearest.direction === 'upweight' ? 'amplifying' : 'downweighting'} "${nearest.token}" to weight ${nearest.requiredWeight} flips the choice to "${nearest.rival}"`,
      ],
      recommendation:
        `The word "${nearest.token}" is doing nearly all the disambiguation. Keep it, and prefer quoting the exact target label so the choice stops hanging on one token.`,
      intent,
      winner,
      at,
    });
  }

  // rank_one_intent
  if (report.tokens.length >= 3 && report.spectrum.dominantModeEnergy >= T.rankOneEnergy) {
    detections.push({
      type: 'rank_one_intent',
      severity: report.margin <= 5 ? 'warning' : 'info',
      title: 'All intent words act along a single sensitivity axis',
      evidence: [
        `dominant mode energy ${report.spectrum.dominantModeEnergy} across ${report.tokens.length} tokens`,
        `σ1 ${report.spectrum.sigma1} vs σ2 ${report.spectrum.sigma2}`,
      ],
      recommendation:
        'The words are redundant, not corroborating — they all push the same winner-vs-rest direction. One exact quoted label would do the same work with fewer failure modes.',
      intent,
      winner,
      at,
    });
  }

  // inert_majority
  const inert = report.geometry.inertTokens.length;
  if (report.tokens.length >= 2 && inert >= Math.ceil(report.tokens.length / 2)) {
    detections.push({
      type: 'inert_majority',
      severity: 'warning',
      title: `${inert} of ${report.tokens.length} intent words matched nothing on this page`,
      evidence: [`inert: ${report.geometry.inertTokens.join(', ')}`],
      recommendation:
        'Most of the phrasing is noise on this page. Drop the inert words (optimize_prompt now strips recurring ones automatically) — shorter intents rank faster and flip less.',
      intent,
      winner,
      at,
    });
  }

  // concept_conflict: winner carried a strongly negative concept and won anyway.
  if (ws && ws.activations.length > 0) {
    const winnerVec = ws.activations[0].vector;
    const conflicts = ws.concepts
      .map((concept, k) => ({ concept, value: winnerVec[k] }))
      .filter((c) => c.value <= -10);
    if (conflicts.length > 0) {
      detections.push({
        type: 'concept_conflict',
        severity: 'warning',
        title: `Winner "${winner}" prevailed despite ${conflicts.map((c) => c.concept).join(' + ')}`,
        evidence: conflicts.map((c) => `${c.concept} = ${c.value}`),
        recommendation:
          'The chosen element carries an active penalty (obstruction, external domain, or disabled-adjacent) and won on keyword strength alone. Diagnose before acting — the click may hit an overlay or leave the site.',
        intent,
        winner,
        at,
      });
    }
  }

  // dimension_collapse: crowded field, one axis, soft readout.
  if (
    ws &&
    report.candidates.length >= 4 &&
    ws.effectiveDimension <= T.collapseDimension &&
    typeof p === 'number' &&
    p < 0.7
  ) {
    detections.push({
      type: 'dimension_collapse',
      severity: 'info',
      title: `A ${report.candidates.length}-candidate field ranked along ~one concept axis`,
      evidence: [
        `effective dimension ${ws.effectiveDimension}`,
        `softmax P(winner) ${Math.round(p * 100)}%`,
      ],
      recommendation:
        'The page offers little to discriminate on — candidates differ along a single axis. Add a structural cue (section, row, nearby text) to the intent, or target by element id.',
      intent,
      winner,
      at,
    });
  }

  return detections;
}

// ─── Session-trend detectors ────────────────────────────────────────────────

/** Screen the observation history for trends. Pure; computed on demand. */
export function screenTrends(observations: readonly JSpaceObservation[]): JSpaceDetection[] {
  const detections: JSpaceDetection[] = [];
  const at = Date.now();
  if (observations.length === 0) return detections;

  // unstable_target: same intent, different winners over time.
  const byIntent = new Map<string, JSpaceObservation[]>();
  for (const o of observations) {
    const key = o.intent.trim().toLowerCase();
    byIntent.set(key, [...(byIntent.get(key) ?? []), o]);
  }
  for (const [, group] of byIntent) {
    if (group.length < 2) continue;
    const winners = [...new Set(group.map((o) => o.winner))];
    if (winners.length > 1) {
      detections.push({
        type: 'unstable_target',
        severity: 'critical',
        title: `The same intent elected ${winners.length} different targets over time`,
        evidence: [
          `intent "${group[0].intent}"`,
          `winners over time: ${group.map((o) => `"${o.winner}"`).join(' → ')}`,
        ],
        recommendation:
          'The page changed under the agent (or the phrasing sits on a boundary). Re-observe with a delta before re-running this intent, and verify with declared expectations — do not assume the earlier target still exists.',
        intent: group[0].intent,
        at,
      });
    }
  }

  // fragility_trend: streak of near-boundary / fragile decisions.
  const recent = observations.slice(-T.fragileWindowSize);
  const fragile = recent.filter((o) => !o.robust || (o.nearestFlip && o.nearestFlip.distance <= 0.5));
  if (recent.length >= T.fragileWindowSize && fragile.length >= T.fragileWindowMin) {
    detections.push({
      type: 'fragility_trend',
      severity: 'warning',
      title: `${fragile.length} of the last ${recent.length} decisions were fragile or near a boundary`,
      evidence: fragile.map((o) => `"${o.intent}" → "${o.winner}"${o.nearestFlip ? ` (flip @ ${o.nearestFlip.distance})` : ' (not robust)'}`),
      recommendation:
        'The session is operating close to decision boundaries. Switch to exact-label quoting (run_intent_experiment recommends phrasings) before compounding fragile choices.',
      intent: recent[recent.length - 1].intent,
      at,
    });
  }

  // chronic_ambiguity: most readouts soft.
  const withP = observations.filter((o) => typeof o.winnerProbability === 'number');
  const soft = withP.filter((o) => (o.winnerProbability as number) <= T.softmaxWarning);
  if (withP.length >= 4 && soft.length / withP.length >= T.chronicAmbiguityShare) {
    detections.push({
      type: 'chronic_ambiguity',
      severity: 'warning',
      title: `${soft.length} of ${withP.length} decisions this session were near-tie readouts`,
      evidence: [`share ${Math.round((soft.length / withP.length) * 100)}% at or below ${Math.round(T.softmaxWarning * 100)}% softmax confidence`],
      recommendation:
        'This site\'s pages under-discriminate for the current intent style. Prefer fill_form / extract_structured primitives where they fit, and quote exact labels for compiled actions.',
      intent: observations[observations.length - 1].intent,
      at,
    });
  }

  return detections;
}

// ─── The detector engine (session-scoped, bounded log) ──────────────────────

export class JSpaceDetector {
  private log: JSpaceDetection[] = [];

  /** Screen a decision and record its findings. Returns them for attachment. */
  screen(report: JSpaceReport): JSpaceDetection[] {
    const found = screenDecision(report);
    if (found.length > 0) {
      this.log.push(...found);
      if (this.log.length > MAX_DETECTIONS) this.log.splice(0, this.log.length - MAX_DETECTIONS);
    }
    return found;
  }

  get size(): number {
    return this.log.length;
  }

  summarize(observations: readonly JSpaceObservation[] = [], limit = 8): DetectionSummary {
    const bySeverity: Record<DetectionSeverity, number> = { info: 0, warning: 0, critical: 0 };
    const byType: Record<string, number> = {};
    for (const d of this.log) {
      bySeverity[d.severity]++;
      byType[d.type] = (byType[d.type] ?? 0) + 1;
    }
    const sessionTrends = screenTrends(observations);
    const worst = bySeverity.critical > 0 ? 'critical' : bySeverity.warning > 0 ? 'warning' : this.log.length > 0 ? 'info' : 'clean';
    const interpretation =
      this.log.length === 0 && sessionTrends.length === 0
        ? 'No hazards detected — decision geometry has been clean this session.'
        : `${this.log.length} decision-level detection(s) (worst: ${worst})${
            sessionTrends.length > 0 ? ` and ${sessionTrends.length} session trend(s): ${sessionTrends.map((t) => t.type).join(', ')}` : ''
          }. Detections are advisory — they attach to plan evidence but never block an action.`;
    return {
      total: this.log.length,
      bySeverity,
      byType,
      recent: [...this.log].slice(-limit).reverse(),
      sessionTrends,
      interpretation,
    };
  }
}
