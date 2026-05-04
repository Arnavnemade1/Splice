export type SemanticLens = 'UX' | 'Security' | 'Performance';

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
}

export interface TelemetryLog {
  type: 'console' | 'network';
  timestamp: number;
  data: any;
}

export interface SessionMetrics {
  tokensSavedEstimate: number;
  preventedErrors: number;
  captchaInterruptions: number;
}
