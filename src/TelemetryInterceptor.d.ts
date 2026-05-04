import type { Page } from 'playwright';
import type { TelemetryLog } from './types.js';
export declare class TelemetryInterceptor {
    private page;
    private logs;
    private readonly MAX_LOGS;
    constructor(page: Page);
    start(): void;
    getLogs(): TelemetryLog[];
    clearLogs(): void;
    private addLog;
    private handleConsole;
    private handleRequest;
    private handleResponse;
}
//# sourceMappingURL=TelemetryInterceptor.d.ts.map