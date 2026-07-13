/**
 * Splice Jacobian Lens (amateur edition)
 *
 * A finite-difference sensitivity probe over the agent's target selection —
 * "Jacobian" in spirit, not in calculus. The real ranking function that
 * compile_verified_action uses is re-run with one intent token knocked out at
 * a time; the matrix of resulting score changes shows which words are
 * load-bearing and which are decoration:
 *
 *   rows    = intent tokens (the inputs)
 *   columns = top candidate targets (the outputs)
 *   cell    = Δscore for that candidate when that token is removed
 *
 * Alongside it, the lens reports ∂page/∂action for recent actions — how many
 * elements each action actually added, removed, or changed — pulled from the
 * session's recorded deltas. Everything is computed live against the real
 * page and the real scorer; nothing is persisted.
 */

export interface RankedCandidate {
  id: string;
  label: string;
  score: number;
}

export interface TokenSensitivity {
  /** The token that was removed for this row. */
  token: string;
  /** Who wins the ranking without this token. */
  winner: string;
  winnerChanged: boolean;
  /** Winner's lead over the runner-up without this token. */
  margin: number;
  /** Change in that lead versus the full intent (negative = token was load-bearing). */
  marginDelta: number;
  /** Δscore per baseline top candidate when this token is removed. */
  scoreDeltas: Array<{ label: string; id: string; delta: number }>;
}

export interface ActionImpact {
  /** Action anchor this delta was observed after, when known. */
  sinceActionId?: string;
  added: number;
  removed: number;
  changed: number;
  summary: string;
}

export interface JacobianLensReport {
  intent: string;
  tokens: string[];
  baseline: {
    winner: RankedCandidate | null;
    margin: number;
    candidates: RankedCandidate[];
  };
  /** One row per removed token — the "Jacobian" itself. */
  tokenSensitivities: TokenSensitivity[];
  /** The token whose removal hurts the winner most (or flips it). */
  mostLoadBearingToken: string | null;
  /**
   * robust  — the winner survives the removal of every single token
   * fragile — the winner survives but some removal erases most of its lead
   * flips   — at least one single-token removal changes the chosen target
   */
  stability: 'robust' | 'fragile' | 'flips';
  /** ∂page/∂action for recent actions, from recorded deltas. */
  actionImpact: ActionImpact[];
  summary: string;
}

/** Pure assembly: baseline ranking + one perturbed ranking per removed token. */
export function assembleJacobianReport(
  intent: string,
  tokens: string[],
  baseline: RankedCandidate[],
  perturbed: Array<{ token: string; ranking: RankedCandidate[] }>,
  actionImpact: ActionImpact[]
): JacobianLensReport {
  const top = baseline.slice(0, 5);
  const winner = top[0] ?? null;
  const baseMargin = winner ? winner.score - (top[1]?.score ?? 0) : 0;

  const tokenSensitivities: TokenSensitivity[] = perturbed.map(({ token, ranking }) => {
    const newWinner = ranking[0] ?? null;
    const margin = newWinner ? newWinner.score - (ranking[1]?.score ?? 0) : 0;
    return {
      token,
      winner: newWinner?.label ?? '(no candidate)',
      winnerChanged: (newWinner?.id ?? null) !== (winner?.id ?? null),
      margin,
      marginDelta: margin - baseMargin,
      scoreDeltas: top.map((candidate) => ({
        label: candidate.label,
        id: candidate.id,
        delta: (ranking.find((r) => r.id === candidate.id)?.score ?? 0) - candidate.score,
      })),
    };
  });

  const flips = tokenSensitivities.filter((t) => t.winnerChanged);
  const worst = [...tokenSensitivities].sort((a, b) => a.marginDelta - b.marginDelta)[0] ?? null;
  const mostLoadBearingToken = flips.length > 0 ? flips[0].token : worst && worst.marginDelta < 0 ? worst.token : null;

  const stability: JacobianLensReport['stability'] =
    flips.length > 0 ? 'flips'
    : worst && baseMargin > 0 && worst.margin < baseMargin * 0.35 ? 'fragile'
    : 'robust';

  const summary = !winner
    ? 'No candidate wins for this intent — there is nothing to perturb. Restate the intent with an on-page target.'
    : stability === 'flips'
      ? `Fragile choice: removing "${flips[0].token}" flips the target from "${winner.label}" to "${flips[0].winner}". That token is doing all the disambiguation — keep it (or quote the exact label).`
      : stability === 'fragile'
        ? `"${winner.label}" wins on every single-token removal, but dropping "${worst!.token}" erases most of its lead (${baseMargin} → ${worst!.margin}). The choice leans heavily on that word.`
        : `Robust choice: "${winner.label}" survives the removal of every token with margin to spare. The intent is well-grounded.`;

  return {
    intent,
    tokens,
    baseline: { winner, margin: baseMargin, candidates: top },
    tokenSensitivities,
    mostLoadBearingToken,
    stability,
    actionImpact,
    summary,
  };
}
