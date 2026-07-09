/**
 * Splice Agent Tracker
 *
 * Live performance tracking and in-action optimization for agents.
 * Every tool call attributed to an agent is recorded here; the tracker
 * computes rolling health (success rate, latency, failure streaks,
 * error-class breakdown) and turns it into concrete optimization
 * directives that are delivered inline with tool results — so an agent
 * that starts thrashing gets corrective guidance mid-run, not in a
 * post-mortem.
 */

export type AgentHealthStatus = 'optimal' | 'degraded' | 'critical';

export interface AgentActionRecord {
  tool: string;
  outcome: 'ok' | 'error';
  durationMs: number;
  errorCode?: string;
  timestamp: number;
}

export interface AgentOptimization {
  /** Stable identifier for the directive, e.g. 'verify-before-interact'. */
  id: string;
  severity: 'hint' | 'warning' | 'critical';
  directive: string;
  /** The tool the agent should reach for to apply the directive. */
  suggestedTool?: string;
}

export interface AgentPerformanceProfile {
  agentId: string;
  status: AgentHealthStatus;
  totalActions: number;
  successes: number;
  failures: number;
  successRate: number;
  consecutiveFailures: number;
  avgDurationMs: number;
  /** Rolling success rate over the most recent window (more reactive than lifetime rate). */
  recentSuccessRate: number;
  errorBreakdown: Record<string, number>;
  toolUsage: Record<string, number>;
  firstSeenAt: number;
  lastActionAt: number;
  optimizations: AgentOptimization[];
}

interface AgentTrackState {
  records: AgentActionRecord[];
  consecutiveFailures: number;
  firstSeenAt: number;
}

const MAX_RECORDS_PER_AGENT = 200;
const RECENT_WINDOW = 10;

export class AgentTracker {
  private agents: Map<string, AgentTrackState> = new Map();

  recordAction(agentId: string, action: Omit<AgentActionRecord, 'timestamp'>): void {
    if (!agentId) return;
    let state = this.agents.get(agentId);
    if (!state) {
      state = { records: [], consecutiveFailures: 0, firstSeenAt: Date.now() };
      this.agents.set(agentId, state);
    }
    state.records.push({ ...action, timestamp: Date.now() });
    if (state.records.length > MAX_RECORDS_PER_AGENT) state.records.shift();
    state.consecutiveFailures = action.outcome === 'error' ? state.consecutiveFailures + 1 : 0;
  }

  getTrackedAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  getProfile(agentId: string): AgentPerformanceProfile | null {
    const state = this.agents.get(agentId);
    if (!state || state.records.length === 0) return null;

    const records = state.records;
    const successes = records.filter((r) => r.outcome === 'ok').length;
    const failures = records.length - successes;
    const successRate = successes / records.length;
    const recent = records.slice(-RECENT_WINDOW);
    const recentSuccessRate = recent.filter((r) => r.outcome === 'ok').length / recent.length;
    const avgDurationMs = Math.round(records.reduce((sum, r) => sum + r.durationMs, 0) / records.length);

    const errorBreakdown: Record<string, number> = {};
    const toolUsage: Record<string, number> = {};
    for (const r of records) {
      toolUsage[r.tool] = (toolUsage[r.tool] ?? 0) + 1;
      if (r.outcome === 'error') {
        const code = r.errorCode ?? 'UNKNOWN';
        errorBreakdown[code] = (errorBreakdown[code] ?? 0) + 1;
      }
    }

    const status: AgentHealthStatus =
      state.consecutiveFailures >= 3 || recentSuccessRate < 0.4 ? 'critical'
      : recentSuccessRate < 0.75 || state.consecutiveFailures >= 2 ? 'degraded'
      : 'optimal';

    const profile: AgentPerformanceProfile = {
      agentId,
      status,
      totalActions: records.length,
      successes,
      failures,
      successRate: Number(successRate.toFixed(3)),
      consecutiveFailures: state.consecutiveFailures,
      avgDurationMs,
      recentSuccessRate: Number(recentSuccessRate.toFixed(3)),
      errorBreakdown,
      toolUsage,
      firstSeenAt: state.firstSeenAt,
      lastActionAt: records[records.length - 1].timestamp,
      optimizations: [],
    };
    profile.optimizations = this.deriveOptimizations(profile, records);
    return profile;
  }

  getAllProfiles(): AgentPerformanceProfile[] {
    return this.getTrackedAgentIds()
      .map((id) => this.getProfile(id))
      .filter((p): p is AgentPerformanceProfile => p !== null)
      .sort((a, b) => b.lastActionAt - a.lastActionAt);
  }

  /**
   * Inline optimization hook: returns a short corrective directive when the
   * agent's live health warrants one, or null when it is running well.
   * Appended to tool responses so course-correction happens in-action.
   */
  getInlineDirective(agentId: string): string | null {
    const profile = this.getProfile(agentId);
    if (!profile || profile.status === 'optimal') return null;
    const top = profile.optimizations[0];
    if (!top) return null;
    const label = profile.status === 'critical' ? 'AGENT OPTIMIZER (critical)' : 'Agent Optimizer';
    return `[${label}] ${top.directive}${top.suggestedTool ? ` → call ${top.suggestedTool}` : ''} (recent success rate ${Math.round(profile.recentSuccessRate * 100)}%, ${profile.consecutiveFailures} consecutive failure(s))`;
  }

  private deriveOptimizations(profile: AgentPerformanceProfile, records: AgentActionRecord[]): AgentOptimization[] {
    const out: AgentOptimization[] = [];
    const recentErrors = records.slice(-RECENT_WINDOW).filter((r) => r.outcome === 'error');
    const countRecent = (code: string) => recentErrors.filter((r) => r.errorCode === code).length;

    if (profile.consecutiveFailures >= 3) {
      out.push({
        id: 'diagnose-before-retrying',
        severity: 'critical',
        directive: `${profile.consecutiveFailures} consecutive failures — stop retrying blindly and classify the browser state first.`,
        suggestedTool: 'diagnose_agent_state',
      });
    }
    if (countRecent('TARGET_NOT_FOUND') >= 2) {
      out.push({
        id: 'refresh-stale-element-ids',
        severity: 'warning',
        directive: 'Repeated TARGET_NOT_FOUND errors indicate stale element IDs — re-extract the semantic tree before the next interaction.',
        suggestedTool: 'get_semantic_tree_optimized',
      });
    }
    const interactErrors = records.filter((r) => r.tool === 'interact' && r.outcome === 'error').length;
    const interactTotal = profile.toolUsage['interact'] ?? 0;
    if (interactTotal >= 4 && interactErrors / interactTotal > 0.4) {
      out.push({
        id: 'verify-before-interact',
        severity: 'warning',
        directive: `${Math.round((interactErrors / interactTotal) * 100)}% of raw interact calls fail — compile intents into verified actions (preconditions + execution gating) instead.`,
        suggestedTool: 'compile_verified_action',
      });
    }
    if (countRecent('CAPTCHA_REQUIRED') >= 1) {
      out.push({
        id: 'resolve-captcha-block',
        severity: 'critical',
        directive: 'A CAPTCHA is blocking this agent — request human intervention or load an authenticated snapshot rather than re-attempting.',
        suggestedTool: 'request_human_intervention',
      });
    }
    if (countRecent('TIMEOUT') + countRecent('NETWORK_TRANSIENT') >= 2) {
      out.push({
        id: 'reduce-page-weight',
        severity: 'hint',
        directive: 'Multiple timeout/network failures — enable resource blocking and re-check runtime health before continuing.',
        suggestedTool: 'get_runtime_health',
      });
    }
    if (profile.avgDurationMs > 20_000) {
      out.push({
        id: 'tighten-token-budget',
        severity: 'hint',
        directive: `Average call latency is ${Math.round(profile.avgDurationMs / 1000)}s — pass a maxTokens budget to semantic extraction and narrow intents to prune the DOM harder.`,
        suggestedTool: 'get_semantic_tree_optimized',
      });
    }
    if (out.length === 0 && profile.status !== 'optimal') {
      out.push({
        id: 'general-degradation',
        severity: 'hint',
        directive: 'Success rate is dropping — diagnose the current browser state before the next action.',
        suggestedTool: 'diagnose_agent_state',
      });
    }

    const severityRank = { critical: 0, warning: 1, hint: 2 };
    return out.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  }
}
