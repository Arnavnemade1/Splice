/**
 * Splice J-Space Map — the session's decision geometry, accumulated.
 *
 * JSpace.ts answers "what does the J-space of THIS decision look like?".
 * This module answers "what does the J-space of the WHOLE SESSION look
 * like?": every time Splice compiles an action or runs the Jacobian lens, the
 * decision's coordinates — effective dimensionality, carrying concepts,
 * distance to the nearest flip boundary, softmax confidence — are recorded as
 * one observation on a running map. The map is what a single report cannot
 * be: a picture of where the agent's choices live, which concept axes carry
 * them run-wide, which words the agent keeps paying for that never matter,
 * and how often it operates near a decision boundary.
 *
 * Nothing here touches the browser. Observations arrive pre-computed (the
 * exact analytic J-space is pure local math over the instrumented scorer);
 * this module only accumulates and aggregates. The honest-scope note from
 * JSpace.ts carries over verbatim: this maps Splice's OWN pre-action decision
 * workspace, not the calling model's hidden activations.
 */

import type { JSpaceReport } from './JSpace.js';

/** One decision, reduced to its J-space coordinates. */
export interface JSpaceObservation {
  timestamp: number;
  /** 'action' — captured passively from compile_verified_action;
   *  'lens'   — captured from an explicit run_jacobian_lens probe. */
  source: 'action' | 'lens';
  intent: string;
  url?: string;
  winner: string;
  runnerUp?: string;
  margin: number;
  tokens: string[];
  /** Words in the intent that matched nothing — paid for, never used. */
  inertTokens: string[];
  /** Whether the winner survives every single-token deletion. */
  robust: boolean;
  /** Closest reachable flip boundary across all tokens (absent = no
   *  single-token reweighting can change the winner). */
  nearestFlip?: { token: string; rival?: string; distance: number; direction?: 'downweight' | 'upweight' };
  /** From the decision workspace, when candidate features were captured: */
  effectiveDimension?: number;
  winnerProbability?: number;
  /** Concept sensitivities of the emitted choice (the decision Jacobian). */
  conceptSensitivities?: Array<{ concept: string; sensitivity: number }>;
  /** Concepts loading on the dominant workspace axis. */
  dominantConcepts?: string[];
}

export interface JSpaceMapReport {
  generatedAt: number;
  observations: number;
  bySource: { action: number; lens: number };
  windowMs: number;
  /** How low-dimensional the session's decisions were, workspace-wide. */
  dimensionality: { mean: number; min: number; max: number; latest: number } | null;
  /** Softmax confidence of emitted choices across the session. */
  confidence: { mean: number; belowHalf: number } | null;
  /** Per-decision track for trend displays, oldest → newest (capped). */
  trajectory: Array<{
    at: number;
    source: 'action' | 'lens';
    intent: string;
    winner: string;
    effectiveDimension?: number;
    winnerProbability?: number;
    robust: boolean;
    flipDistance?: number;
  }>;
  /** Which concept axes carried the session's decisions, ranked by mean
   *  absolute softmax sensitivity. */
  conceptLeaderboard: Array<{
    concept: string;
    meanAbsSensitivity: number;
    /** Decisions in which this concept was the single most sensitive axis. */
    timesDominant: number;
    appearances: number;
  }>;
  fragility: {
    robustDecisions: number;
    fragileDecisions: number;
    /** Decisions whose nearest flip boundary sat within 0.5 of baseline
     *  weight — chosen while standing close to the edge. */
    nearBoundary: Array<{ intent: string; winner: string; token: string; rival?: string; distance: number }>;
  };
  /** Tokens that were inert in 2+ decisions — recurring dead weight. */
  recurringInertTokens: Array<{ token: string; occurrences: number }>;
  recommendations: string[];
  interpretation: string[];
  scope: string;
}

const MAX_OBSERVATIONS = 400;
const TRAJECTORY_CAP = 60;
const NEAR_BOUNDARY_DISTANCE = 0.5;

/** Reduce a full J-space report to one observation on the map. */
export function observationFromReport(report: JSpaceReport, source: 'action' | 'lens', url?: string): JSpaceObservation {
  const nearest = report.flipBoundaries
    .filter((f) => !f.unreachable && typeof f.distance === 'number')
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
  const ws = report.workspace;
  return {
    timestamp: Date.now(),
    source,
    intent: report.intent.slice(0, 120),
    ...(url ? { url: url.slice(0, 160) } : {}),
    winner: report.winner,
    ...(report.runnerUp ? { runnerUp: report.runnerUp } : {}),
    margin: report.margin,
    tokens: report.tokens,
    inertTokens: report.geometry.inertTokens,
    robust: report.winnerRobustToTokenDeletion,
    ...(nearest
      ? { nearestFlip: { token: nearest.token, rival: nearest.rival, distance: nearest.distance!, direction: nearest.direction } }
      : {}),
    ...(ws
      ? {
          effectiveDimension: ws.effectiveDimension,
          winnerProbability: ws.winnerProbability,
          conceptSensitivities: ws.decisionJacobian.map((d) => ({ concept: d.concept, sensitivity: d.sensitivity })),
          dominantConcepts: ws.conceptDirections[0]?.dominantConcepts.map((c) => c.concept) ?? [],
        }
      : {}),
  };
}

/** Session-scoped accumulator. One instance lives on the BrowserManager. */
export class JSpaceMap {
  private observations: JSpaceObservation[] = [];

  record(observation: JSpaceObservation): void {
    this.observations.push(observation);
    if (this.observations.length > MAX_OBSERVATIONS) {
      this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS);
    }
  }

  get size(): number {
    return this.observations.length;
  }

  get lastObservedAt(): number | null {
    return this.observations.length > 0 ? this.observations[this.observations.length - 1].timestamp : null;
  }

  buildReport(): JSpaceMapReport {
    const obs = this.observations;
    const n = obs.length;
    const round = (v: number, d = 3) => Number(v.toFixed(d));

    const withDim = obs.filter((o) => typeof o.effectiveDimension === 'number');
    const dims = withDim.map((o) => o.effectiveDimension!);
    const dimensionality = dims.length > 0
      ? {
          mean: round(dims.reduce((a, b) => a + b, 0) / dims.length, 2),
          min: Math.min(...dims),
          max: Math.max(...dims),
          latest: dims[dims.length - 1],
        }
      : null;

    const probs = obs.filter((o) => typeof o.winnerProbability === 'number').map((o) => o.winnerProbability!);
    const confidence = probs.length > 0
      ? {
          mean: round(probs.reduce((a, b) => a + b, 0) / probs.length),
          belowHalf: probs.filter((p) => p < 0.5).length,
        }
      : null;

    // Concept leaderboard: which axes actually carried decisions, session-wide.
    const conceptAgg = new Map<string, { absSum: number; appearances: number; timesDominant: number }>();
    for (const o of obs) {
      if (!o.conceptSensitivities || o.conceptSensitivities.length === 0) continue;
      const top = o.conceptSensitivities.reduce((a, b) => (Math.abs(b.sensitivity) > Math.abs(a.sensitivity) ? b : a));
      for (const { concept, sensitivity } of o.conceptSensitivities) {
        const entry = conceptAgg.get(concept) ?? { absSum: 0, appearances: 0, timesDominant: 0 };
        entry.absSum += Math.abs(sensitivity);
        entry.appearances += 1;
        if (concept === top.concept && Math.abs(top.sensitivity) > 1e-6) entry.timesDominant += 1;
        conceptAgg.set(concept, entry);
      }
    }
    const conceptLeaderboard = [...conceptAgg.entries()]
      .map(([concept, e]) => ({
        concept,
        meanAbsSensitivity: round(e.absSum / e.appearances),
        timesDominant: e.timesDominant,
        appearances: e.appearances,
      }))
      .sort((a, b) => b.meanAbsSensitivity - a.meanAbsSensitivity);

    const nearBoundary = obs
      .filter((o) => o.nearestFlip && o.nearestFlip.distance <= NEAR_BOUNDARY_DISTANCE)
      .map((o) => ({
        intent: o.intent,
        winner: o.winner,
        token: o.nearestFlip!.token,
        rival: o.nearestFlip!.rival,
        distance: o.nearestFlip!.distance,
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    const robustDecisions = obs.filter((o) => o.robust).length;

    const inertCounts = new Map<string, number>();
    for (const o of obs) for (const t of o.inertTokens) inertCounts.set(t, (inertCounts.get(t) ?? 0) + 1);
    const recurringInertTokens = [...inertCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([token, occurrences]) => ({ token, occurrences }))
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10);

    const trajectory = obs.slice(-TRAJECTORY_CAP).map((o) => ({
      at: o.timestamp,
      source: o.source,
      intent: o.intent.slice(0, 80),
      winner: o.winner.slice(0, 60),
      ...(typeof o.effectiveDimension === 'number' ? { effectiveDimension: o.effectiveDimension } : {}),
      ...(typeof o.winnerProbability === 'number' ? { winnerProbability: o.winnerProbability } : {}),
      robust: o.robust,
      ...(o.nearestFlip ? { flipDistance: o.nearestFlip.distance } : {}),
    }));

    // ── Recommendations: computed from this session's map, not generic advice. ──
    const recommendations: string[] = [];
    if (recurringInertTokens.length > 0) {
      recommendations.push(
        `Drop recurring dead-weight words from intents: ${recurringInertTokens.slice(0, 4).map((t) => `"${t.token}"`).join(', ')} matched nothing in ${recurringInertTokens[0].occurrences}+ decisions. Shorter intents rank faster and flip less.`
      );
    }
    if (n > 0 && nearBoundary.length / n > 0.3) {
      recommendations.push(
        `${nearBoundary.length} of ${n} decisions sat within ${NEAR_BOUNDARY_DISTANCE} of a flip boundary. Quote the exact on-page label (or run optimize_prompt) so the choice stops depending on one fragile word.`
      );
    }
    if (confidence && confidence.belowHalf > 0) {
      recommendations.push(
        `${confidence.belowHalf} decision(s) were emitted at under 50% softmax confidence — near-tie readouts. Before acting on those pages, disambiguate with diagnose_agent_state or a narrower intent.`
      );
    }
    const topConcept = conceptLeaderboard[0];
    if (topConcept && n >= 3 && topConcept.timesDominant / n > 0.8) {
      recommendations.push(
        `A single concept axis ("${topConcept.concept}") dominated ${topConcept.timesDominant} of ${n} decisions. The workspace is being used one-dimensionally — exact-label quoting (queryMatch) usually separates candidates more decisively than keyword overlap.`
      );
    }
    if (recommendations.length === 0 && n > 0) {
      recommendations.push('No structural weaknesses detected: choices were robust, confident, and clear of flip boundaries. Keep the current intent style.');
    }

    const interpretation: string[] = [];
    if (n === 0) {
      interpretation.push('No decisions mapped yet. The map fills itself as compile_verified_action and run_jacobian_lens are used — no setup required.');
    } else {
      interpretation.push(
        `${n} decision(s) mapped (${obs.filter((o) => o.source === 'action').length} from compiled actions, ${obs.filter((o) => o.source === 'lens').length} from lens probes).`
      );
      if (dimensionality) {
        interpretation.push(
          `Decisions lived in an effectively ${dimensionality.mean}-dimensional workspace on average (range ${dimensionality.min}–${dimensionality.max}).`
        );
      }
      interpretation.push(
        `${robustDecisions} of ${n} choices survive any single-token deletion; ${nearBoundary.length} were made within ${NEAR_BOUNDARY_DISTANCE} of a decision boundary.`
      );
      if (topConcept) {
        interpretation.push(
          `"${topConcept.concept}" is the session's load-bearing concept axis (mean |∂P(winner)| ${topConcept.meanAbsSensitivity}, dominant in ${topConcept.timesDominant} decision(s)).`
        );
      }
    }

    return {
      generatedAt: Date.now(),
      observations: n,
      bySource: {
        action: obs.filter((o) => o.source === 'action').length,
        lens: obs.filter((o) => o.source === 'lens').length,
      },
      windowMs: n > 0 ? obs[n - 1].timestamp - obs[0].timestamp : 0,
      dimensionality,
      confidence,
      trajectory,
      conceptLeaderboard,
      fragility: { robustDecisions, fragileDecisions: n - robustDecisions, nearBoundary },
      recurringInertTokens,
      recommendations,
      interpretation,
      scope:
        'This maps Splice\'s own pre-action decision workspace across the session — a structural J-space analog, ' +
        'not the calling model\'s hidden activations. Observations are recorded automatically; nothing extra to call.',
    };
  }
}

/** Human rendering of the session map, persisted next to the JSON. */
export function renderJSpaceMapMarkdown(report: JSpaceMapReport): string {
  const lines: string[] = [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  lines.push('# Splice J-Space Session Map');
  lines.push('');
  lines.push(`Generated ${new Date(report.generatedAt).toISOString()} — ${report.observations} decision(s) over ${Math.round(report.windowMs / 1000)}s.`);
  lines.push('');
  for (const line of report.interpretation) lines.push(`- ${line}`);
  lines.push('');

  if (report.dimensionality) {
    lines.push('## Dimensionality');
    lines.push('');
    lines.push(`Mean effective dimension **${report.dimensionality.mean}** (min ${report.dimensionality.min}, max ${report.dimensionality.max}, latest ${report.dimensionality.latest}).`);
    if (report.confidence) {
      lines.push(`Mean winner confidence **${pct(report.confidence.mean)}**; ${report.confidence.belowHalf} decision(s) below 50%.`);
    }
    lines.push('');
  }

  if (report.conceptLeaderboard.length > 0) {
    lines.push('## Concept leaderboard');
    lines.push('');
    lines.push('| Concept | mean \\|∂P(winner)\\| | dominant in | seen in |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of report.conceptLeaderboard) {
      lines.push(`| ${c.concept} | ${c.meanAbsSensitivity} | ${c.timesDominant} decision(s) | ${c.appearances} |`);
    }
    lines.push('');
  }

  lines.push('## Fragility');
  lines.push('');
  lines.push(`${report.fragility.robustDecisions} robust / ${report.fragility.fragileDecisions} fragile decision(s).`);
  if (report.fragility.nearBoundary.length > 0) {
    lines.push('');
    lines.push('Decisions made near a flip boundary (closest first):');
    lines.push('');
    for (const f of report.fragility.nearBoundary) {
      lines.push(`- "${f.intent}" → **${f.winner}** — reweighting "${f.token}" by ${f.distance} flips it${f.rival ? ` to "${f.rival}"` : ''}.`);
    }
  }
  lines.push('');

  if (report.recurringInertTokens.length > 0) {
    lines.push('## Recurring inert tokens');
    lines.push('');
    lines.push(report.recurringInertTokens.map((t) => `\`${t.token}\` (×${t.occurrences})`).join(', '));
    lines.push('');
  }

  lines.push('## Recommendations');
  lines.push('');
  for (const r of report.recommendations) lines.push(`- ${r}`);
  lines.push('');
  lines.push(`> ${report.scope}`);
  lines.push('');
  return lines.join('\n');
}
