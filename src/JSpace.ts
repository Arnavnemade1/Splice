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
  features?: Record<string, number>;
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

/**
 * The decision workspace — Splice's local analog of a model-internal J-space.
 *
 * Before Splice emits an action, it represents every candidate as a vector of
 * named concept features (query match, keyword match, action affinity,
 * obstruction, …). The choice is a readout of that shared representation. This
 * structure asks the J-space questions of it: how low-dimensional is the space
 * the decision actually lives in, which concept-directions carry it, and how
 * sensitive is the emitted choice to each direction.
 *
 * Honest scope: this is Splice's OWN pre-action decision workspace, not the
 * calling model's hidden activations. Splice is external tooling and cannot
 * read an LLM's J-space. The analogy is structural — a low-dimensional space
 * where decision-relevant information is globally available before output —
 * not a claim of access to the model internals.
 */
export interface DecisionWorkspace {
  concepts: string[];
  /** Candidate × concept activation matrix — the workspace representation. */
  activations: Array<{ label: string; vector: number[] }>;
  /** Participation ratio of the centered activations: how many concept
   *  directions the decision actually occupies (1 = one axis decides it). */
  effectiveDimension: number;
  /** Concept directions (SVD axes of the discriminative subspace), each with
   *  its variance share and the concepts that load onto it. */
  conceptDirections: Array<{
    axis: number;
    singularValue: number;
    varianceShare: number;
    dominantConcepts: Array<{ concept: string; loading: number }>;
    /** Winner's coordinate along this axis vs the field's spread. */
    winnerCoordinate: number;
    separatesWinner: boolean;
  }>;
  /** ∂P(winner)/∂(scale of concept): how much the emitted choice's
   *  probability moves if each concept-direction is amplified. Softmax
   *  readout at the given temperature. */
  decisionJacobian: Array<{ concept: string; sensitivity: number; winnerVsField: number }>;
  /** Softmax confidence of the winner at the chosen temperature. */
  winnerProbability: number;
  temperature: number;
  interpretation: string[];
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
  /** The decision workspace — the J-space analog (present when features
   *  were captured by the scorer). */
  workspace?: DecisionWorkspace;
  /** True when zeroing any single token still leaves the same winner. */
  winnerRobustToTokenDeletion: boolean;
  interpretation: string[];
  method: string;
}

/**
 * Display-side label hygiene. Ranked labels deliberately include hrefs (URL
 * tokens carry matching signal for intents like "click the pricing link"),
 * but reports should read like the page, not like its markup: URLs are
 * stripped for display, with a raw-prefix fallback when nothing else remains
 * (e.g. an unnamed icon link whose only identity is its href).
 */
export function cleanLabel(label: string): string {
  const cleaned = label
    .replace(/(?:https?|file|blob|javascript|data):[^\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : label.slice(0, 40);
}

// ─── small dense linear algebra (matrices here are at most 8×8) ─────────────

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a: number[]) => Math.sqrt(dot(a, a));

function matVec(m: number[][], v: number[]): number[] {
  return m.map((row) => dot(row, v));
}

/**
 * Full symmetric eigendecomposition via the classic cyclic Jacobi rotation
 * method — accurate on the small (≤8×8) Gram matrices here, and unlike
 * power-iteration-with-deflation it returns every eigenvalue, which the
 * participation ratio needs. Returns eigenpairs sorted by eigenvalue desc.
 */
function jacobiEigen(input: number[][], sweeps = 40): Array<{ value: number; vector: number[] }> {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i][p], aiq = a[i][q];
          a[i][p] = c * aip - s * aiq;
          a[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p][i], aqi = a[q][i];
          a[p][i] = c * api - s * aqi;
          a[q][i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i][p], viq = v[i][q];
          v[i][p] = c * vip - s * viq;
          v[i][q] = s * vip + c * viq;
        }
      }
    }
  }
  return Array.from({ length: n }, (_, k) => ({ value: a[k][k], vector: v.map((row) => row[k]) }))
    .sort((x, y) => y.value - x.value);
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

// ─── the decision workspace (the J-space analog) ────────────────────────────

/**
 * Build Splice's decision workspace from the candidates' concept-feature
 * vectors: the low-dimensional space the target choice actually lives in, the
 * concept-directions that carry it, and the softmax sensitivity of the emitted
 * choice to each direction. Temperature sets how sharply scores → a decision;
 * it only affects the readout (decisionJacobian, winnerProbability), not the
 * geometry.
 */
export function buildDecisionWorkspace(candidates: JSpaceCandidate[], temperature = 8): DecisionWorkspace | undefined {
  const withFeatures = candidates.filter((c) => c.features && Object.keys(c.features).length > 0);
  if (withFeatures.length < 2) return undefined;

  const concepts = Object.keys(withFeatures[0].features!);
  const nC = concepts.length;
  const nCand = withFeatures.length;

  // Activation matrix A: candidates × concepts.
  const A = withFeatures.map((c) => concepts.map((k) => c.features![k] ?? 0));
  const winnerIdx = 0; // candidates arrive sorted by score

  // Center each concept column: the workspace is the DISCRIMINATIVE subspace,
  // so a concept every candidate shares equally contributes no dimension.
  const colMean = concepts.map((_, k) => A.reduce((s, row) => s + row[k], 0) / nCand);
  const Ac = A.map((row) => row.map((v, k) => v - colMean[k]));

  // Gram matrix (concept × concept) → eigenpairs give the SVD of Ac.
  const gram: number[][] = Array.from({ length: nC }, (_, i) =>
    Array.from({ length: nC }, (_, j) => Ac.reduce((s, row) => s + row[i] * row[j], 0))
  );
  const eig = jacobiEigen(gram).map((e) => ({ value: Math.max(0, e.value), vector: e.vector }));
  const eigenvalues = eig.map((e) => e.value);
  const totalVar = eigenvalues.reduce((a, b) => a + b, 0);

  // Effective dimensionality: participation ratio (Σλ)² / Σλ².
  const sumSq = eigenvalues.reduce((a, b) => a + b * b, 0);
  const effectiveDimension = totalVar > 1e-9 ? Number(((totalVar * totalVar) / sumSq).toFixed(2)) : 0;

  // Top concept-directions (axes carrying real variance).
  const conceptDirections = eig
    .filter((e) => totalVar > 1e-9 && e.value / totalVar > 0.01)
    .slice(0, 3)
    .map((e, idx) => {
      const sv = Math.sqrt(e.value);
      // Winner's coordinate along this axis, and the field's spread on it.
      const coords = Ac.map((row) => row.reduce((s, v, k) => s + v * e.vector[k], 0));
      const winnerCoordinate = coords[winnerIdx];
      const spread = Math.sqrt(coords.reduce((s, c) => s + c * c, 0) / nCand) || 1;
      return {
        axis: idx + 1,
        singularValue: Number(sv.toFixed(3)),
        varianceShare: Number((e.value / totalVar).toFixed(3)),
        dominantConcepts: concepts
          .map((concept, k) => ({ concept, loading: Number(e.vector[k].toFixed(3)) }))
          .filter((c) => Math.abs(c.loading) > 0.2)
          .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading))
          .slice(0, 3),
        winnerCoordinate: Number(winnerCoordinate.toFixed(3)),
        separatesWinner: Math.abs(winnerCoordinate) >= spread,
      };
    });

  // Softmax readout at temperature T, and the decision Jacobian w.r.t. each
  // concept: d P(winner) / d(scale of concept k) = p_win·(A[win][k] − E_p[A[k]]).
  const scores = withFeatures.map((c) => c.score);
  const maxScore = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - maxScore) / temperature));
  const expSum = exps.reduce((a, b) => a + b, 0);
  const p = exps.map((e) => e / expSum);
  const winnerProbability = p[winnerIdx];
  const decisionJacobian = concepts
    .map((concept, k) => {
      const expected = A.reduce((s, row, j) => s + p[j] * row[k], 0);
      const winnerVsField = A[winnerIdx][k] - expected;
      return {
        concept,
        sensitivity: Number((winnerProbability * winnerVsField).toFixed(3)),
        winnerVsField: Number(winnerVsField.toFixed(3)),
      };
    })
    .sort((a, b) => Math.abs(b.sensitivity) - Math.abs(a.sensitivity));

  const interpretation: string[] = [];
  interpretation.push(
    `The choice lives in an effectively ${effectiveDimension}-dimensional workspace spanned by ${nC} concept axes — decision-relevant information made globally available before the action is emitted.`
  );
  const topAxis = conceptDirections[0];
  if (topAxis) {
    interpretation.push(
      `Its dominant direction (${Math.round(topAxis.varianceShare * 100)}% of the variance) loads on ${topAxis.dominantConcepts.map((c) => c.concept).join(' + ') || 'nothing'}; the winner ${topAxis.separatesWinner ? 'sits clear of the field' : 'is not well separated'} along it.`
    );
  }
  const topSens = decisionJacobian.find((d) => Math.abs(d.sensitivity) > 1e-6);
  interpretation.push(
    topSens
      ? `The emitted choice is most sensitive to "${topSens.concept}" (∂P(winner) ${topSens.sensitivity >= 0 ? '+' : ''}${topSens.sensitivity} per unit scale); the winner leads the field by ${topSens.winnerVsField} there.`
      : 'No concept discriminates the winner from the field — the choice is a near-tie readout.'
  );
  interpretation.push(
    `Softmax confidence in the winner: ${Math.round(winnerProbability * 100)}% at temperature ${temperature}.`
  );
  interpretation.push(
    'Scope: this is Splice\'s own pre-action decision workspace, not the calling model\'s hidden activations — a structural J-space analog, not access to model internals.'
  );

  return {
    concepts,
    activations: withFeatures.map((c, i) => ({ label: cleanLabel(c.label).slice(0, 60), vector: A[i] })),
    effectiveDimension,
    conceptDirections,
    decisionJacobian,
    winnerProbability: Number(winnerProbability.toFixed(3)),
    temperature,
    interpretation,
  };
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
    dominantCandidateMix: candidates.map((c, j) => ({ label: cleanLabel(c.label).slice(0, 60), weight: Number(candidateMixRaw[j].toFixed(3)) })),
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
          rival: cleanLabel(rival.label).slice(0, 60),
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

  const workspace = buildDecisionWorkspace(candidates);
  if (workspace) {
    interpretation.push(
      `Decision workspace: the choice is an effectively ${workspace.effectiveDimension}-dimensional readout over ${workspace.concepts.length} concept axes (see workspace).`
    );
  }

  return {
    intent,
    tokens,
    candidates: candidates.map((c) => ({ label: cleanLabel(c.label).slice(0, 80), score: c.score })),
    winner: cleanLabel(winner.label).slice(0, 80),
    runnerUp: runnerUp ? cleanLabel(runnerUp.label).slice(0, 80) : undefined,
    margin,
    jacobian,
    geometry: { tokenLeverage, redundantPairs, orthogonalPairs, inertTokens },
    spectrum,
    flipBoundaries,
    ...(workspace ? { workspace } : {}),
    winnerRobustToTokenDeletion,
    interpretation,
    method:
      'Exact analytic Jacobian of the linear keyword term, read from the instrumented production scorer. ' +
      'The decision workspace is the concept-feature space the choice is read out of — Splice\'s own pre-action J-space analog, ' +
      'not the calling model\'s hidden state. Query-phrase bonus and exact-text penalty are token-joint (nonlinear) and held constant; the finite-difference lens is the empirical cross-check.',
  };
}
