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
