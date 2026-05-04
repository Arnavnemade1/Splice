export interface SemanticNode {
    id: string;
    type: string;
    text?: string;
    value?: string;
    attributes?: Record<string, string>;
    children?: SemanticNode[];
    score?: number;
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
//# sourceMappingURL=types.d.ts.map