import type { Page, Request, Response, ConsoleMessage } from 'playwright';
import type { TelemetryLog, NetworkRequestRecord } from './types.js';

export class TelemetryInterceptor {
  private logs: TelemetryLog[] = [];
  private readonly MAX_LOGS = 1000;

  /** Lifecycle-tracked network requests, oldest first. */
  private networkRecords: NetworkRequestRecord[] = [];
  private readonly MAX_NETWORK_RECORDS = 500;
  private inFlight: Map<Request, NetworkRequestRecord> = new Map();
  private nextRequestId = 1;

  constructor(private page: Page) {}

  public start() {
    this.page.on('console', this.handleConsole.bind(this));
    this.page.on('request', this.handleRequest.bind(this));
    this.page.on('response', this.handleResponse.bind(this));
    this.page.on('requestfailed', this.handleRequestFailed.bind(this));
    this.page.on('requestfinished', this.handleRequestFinished.bind(this));
  }

  public getLogs(): TelemetryLog[] {
    return this.logs;
  }

  public clearLogs() {
    this.logs = [];
  }

  /** All lifecycle-tracked requests, oldest first. */
  public getNetworkRecords(): NetworkRequestRecord[] {
    return this.networkRecords;
  }

  /** Requests that have started but not yet finished, failed, or aborted. */
  public getInFlightCount(): number {
    return this.inFlight.size;
  }

  public addLog(log: TelemetryLog) {
    this.logs.push(log);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift(); // Keep logs bounded
    }
  }

  private handleConsole(msg: ConsoleMessage) {
    const text = msg.text();
    if (text.startsWith('[SPLICE_BEHAVIOR]')) {
      try {
        const payload = JSON.parse(text.replace('[SPLICE_BEHAVIOR]', '').trim());
        this.addLog({
          type: 'behavior',
          timestamp: Date.now(),
          data: payload
        });
        return;
      } catch (e) {
        // Fallback to regular console log if JSON fails
      }
    }

    this.addLog({
      type: 'console',
      timestamp: Date.now(),
      data: {
        type: msg.type(),
        text: text,
        location: msg.location()
      }
    });
  }

  private trackRecord(record: NetworkRequestRecord) {
    this.networkRecords.push(record);
    if (this.networkRecords.length > this.MAX_NETWORK_RECORDS) {
      this.networkRecords.shift();
    }
  }

  private handleRequest(req: Request) {
    const record: NetworkRequestRecord = {
      id: this.nextRequestId++,
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      startedAt: Date.now()
    };
    this.inFlight.set(req, record);
    this.trackRecord(record);

    this.addLog({
      type: 'network',
      timestamp: Date.now(),
      data: {
        event: 'request',
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType()
      }
    });
  }

  private handleResponse(res: Response) {
    const record = this.inFlight.get(res.request());
    if (record) {
      record.status = res.status();
      record.ok = res.ok();
    }

    this.addLog({
      type: 'network',
      timestamp: Date.now(),
      data: {
        event: 'response',
        url: res.url(),
        status: res.status(),
        ok: res.ok()
      }
    });
  }

  private handleRequestFinished(req: Request) {
    const record = this.inFlight.get(req);
    if (record) {
      record.completedAt = Date.now();
      record.durationMs = record.completedAt - record.startedAt;
      this.inFlight.delete(req);
    }
  }

  private handleRequestFailed(req: Request) {
    const record = this.inFlight.get(req);
    if (record) {
      record.completedAt = Date.now();
      record.durationMs = record.completedAt - record.startedAt;
      record.failure = req.failure()?.errorText || 'unknown failure';
      record.ok = false;
      this.inFlight.delete(req);
    }
  }
}
