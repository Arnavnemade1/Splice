export type SemanticLens = 'UX' | 'Security' | 'Performance' | 'Vision' | 'Network' | 'Behavior';

export interface SemanticNode {
  id: string;
  type: string;
  text?: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: SemanticNode[];
  score?: number;
  
  // Lens-specific metadata
  securityFlags?: string[]; // E.g., 'hidden-input', 'external-script', 'insecure-form'
  performanceMetrics?: {
    nodeCount?: number;
    depth?: number;
    isLargeImage?: boolean;
  };
  networkSummary?: {
    totalRequests: number;
    endpoints: string[];
    dataTypes: string[];
  };
  behaviorSummary?: {
    clicks: number;
    hovers: number;
    rageClicks: number;
    avgDwellTime: number;
    visibilityMs?: number;
    errorCount?: number;
    abandonedInputs?: number;
    maxScrollDepth?: number; // 0-100
    frictionScore: number; // 0-100
  };
}

export interface TelemetryLog {
  type: 'console' | 'network' | 'behavior';
  timestamp: number;
  data: any;
}

export interface SessionMetrics {
  tokensSavedEstimate: number;
  preventedErrors: number;
  captchaInterruptions: number;
  selfHealCount: number;
  /** Tokens re-sent by full tree reads whose content was identical to the previous read. */
  redundantObservationTokens: number;
}

export type AgentFailureClass =
  | 'ready'
  | 'ui_obstruction'
  | 'captcha'
  | 'validation_blocked'
  | 'auth_required'
  | 'navigation_pending'
  | 'network_failure'
  | 'stale_or_missing_target'
  | 'ambiguous_target'
  | 'unknown';

export interface AgentStateDiagnosis {
  state: AgentFailureClass;
  confidence: number;
  summary: string;
  evidence: string[];
  recommendedNextAction: {
    tool: string;
    target?: string;
    reason: string;
  };
  page: {
    url: string;
    title: string;
    activeBranch: string;
  };
  signals: {
    dialogs: number;
    obstructiveOverlays: number;
    disabledControls: number;
    invalidFields: number;
    captchaFrames: number;
    loadingIndicators: number;
    recentNetworkErrors: number;
    actionableElements: number;
  };
  /** Predictive layer: how the state is evolving across recent diagnoses. */
  trend?: {
    /** How many consecutive diagnoses (including this one) returned the same state. */
    repeatedStateCount: number;
    /** The state seen in the previous diagnosis, if any. */
    previousState?: AgentFailureClass;
    /** True when the workflow appears wedged: same non-ready state 3+ times on the same URL. */
    likelyStuck: boolean;
    /** Heuristic forecast of what happens if the agent repeats its current approach. */
    prediction: string;
  };
  /** Learning loop: how to recover this state, learned from past verified successes on this domain. */
  recommendedRecoveryStrategy?: {
    source: 'learned' | 'general';
    advice: string;
    /** Present when source is 'learned': past patterns that worked here, most-proven first. */
    learnedPatterns?: Array<{ intent: string; action: string; targetLabel?: string; successCount: number }>;
  };
}

/** Delta-first observation: what changed since the previous semantic snapshot. */
export interface SemanticDelta {
  /** Hash of the baseline snapshot this delta was computed against. */
  deltaOf: string;
  /** Hash of the fresh snapshot — pass it back as lastSnapshotHash on the next delta call. */
  snapshotHash: string;
  url: { before: string; after: string; changed: boolean };
  title: { before: string; after: string; changed: boolean };
  added: Array<{ id: string; type: string; text?: string; tag?: string }>;
  removed: Array<{ id: string; text?: string; tag?: string }>;
  changed: Array<{ id: string; field: 'text' | 'value'; before: string; after: string }>;
  unchangedCount: number;
  summary: string;
  /** Present with structuralOnly: how many text-only mutations were suppressed as churn. */
  textChangesIgnored?: number;
  /** Rough tokens saved by receiving this delta instead of the full tree. */
  estimatedTokensSaved?: number;
}

/** How a speculatively pre-loaded branch differs from the active branch. */
export interface SpeculativeBranchSummary {
  branchId: string;
  url: string;
  /** 'ready' when the page loaded and was compared within the wait budget; 'loading' when it is still pre-loading in the background. */
  status: 'ready' | 'loading';
  title?: string;
  comparedToActive?: {
    /** Elements present on this branch but not on the active branch (by tag + text signature). */
    uniqueElements: number;
    /** Active-branch elements absent from this branch. */
    missingElements: number;
    uniqueSample: string[];
    summary: string;
  } | null;
}

/**
 * Returned instead of a SemanticDelta when no meaningful diff is possible —
 * either no baseline exists yet, or the client's lastSnapshotHash no longer
 * matches the server baseline. The fresh full tree is included so the client
 * never needs a second round-trip; the new baseline is established.
 */
export interface FullTreeFallback {
  fullTreeRequired: true;
  reason: string;
  /** Hash of the fresh snapshot — pass it back as lastSnapshotHash on the next delta call. */
  snapshotHash: string;
  tree: SemanticNode;
}

export interface VerifiedActionPlan {
  intent: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  plan: Array<{
    action: 'click' | 'type' | 'focus' | 'select' | 'press';
    target: string;
    value?: string;
    why: string;
  }>;
  preconditions: string[];
  postconditions: string[];
  evidence: string[];
  alternatives: Array<{
    target: string;
    score: number;
    label: string;
    reason: string;
  }>;
  verification?: {
    executed: boolean;
    passed: boolean;
    evidence: string[];
  };
  /** One-sentence forecast of what the page should look like if the action succeeds. */
  expectedOutcome?: string;
  /** Hybrid vision: base64 PNG crop of the chosen target (requested via includeVision). */
  targetPreview?: string;
  /** Delta-first: what changed on the page as a result of this action. */
  delta?: SemanticDelta;
}

// ─── Multi-Agent Collaboration Types ───────────────────────────────────────

export type AgentRole = 'explorer' | 'verifier' | 'executor' | 'auditor';

export interface AgentRegistration {
  agentId: string;
  role: AgentRole;
  registeredAt: number;
  lastActiveAt: number;
}

export interface BranchStatus {
  branchId: string;
  ownerAgentId: string | null;
  currentUrl: string;
  lastActionAt: number;
}

/** A single entry in the Immutable Evidence Ledger. Append-only. */
export interface LedgerEntry {
  /** sha256(previousId + key + JSON.stringify(value) + agentId) — chains entries */
  id: string;
  /** Semantic topic key, e.g. 'auth.status', 'checkout.form.valid' */
  key: string;
  value: unknown;
  /** 0–1 confidence score required from the writing agent */
  confidence: number;
  agentId: string;
  branchId: string;
  /** The CCS snapshotId the agent was reading when it produced this finding */
  causalSnapshot: string;
  timestamp: number;
  /** Set when a higher-confidence entry on the same key supersedes this one */
  supersededBy?: string;
}

/**
 * Canonical Context Snapshot — the single read-only object that replaces
 * all agent-to-agent messaging. Built lazily, never pushed.
 */
export interface CanonicalContext {
  /** Monotonically increasing integer ID */
  snapshotId: string;
  generatedAt: number;
  activeBranches: BranchStatus[];
  /** Only entries with confidence >= QUORUM_CONFIDENCE_THRESHOLD and not superseded */
  promotedFindings: LedgerEntry[];
  systemState: 'healthy' | 'degraded' | 'quorum_blocked';
  /** Keys whose conflicting ledger entries are blocking related actions */
  blockedKeys: string[];
  /** Human-readable action descriptions that were rejected due to quorum failure */
  blockedActions: string[];
  registeredAgents: AgentRegistration[];
}

/**
 * Measures the overhead introduced by multi-agent coordination.
 * If these counters are non-zero, the system is paying a coordination tax.
 */
export interface CoordinationTaxMetrics {
  conflictsDetected: number;
  conflictsResolved: number;
  blockedActions: number;
  ownershipViolationAttempts: number;
  forcedReleases: number;
}

export interface SummonRequest {
  id: string;
  url: string;
  timestamp: number;
  reason?: string;
  domContext?: string;
  status: 'pending' | 'acknowledged';
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}
