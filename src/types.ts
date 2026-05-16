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
