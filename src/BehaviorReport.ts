/**
 * Splice Behavior Report
 *
 * Turns a session's cognition events into a chain-of-thought reconstruction
 * an agent (or its operator) can read back and learn from. The digest is
 * deliberately machine-first: an agent can ingest the JSON at the start of
 * its next run — or mid-run on long traversals — and adjust its own strategy
 * from the selfImprovement section, closing a recursive improvement loop
 * without a human in the middle.
 *
 * Three consumers, one source of truth:
 *  - BrowserManager.generateBehaviorReport() (live session, full fidelity)
 *  - the generate_behavior_report MCP tool (agents request their own digest)
 *  - `splice report` (offline analysis of any persisted run journal)
 */

import type { JournalEntry } from './RunJournal.js';
import { buildCalibration, type CalibrationReport } from './Cognition.js';

/** One cognition event, recorded as the session runs. */
export interface BehaviorEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/** One navigation-bounded stretch of work, with its reconstructed chain. */
export interface BehaviorEpisode {
  index: number;
  url?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** The chain of thought: what the agent observed, decided, and did, in order. */
  chain: Array<{ offsetMs: number; type: string; summary: string }>;
  /** Every intent the agent expressed during this episode. */
  intents: string[];
  /** Non-ready failure classes diagnosed during this episode. */
  failureStates: string[];
  outcome: 'verified' | 'partial' | 'blocked' | 'observational';
}

export interface SelfImprovementRecommendation {
  priority: 'high' | 'medium' | 'low';
  /** What the session data shows. */
  observation: string;
  /** What to do differently next run (or next stretch of this run). */
  recommendation: string;
  /** Concrete numbers backing the observation. */
  evidence: string;
}

export interface BehaviorReportDigest {
  generatedAt: string;
  sessionDurationMs: number;
  totalEvents: number;
  /** Chain-of-thought reconstruction: one line per pivotal event, in order. */
  narrative: string[];
  episodes: BehaviorEpisode[];
  actionQuality: {
    plansCompiled: number;
    plansExecuted: number;
    plansVerified: number;
    /** verified / executed; null until something has executed. */
    verificationRate: number | null;
    clarificationRequests: number;
    selfHeals: number;
  };
  failureAnalysis: {
    /** How often each failure class was diagnosed. */
    diagnosisCounts: Record<string, number>;
    stuckSignals: number;
    /** Diagnoses that arrived with a learned recovery strategy attached. */
    learnedRecoveriesSurfaced: number;
    /** The last non-ready state with no verified action after it, if any. */
    unresolvedAtEnd: string | null;
  };
  observationEconomy: {
    fullTreeReads: number;
    deltaReads: number;
    /** deltas / (deltas + full reads); null until something was observed. */
    deltaAdoptionRate: number | null;
    waitsSatisfied: number;
    waitsTimedOut: number;
    tokensSavedEstimate: number;
    redundantObservationTokens: number;
  };
  /** Does stated compile confidence track verified outcomes? (see Cognition.ts) */
  calibration: CalibrationReport;
  recoveryMemory?: { totalPatterns: number };
  journal?: {
    sessionId: string;
    toolCalls: number;
    errors: number;
    crashes: number;
    recoveries: number;
    lastError?: { tool?: string; errorCode?: string; detail?: string; timestamp: number };
  };
  selfImprovement: SelfImprovementRecommendation[];
}

// ─── Event summarization ────────────────────────────────────────────────────

const str = (v: unknown, max = 90): string => String(v ?? '').slice(0, max);
const pct = (v: unknown): string => `${Math.round(Number(v ?? 0) * 100)}%`;

/** One human/agent-readable line for a cognition event. */
export function summarizeEvent(event: BehaviorEvent): string {
  const d = event.data;
  switch (event.type) {
    case 'navigate':
      return `navigated to ${str(d.url)}`;
    case 'history_navigate':
      return `history ${str(d.direction)} → ${str(d.url)}`;
    case 'semantic_tree':
      return `full observation (${str(d.lens)} lens${d.intent ? `, intent "${str(d.intent, 60)}"` : ''})`;
    case 'semantic_delta':
      return `delta observation: ${str(d.summary, 140)}`;
    case 'agent_state_diagnosis': {
      const stuck = d.likelyStuck ? ' [STUCK SIGNAL]' : '';
      const learned = d.recoveryStrategySource === 'learned' ? ' [learned recovery available]' : '';
      return `diagnosed ${str(d.state)} at ${pct(d.confidence)} confidence${stuck}${learned}`;
    }
    case 'verified_action_plan': {
      const why = d.why ? ` — ${str(d.why, 100)}` : '';
      if (d.needsClarification) return `intent "${str(d.intent, 60)}" rejected as unstructured — clarification requested`;
      if (d.executed === undefined && d.executable === false) return `plan for "${str(d.intent, 60)}" compiled but not executable`;
      if (d.executed) return `executed "${str(d.intent, 60)}" → ${d.passed ? 'verified' : 'VERIFICATION FAILED'}${why}`;
      return `compiled plan for "${str(d.intent, 60)}" (${pct(d.confidence)} confidence, risk ${str(d.risk)})${why}`;
    }
    case 'interact':
      return `${str(d.action)} on ${str(d.elementId)}${d.selfHealed ? ' [self-healed after stale target]' : ''}`;
    case 'fill_form':
      return `filled ${d.filled}/${d.fields} form field(s)${d.submitted ? ', submitted' : ''}${d.formReady === false ? ' — form still blocked' : ''}`;
    case 'extract_structured':
      return `extracted ${d.rows} row(s) via ${str(d.method)}`;
    case 'wait_for':
      return d.timedOut
        ? `wait TIMED OUT after ${d.elapsedMs}ms (${d.pollCount} polls) — ${str(d.conditions, 80)}`
        : `waited ${d.elapsedMs}ms (${d.pollCount} polls) for ${str(d.matched, 60)}`;
    case 'assert_page_state':
      return `asserted ${d.expectations} postcondition(s) → ${d.passed ? 'all hold' : `FAILED: ${str(d.summary, 100)}`}`;
    case 'execute_script':
      return `ran script: ${str(d.script, 70)}`;
    case 'jacobian_lens':
      return `inspected intent "${str(d.intent, 60)}" through the Jacobian lens${d.deep ? ' (deep J-space)' : ''} — ${Array.isArray(d.flips) && d.flips.length > 0 ? `load-bearing: ${(d.flips as string[]).join(', ')}` : 'choice stable'}`;
    case 'prompt_optimized':
      return `optimized prompt "${str(d.original, 60)}" → "${str(d.optimized, 60)}"${d.routedTo ? ` [routed to ${str(d.routedTo)}]` : ''}${d.groundedTo ? ` [grounded to "${str(d.groundedTo, 40)}"]` : ''}`;
    case 'speculative_delta':
      return `speculative branch ${str(d.branchId)}: ${str(d.summary, 100)}`;
    default:
      return `${event.type}`;
  }
}

// ─── Episode reconstruction ─────────────────────────────────────────────────

function episodeOutcome(events: BehaviorEvent[]): BehaviorEpisode['outcome'] {
  const executed = events.filter((e) => e.type === 'verified_action_plan' && e.data.executed);
  const submitted = events.some((e) => e.type === 'fill_form' && e.data.submitted);
  const failedAsserts = events.some((e) => e.type === 'assert_page_state' && !e.data.passed);
  const blocked = events.some(
    (e) => e.type === 'agent_state_diagnosis' && e.data.state !== 'ready' && e.data.likelyStuck
  );
  if (blocked) return 'blocked';
  if (executed.length > 0 || submitted) {
    const allPassed = executed.every((e) => e.data.passed !== false) && !failedAsserts;
    return allPassed ? 'verified' : 'partial';
  }
  return 'observational';
}

function buildEpisodes(events: BehaviorEvent[]): BehaviorEpisode[] {
  const episodes: BehaviorEpisode[] = [];
  let bucket: BehaviorEvent[] = [];
  let url: string | undefined;

  const flush = () => {
    if (bucket.length === 0) return;
    const startedAt = bucket[0].timestamp;
    const endedAt = bucket[bucket.length - 1].timestamp;
    episodes.push({
      index: episodes.length,
      url,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      chain: bucket.map((e) => ({
        offsetMs: e.timestamp - startedAt,
        type: e.type,
        summary: summarizeEvent(e),
      })),
      intents: bucket
        .filter((e) => e.type === 'verified_action_plan' && e.data.intent)
        .map((e) => str(e.data.intent, 80)),
      failureStates: [...new Set(
        bucket
          .filter((e) => e.type === 'agent_state_diagnosis' && e.data.state !== 'ready')
          .map((e) => str(e.data.state))
      )],
      outcome: episodeOutcome(bucket),
    });
    bucket = [];
  };

  for (const event of events) {
    if (event.type === 'navigate' || event.type === 'history_navigate') {
      flush();
      url = str(event.data.url, 200) || url;
    }
    bucket.push(event);
  }
  flush();
  return episodes;
}

// ─── Self-improvement heuristics ────────────────────────────────────────────

function buildRecommendations(digest: Omit<BehaviorReportDigest, 'selfImprovement'>): SelfImprovementRecommendation[] {
  const recs: SelfImprovementRecommendation[] = [];
  const aq = digest.actionQuality;
  const oe = digest.observationEconomy;
  const fa = digest.failureAnalysis;

  if (aq.verificationRate !== null && aq.verificationRate < 0.9 && aq.plansExecuted >= 2) {
    recs.push({
      priority: aq.verificationRate < 0.7 ? 'high' : 'medium',
      observation: 'A meaningful share of executed actions failed post-action verification.',
      recommendation: 'Declare expected outcomes on compile_verified_action via `expect` (url_contains, text_present, …) so failures are caught at the action, and re-observe with a delta before retrying a failed intent.',
      evidence: `${aq.plansVerified}/${aq.plansExecuted} executed plans verified (${pct(aq.verificationRate)}).`,
    });
  }

  if (aq.clarificationRequests > 0) {
    recs.push({
      priority: aq.clarificationRequests > 2 ? 'high' : 'medium',
      observation: 'Some intents were too vague to compile and were bounced back for clarification.',
      recommendation: 'Phrase intents as action + quoted target (e.g. click "Place order"), never as goal states ("finish", "continue").',
      evidence: `${aq.clarificationRequests} clarification request(s) this session.`,
    });
  }

  const totalReads = oe.fullTreeReads + oe.deltaReads;
  if (oe.fullTreeReads >= 3 && (oe.deltaAdoptionRate ?? 1) < 0.5) {
    recs.push({
      priority: oe.redundantObservationTokens > 2000 ? 'high' : 'medium',
      observation: 'Observation is full-tree heavy; most reads re-sent content the agent already had.',
      recommendation: 'After the first observation on a page, switch to deltaOnly reads (optionally anchored with sinceLastActionId) and use structuralOnly on churny pages.',
      evidence: `${oe.deltaReads}/${totalReads} reads were deltas; ~${oe.redundantObservationTokens} tokens re-sent by unchanged full reads.`,
    });
  }

  if (oe.waitsTimedOut > 0 && oe.waitsTimedOut >= oe.waitsSatisfied) {
    recs.push({
      priority: 'medium',
      observation: 'Waits timed out as often as they succeeded.',
      recommendation: 'After a wait_for timeout, run diagnose_agent_state before retrying — the timeout hint distinguishes slow pages from stuck ones, and the diagnosis may carry a learned recovery.',
      evidence: `${oe.waitsTimedOut} timeout(s) vs ${oe.waitsSatisfied} satisfied wait(s).`,
    });
  }

  if (fa.stuckSignals > 0) {
    recs.push({
      priority: 'high',
      observation: 'The forensics trend flagged the workflow as stuck — the same failure state was diagnosed repeatedly on the same URL.',
      recommendation: 'Treat two identical non-ready diagnoses as the ceiling: on the second, switch strategy (use recommendedRecoveryStrategy, recommendedNextAction, or back off the page) instead of re-trying the same approach.',
      evidence: `${fa.stuckSignals} stuck signal(s); states seen: ${Object.entries(fa.diagnosisCounts).map(([s, n]) => `${s}×${n}`).join(', ') || 'none'}.`,
    });
  }

  if (aq.selfHeals > 0) {
    recs.push({
      priority: 'low',
      observation: 'Some targets went stale between observation and action (interactions self-healed).',
      recommendation: 'On pages that re-render, act immediately after observing, or re-anchor with an action-anchored delta before interacting.',
      evidence: `${aq.selfHeals} self-healed interaction(s).`,
    });
  }

  const cal = digest.calibration;
  if (cal.verdict === 'overconfident') {
    recs.push({
      priority: 'high',
      observation: 'Stated compile confidence ran ahead of verified outcomes — the agent believed more than the page delivered.',
      recommendation: 'Discount compile confidence when gating execution, declare `expect` postconditions on every consequential action, and read the surprises list (calibration.surprises) to see where the page model diverged.',
      evidence: `Confidence exceeded pass rate by ${Math.round((cal.calibrationGap ?? 0) * 100)} points over ${cal.samples} executed action(s); Brier ${cal.brierScore}.`,
    });
  } else if (cal.verdict === 'underconfident') {
    recs.push({
      priority: 'low',
      observation: 'Verified outcomes ran ahead of stated confidence — intents are landing better than the agent believes.',
      recommendation: 'Trust compiled plans at this confidence level and skip redundant pre-action observation on familiar pages.',
      evidence: `Pass rate exceeded confidence by ${Math.round(-(cal.calibrationGap ?? 0) * 100)} points over ${cal.samples} executed action(s).`,
    });
  }

  if (fa.unresolvedAtEnd) {
    recs.push({
      priority: 'high',
      observation: `The session ended in an unresolved "${fa.unresolvedAtEnd}" state.`,
      recommendation: 'Resume by diagnosing first: the state may carry a learned recovery pattern from this run. If it recurs, record what finally works so recovery memory captures it.',
      evidence: `Last non-ready diagnosis (${fa.unresolvedAtEnd}) had no verified action after it.`,
    });
  }

  if (digest.journal && digest.journal.errors > 0) {
    const le = digest.journal.lastError;
    recs.push({
      priority: digest.journal.errors > 3 ? 'high' : 'medium',
      observation: 'The run journal recorded tool-level errors.',
      recommendation: 'Replay the journal (export_run_journal) around each error to see the exact call sequence that preceded it, and adjust the playbook step that produced it.',
      evidence: `${digest.journal.errors} error(s)${le ? `; last: ${le.tool ?? 'unknown tool'} → ${le.errorCode ?? le.detail ?? 'unknown'}` : ''}.`,
    });
  }

  if (recs.length === 0) {
    recs.push({
      priority: 'low',
      observation: 'No failure patterns, wasted observation, or unverified actions detected.',
      recommendation: 'Current strategy is working — keep verifying actions with declared expectations and observing via deltas.',
      evidence: `${aq.plansVerified}/${aq.plansExecuted || 0} plans verified; ${pct(oe.deltaAdoptionRate ?? 0)} delta adoption; 0 stuck signals.`,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

// ─── Digest assembly ────────────────────────────────────────────────────────

export interface BehaviorReportInput {
  events: BehaviorEvent[];
  metrics?: { tokensSavedEstimate?: number; redundantObservationTokens?: number; selfHealCount?: number };
  journalStats?: BehaviorReportDigest['journal'];
  recoveryMemoryStats?: { totalPatterns: number };
}

export function buildBehaviorReport(input: BehaviorReportInput): BehaviorReportDigest {
  const events = [...input.events].sort((a, b) => a.timestamp - b.timestamp);
  const episodes = buildEpisodes(events);

  const plans = events.filter((e) => e.type === 'verified_action_plan');
  const executed = plans.filter((e) => e.data.executed);
  const verified = executed.filter((e) => e.data.passed !== false);
  const diagnoses = events.filter((e) => e.type === 'agent_state_diagnosis');
  const waits = events.filter((e) => e.type === 'wait_for');

  const diagnosisCounts: Record<string, number> = {};
  for (const d of diagnoses) {
    const state = str(d.data.state);
    diagnosisCounts[state] = (diagnosisCounts[state] ?? 0) + 1;
  }

  // Unresolved end state: the last non-ready diagnosis with no verified
  // action or passing assertion after it.
  let unresolvedAtEnd: string | null = null;
  const lastBad = [...diagnoses].reverse().find((d) => d.data.state !== 'ready');
  if (lastBad) {
    const resolvedAfter = events.some(
      (e) => e.timestamp > lastBad.timestamp && (
        (e.type === 'verified_action_plan' && e.data.executed && e.data.passed !== false) ||
        (e.type === 'assert_page_state' && e.data.passed) ||
        (e.type === 'agent_state_diagnosis' && e.data.state === 'ready')
      )
    );
    if (!resolvedAfter) unresolvedAtEnd = str(lastBad.data.state);
  }

  const fullTreeReads = events.filter((e) => e.type === 'semantic_tree').length;
  const deltaReads = events.filter((e) => e.type === 'semantic_delta').length;
  const totalReads = fullTreeReads + deltaReads;

  const partial: Omit<BehaviorReportDigest, 'selfImprovement'> = {
    generatedAt: new Date().toISOString(),
    sessionDurationMs: events.length > 0 ? events[events.length - 1].timestamp - events[0].timestamp : 0,
    totalEvents: events.length,
    narrative: episodes.flatMap((ep) => [
      `— episode ${ep.index + 1}${ep.url ? ` @ ${ep.url}` : ''} (${ep.outcome}) —`,
      ...ep.chain.map((c) => `  [+${(c.offsetMs / 1000).toFixed(1)}s] ${c.summary}`),
    ]),
    episodes,
    actionQuality: {
      plansCompiled: plans.length,
      plansExecuted: executed.length,
      plansVerified: verified.length,
      verificationRate: executed.length > 0 ? verified.length / executed.length : null,
      clarificationRequests: plans.filter((e) => e.data.needsClarification).length,
      selfHeals: input.metrics?.selfHealCount ?? events.filter((e) => e.type === 'interact' && e.data.selfHealed).length,
    },
    failureAnalysis: {
      diagnosisCounts,
      stuckSignals: diagnoses.filter((d) => d.data.likelyStuck).length,
      learnedRecoveriesSurfaced: diagnoses.filter((d) => d.data.recoveryStrategySource === 'learned').length,
      unresolvedAtEnd,
    },
    observationEconomy: {
      fullTreeReads,
      deltaReads,
      deltaAdoptionRate: totalReads > 0 ? deltaReads / totalReads : null,
      waitsSatisfied: waits.filter((w) => !w.data.timedOut).length,
      waitsTimedOut: waits.filter((w) => w.data.timedOut).length,
      tokensSavedEstimate: input.metrics?.tokensSavedEstimate ?? 0,
      redundantObservationTokens: input.metrics?.redundantObservationTokens ?? 0,
    },
    calibration: buildCalibration(events),
    recoveryMemory: input.recoveryMemoryStats,
    journal: input.journalStats,
  };

  return { ...partial, selfImprovement: buildRecommendations(partial) };
}

// ─── Markdown rendering ─────────────────────────────────────────────────────

export function renderBehaviorMarkdown(digest: BehaviorReportDigest): string {
  const aq = digest.actionQuality;
  const oe = digest.observationEconomy;
  const fa = digest.failureAnalysis;
  const lines: string[] = [
    '# Splice Behavior Report',
    '',
    `Generated ${digest.generatedAt} · ${digest.totalEvents} events over ${(digest.sessionDurationMs / 1000).toFixed(1)}s · ${digest.episodes.length} episode(s)`,
    '',
    '## Self-improvement',
    '',
    ...digest.selfImprovement.flatMap((r) => [
      `### [${r.priority.toUpperCase()}] ${r.observation}`,
      `- **Do next run:** ${r.recommendation}`,
      `- **Evidence:** ${r.evidence}`,
      '',
    ]),
    '## Action quality',
    '',
    `- Plans compiled: ${aq.plansCompiled}, executed: ${aq.plansExecuted}, verified: ${aq.plansVerified}` +
      (aq.verificationRate !== null ? ` (${Math.round(aq.verificationRate * 100)}% verification rate)` : ''),
    `- Clarification requests: ${aq.clarificationRequests} · self-heals: ${aq.selfHeals}`,
    '',
    '## Confidence calibration',
    '',
    digest.calibration.samples === 0
      ? '- No executed actions to calibrate against.'
      : `- ${digest.calibration.samples} executed action(s) · Brier ${digest.calibration.brierScore} · gap ${
          digest.calibration.calibrationGap !== null && digest.calibration.calibrationGap > 0 ? '+' : ''
        }${Math.round((digest.calibration.calibrationGap ?? 0) * 100)}pt → **${digest.calibration.verdict}**`,
    ...digest.calibration.bands
      .filter((b) => b.count > 0)
      .map((b) => `- ${b.band}: ${b.count} action(s), ${b.passRate !== null ? `${Math.round(b.passRate * 100)}% verified` : 'n/a'}`),
    ...digest.calibration.surprises.map(
      (s) => `- Surprise: "${s.intent}" at ${Math.round(s.confidence * 100)}% confidence failed verification.`
    ),
    '',
    '## Failure analysis',
    '',
    `- Diagnoses: ${Object.entries(fa.diagnosisCounts).map(([s, n]) => `${s}×${n}`).join(', ') || 'none'}`,
    `- Stuck signals: ${fa.stuckSignals} · learned recoveries surfaced: ${fa.learnedRecoveriesSurfaced}`,
    `- Unresolved at end: ${fa.unresolvedAtEnd ?? 'none'}`,
    '',
    '## Observation economy',
    '',
    `- Full tree reads: ${oe.fullTreeReads} · delta reads: ${oe.deltaReads}` +
      (oe.deltaAdoptionRate !== null ? ` (${Math.round(oe.deltaAdoptionRate * 100)}% delta adoption)` : ''),
    `- Waits: ${oe.waitsSatisfied} satisfied, ${oe.waitsTimedOut} timed out`,
    `- Tokens saved ~${oe.tokensSavedEstimate} · re-sent by redundant reads ~${oe.redundantObservationTokens}`,
    '',
  ];
  if (digest.journal) {
    lines.push(
      '## Run journal',
      '',
      `- Session ${digest.journal.sessionId}: ${digest.journal.toolCalls} tool call(s), ${digest.journal.errors} error(s), ${digest.journal.crashes} crash(es), ${digest.journal.recoveries} recovery(ies)`,
      ''
    );
  }
  lines.push('## Chain of thought', '', '```', ...digest.narrative, '```', '');
  return lines.join('\n');
}

// ─── Offline journal digest (for `splice report`) ───────────────────────────

export interface JournalDigest {
  sessionId: string;
  entries: number;
  toolCalls: number;
  errors: number;
  crashes: number;
  recoveries: number;
  durationMs: number;
  /** Per-tool call counts, error counts, and mean duration. */
  tools: Array<{ tool: string; calls: number; errors: number; avgDurationMs: number | null }>;
  /** Error entries with surrounding context for replay. */
  errorTimeline: Array<{ seq: number; tool?: string; errorCode?: string; detail?: string; precededBy: string[] }>;
  recommendations: SelfImprovementRecommendation[];
}

export function buildJournalDigest(entries: JournalEntry[]): JournalDigest {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const toolCalls = sorted.filter((e) => e.kind === 'tool_call');
  const byTool = new Map<string, { calls: number; errors: number; totalMs: number; timed: number }>();
  for (const e of toolCalls) {
    const tool = e.tool ?? 'unknown';
    const agg = byTool.get(tool) ?? { calls: 0, errors: 0, totalMs: 0, timed: 0 };
    agg.calls++;
    if (e.outcome === 'error') agg.errors++;
    if (typeof e.durationMs === 'number') { agg.totalMs += e.durationMs; agg.timed++; }
    byTool.set(tool, agg);
  }

  const errorEntries = sorted.filter((e) => e.outcome === 'error');
  const errorTimeline = errorEntries.map((e) => ({
    seq: e.seq,
    tool: e.tool,
    errorCode: e.errorCode,
    detail: e.detail?.slice(0, 200),
    precededBy: sorted
      .filter((p) => p.kind === 'tool_call' && p.seq < e.seq)
      .slice(-3)
      .map((p) => `${p.tool ?? 'unknown'} (${p.outcome})`),
  }));

  const digest: JournalDigest = {
    sessionId: sorted[0]?.sessionId ?? 'unknown',
    entries: sorted.length,
    toolCalls: toolCalls.length,
    errors: errorEntries.length,
    crashes: sorted.filter((e) => e.kind === 'crash').length,
    recoveries: sorted.filter((e) => e.kind === 'recovery').length,
    durationMs: sorted.length > 1 ? sorted[sorted.length - 1].timestamp - sorted[0].timestamp : 0,
    tools: [...byTool.entries()]
      .map(([tool, agg]) => ({
        tool,
        calls: agg.calls,
        errors: agg.errors,
        avgDurationMs: agg.timed > 0 ? Math.round(agg.totalMs / agg.timed) : null,
      }))
      .sort((a, b) => b.calls - a.calls),
    errorTimeline,
    recommendations: [],
  };

  const recs: SelfImprovementRecommendation[] = [];
  const worstTool = digest.tools.filter((t) => t.calls >= 3 && t.errors / t.calls > 0.3)[0];
  if (worstTool) {
    recs.push({
      priority: 'high',
      observation: `The "${worstTool.tool}" tool failed frequently this run.`,
      recommendation: 'Inspect the error timeline for this tool: repeated identical failures usually mean a stale playbook step (changed selector semantics, new gate on the page) rather than flakiness.',
      evidence: `${worstTool.errors}/${worstTool.calls} calls errored.`,
    });
  }
  if (digest.crashes > 0) {
    recs.push({
      priority: 'high',
      observation: 'The browser crashed during this run.',
      recommendation: `Check the ${digest.recoveries > 0 ? 'recovery entries — state was rebuilt, but re-verify any action in flight at crash time' : 'journal tail: the run ended without a recorded recovery'}.`,
      evidence: `${digest.crashes} crash(es), ${digest.recoveries} recovery(ies).`,
    });
  }
  if (recs.length === 0 && digest.errors > 0) {
    recs.push({
      priority: 'medium',
      observation: 'Scattered tool errors occurred without a dominant failing tool.',
      recommendation: 'Review the errorTimeline precededBy chains — errors that follow the same call sequence point to an ordering assumption worth fixing.',
      evidence: `${digest.errors} error(s) across ${digest.toolCalls} calls.`,
    });
  }
  if (recs.length === 0) {
    recs.push({
      priority: 'low',
      observation: 'Clean run: no errors, crashes, or dominant failure patterns in the journal.',
      recommendation: 'No changes needed. Keep this journal as a healthy baseline to diff future runs against.',
      evidence: `${digest.toolCalls} tool call(s), 0 errors.`,
    });
  }
  digest.recommendations = recs;
  return digest;
}
