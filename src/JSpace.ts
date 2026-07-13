/**
 * Splice J-Space — looking inside the intent→target Jacobian.
 *
 * The candidate ranking's keyword term is linear: each intent token adds an
 * exact, known amount to each candidate's score. That means the Jacobian
 * J[token][candidate] = ∂score/∂(token weight) is not an approximation — we
 * read it directly off the instrumented scorer. This module explores the
 * space that matrix lives in:
 *
 *  - geometry: which tokens pull in the same direction (collinear/redundant)
 *    and which discriminate independently (orthogonal)
 *  - spectrum: an amateur SVD via power iteration — the dominant sensitivity
 *    mode (which token mix moves which candidate mix the most) and how much
 *    of the total sensitivity it captures
 *  - flip boundaries: for each token, the exact reweighting at which the
 *    chosen target flips to a rival — the distance to the decision boundary
 *
 * Honest limits, stated once: the query-phrase bonus and the exact-text
 * penalty depend on tokens jointly (nonlinear), so they are held fixed as
 * constants here. The finite-difference lens re-runs the real scorer and is
 * reported alongside as the empirical cross-check; where they disagree, the
 * nonlinear terms are the reason.
 */

export interface JSpaceCandidate {
  id: string;
  label: string;
  score: number;
  keywordContributions: number[];
  queryBonus: number;
  structuralScore: number;
}

export interface TokenGeometry {
  /** L2 norm of each token's row — its total leverage over the candidate set. */
  tokenLeverage: Array<{ token: string; leverage: number }>;
  /** Token pairs whose rows point the same way (cos ≥ 0.98): interchangeable signal. */
  redundantPairs: Array<{ a: string; b: string; cosine: number }>;
  /** Token pairs with |cos| ≤ 0.02: independent discriminators. */
  orthogonalPairs: Array<{ a: string; b: string; cosine: number }>;
  /** Tokens contributing nothing to any candidate — dead weight in the intent. */
  inertTokens: string[];
}

export interface JSpaceSpectrum {
  /** Largest singular value — the gain of the dominant sensitivity mode. */
  sigma1: number;
  /** Second singular value (0 if the matrix is effectively rank one). */
  sigma2: number;
  /** Token mix of the dominant mode (unit vector, aligned with tokens). */
  dominantTokenMix: Array<{ token: string; weight: number }>;
  /** Candidate mix the dominant mode moves (aligned with candidates). */
  dominantCandidateMix: Array<{ label: string; weight: number }>;
  /** σ1² / total sensitivity energy: 1.0 means one mode explains everything. */
  dominantModeEnergy: number;
}

export interface FlipBoundary {
  token: string;
  /** The rival the winner most easily flips to by reweighting this token. */
  rival?: string;
  /** Weight (baseline 1) at which the flip happens; 0 = deleting the token's contribution. */
  requiredWeight?: number;
  /** |requiredWeight - 1|: distance to the decision boundary along this token axis. */
  distance?: number;
  /** 'downweight' flips by weakening the token, 'upweight' by amplifying it. */
  direction?: 'downweight' | 'upweight';
  /** True when no reweighting of this token alone can change the winner. */
  unreachable: boolean;
}

export interface JSpaceReport {
  intent: string;
  tokens: string[];
  candidates: Array<{ label: string; score: number }>;
  winner: string;
  runnerUp?: string;
  margin: number;
  /** J[token][candidate]: exact marginal contribution of each token to each candidate. */
  jacobian: number[][];
  geometry: TokenGeometry;
  spectrum: JSpaceSpectrum;
  flipBoundaries: FlipBoundary[];
  /** True when zeroing any single token still leaves the same winner. */
  winnerRobustToTokenDeletion: boolean;
  interpretation: string[];
  method: string;
}

// ─── small dense linear algebra (matrices here are at most 8×8) ─────────────

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a));

function matVec(m: number[][], v: number[]): number[] {
  return m.map((row) => dot(row, v));
}

/** Power iteration on the symmetric PSD matrix A; deterministic start. */
function powerIteration(a: number[][], iterations = 60): { value: number; vector: number[] } {
  const n = a.length;
  let v = new Array(n).fill(1 / Math.sqrt(n));
  let value = 0;
  for (let it = 0; it < iterations; it++) {
    const next = matVec(a, v);
    const nextNorm = norm(next);
    if (nextNorm < 1e-12) return { value: 0, vector: v };
    v = next.map((x) => x / nextNorm);
    value = dot(matVec(a, v), v);
  }
  return { value, vector: v };
}

// ─── the explorer ───────────────────────────────────────────────────────────

export function exploreJSpace(intent: string, tokens: string[], allCandidates: JSpaceCandidate[], topK = 6): JSpaceReport {
  const candidates = allCandidates.slice(0, Math.max(2, topK));
  const nTokens = tokens.length;
  const nCands = candidates.length;

  // J rows = tokens, columns = candidates.
  const jacobian: number[][] = tokens.map((_, i) => candidates.map((c) => c.keywordContributions[i] ?? 0));

  const winner = candidates[0];
  const runnerUp = candidates[1];
  const margin = runnerUp ? winner.score - runnerUp.score : winner.score;

  // ── Geometry ──
  const tokenLeverage = tokens.map((token, i) => ({ token, leverage: Number(norm(jacobian[i]).toFixed(3)) }));
  const redundantPairs: TokenGeometry['redundantPairs'] = [];
  const orthogonalPairs: TokenGeometry['orthogonalPairs'] = [];
  for (let i = 0; i < nTokens; i++) {
    for (let j = i + 1; j < nTokens; j++) {
      const ni = norm(jacobian[i]);
      const nj = norm(jacobian[j]);
      if (ni < 1e-9 || nj < 1e-9) continue;
      const cosine = Number((dot(jacobian[i], jacobian[j]) / (ni * nj)).toFixed(3));
      if (cosine >= 0.98) redundantPairs.push({ a: tokens[i], b: tokens[j], cosine });
      else if (Math.abs(cosine) <= 0.02) orthogonalPairs.push({ a: tokens[i], b: tokens[j], cosine });
    }
  }
  const inertTokens = tokens.filter((_, i) => norm(jacobian[i]) < 1e-9);

  // ── Spectrum: power iteration on J·Jᵀ (token space), deflate for σ2. ──
  const jjt: number[][] = Array.from({ length: nTokens }, (_, i) =>
    Array.from({ length: nTokens }, (_, j) => dot(jacobian[i], jacobian[j]))
  );
  const first = powerIteration(jjt);
  const sigma1 = Math.sqrt(Math.max(0, first.value));
  // Deflation: A' = A − λ₁ v₁ v₁ᵀ
  const deflated = jjt.map((row, i) => row.map((val, j) => val - first.value * first.vector[i] * first.vector[j]));
  const second = powerIteration(deflated);
  const sigma2 = Math.sqrt(Math.max(0, second.value));
  const traceEnergy = jjt.reduce((s, row, i) => s + row[i], 0);
  const candidateMixRaw = sigma1 > 1e-9
    ? Array.from({ length: nCands }, (_, j) => tokens.reduce((s, _, i) => s + jacobian[i][j] * first.vector[i], 0) / sigma1)
    : new Array(nCands).fill(0);

  const spectrum: JSpaceSpectrum = {
    sigma1: Number(sigma1.toFixed(3)),
    sigma2: Number(sigma2.toFixed(3)),
    dominantTokenMix: tokens.map((token, i) => ({ token, weight: Number(first.vector[i].toFixed(3)) })),
    dominantCandidateMix: candidates.map((c, j) => ({ label: c.label.slice(0, 60), weight: Number(candidateMixRaw[j].toFixed(3)) })),
    dominantModeEnergy: traceEnergy > 1e-9 ? Number((first.value / traceEnergy).toFixed(3)) : 0,
  };

  // ── Flip boundaries: score_j(w) = const_j + Σᵢ wᵢ·J[i][j], baseline wᵢ = 1. ──
  const flipBoundaries: FlipBoundary[] = tokens.map((token, i) => {
    let best: FlipBoundary = { token, unreachable: true };
    for (let j = 1; j < nCands; j++) {
      const rival = candidates[j];
      const rivalMargin = winner.score - rival.score;
      const delta = jacobian[i][0] - jacobian[i][j]; // winner-vs-rival leverage of this token
      if (Math.abs(delta) < 1e-9) continue;
      let requiredWeight: number;
      let direction: 'downweight' | 'upweight';
      if (delta > 0) {
        requiredWeight = 1 - rivalMargin / delta;
        direction = 'downweight';
        if (requiredWeight < 0) continue; // even deleting the token cannot flip to this rival
      } else {
        requiredWeight = 1 + rivalMargin / -delta;
        direction = 'upweight';
      }
      const distance = Math.abs(requiredWeight - 1);
      if (best.unreachable || distance < (best.distance ?? Infinity)) {
        best = {
          token,
          rival: rival.label.slice(0, 60),
          requiredWeight: Number(requiredWeight.toFixed(3)),
          distance: Number(distance.toFixed(3)),
          direction,
          unreachable: false,
        };
      }
    }
    return best;
  });

  // Winner robustness: does zeroing any single token's contribution flip the ranking?
  const winnerRobustToTokenDeletion = tokens.every((_, i) => {
    const winnerWithout = winner.score - jacobian[i][0];
    return candidates.every((c, j) => j === 0 || winnerWithout >= c.score - jacobian[i][j]);
  });

  // ── Interpretation, in plain language. ──
  const interpretation: string[] = [];
  const strongest = [...tokenLeverage].sort((a, b) => b.leverage - a.leverage)[0];
  if (strongest && strongest.leverage > 0) {
    interpretation.push(`"${strongest.token}" carries the most leverage over the candidate set (‖row‖ = ${strongest.leverage}).`);
  }
  if (inertTokens.length > 0) {
    interpretation.push(`Inert token(s) matching nothing on this page: ${inertTokens.join(', ')} — removing them changes nothing.`);
  }
  if (redundantPairs.length > 0) {
    interpretation.push(`Redundant pair(s): ${redundantPairs.map((p) => `${p.a}+${p.b}`).join(', ')} — they pull the same candidates; either alone preserves the choice direction.`);
  }
  interpretation.push(
    spectrum.dominantModeEnergy >= 0.95
      ? `The sensitivity is effectively rank one (mode energy ${spectrum.dominantModeEnergy}): all tokens act along a single winner-vs-rest axis.`
      : `Sensitivity splits across modes (dominant mode energy ${spectrum.dominantModeEnergy}, σ1 ${spectrum.sigma1} vs σ2 ${spectrum.sigma2}) — different tokens discriminate between different candidates.`
  );
  const nearest = flipBoundaries.filter((f) => !f.unreachable).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
  interpretation.push(
    nearest
      ? `Nearest decision boundary: ${nearest.direction} "${nearest.token}" to weight ${nearest.requiredWeight} and the choice flips to "${nearest.rival}".`
      : 'No single-token reweighting can flip this choice — the winner is outside any one token\'s reach.'
  );
  interpretation.push(
    winnerRobustToTokenDeletion
      ? 'Deleting any single token still elects the same winner (robust choice).'
      : 'At least one token is load-bearing: deleting it flips the winner.'
  );

  return {
    intent,
    tokens,
    candidates: candidates.map((c) => ({ label: c.label.slice(0, 80), score: c.score })),
    winner: winner.label.slice(0, 80),
    runnerUp: runnerUp?.label.slice(0, 80),
    margin,
    jacobian,
    geometry: { tokenLeverage, redundantPairs, orthogonalPairs, inertTokens },
    spectrum,
    flipBoundaries,
    winnerRobustToTokenDeletion,
    interpretation,
    method:
      'Exact analytic Jacobian of the linear keyword term, read from the instrumented production scorer. ' +
      'Query-phrase bonus and exact-text penalty are token-joint (nonlinear) and held constant; the finite-difference lens is the empirical cross-check.',
  };
}
