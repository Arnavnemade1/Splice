export interface SemanticNode {
  id: string; // Unique, stable ID assigned to the element
  type: string; // Element type classification (e.g., button, link, text, heading)
  text?: string; // Visible text content
  value?: string; // Input value if applicable
  attributes?: Record<string, string>; // Meaningful attributes (e.g., placeholder, type, href)
  children?: SemanticNode[]; // Nested semantic nodes
  score?: number; // Importance score based on intent
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
