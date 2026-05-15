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
