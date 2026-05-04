import type { SemanticNode, SessionMetrics } from './types.js';
export declare class BrowserManager {
    private browser;
    private contexts;
    private pages;
    private telemetry;
    activeBranch: string;
    metrics: SessionMetrics;
    private snapshotsDir;
    init(): Promise<void>;
    private createBranch;
    private getActivePage;
    navigate(url: string): Promise<void>;
    getSemanticTree(intent?: string): Promise<SemanticNode>;
    getTelemetryLogs(): import("./types.js").TelemetryLog[];
    interact(elementId: string, action: string, value?: string, agentId?: string): Promise<void>;
    forkState(): Promise<string>;
    commitBranch(branchId: string): Promise<void>;
    saveSnapshot(name: string): Promise<any>;
    loadSnapshot(name: string): Promise<void>;
    requestHumanIntervention(reason: string): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=BrowserManager.d.ts.map