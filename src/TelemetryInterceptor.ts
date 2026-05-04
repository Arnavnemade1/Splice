import type { Page, Request, Response, ConsoleMessage } from 'playwright';
import type { TelemetryLog } from './types.js';

export class TelemetryInterceptor {
  private logs: TelemetryLog[] = [];
  private readonly MAX_LOGS = 1000;
  
  constructor(private page: Page) {}

  public start() {
    this.page.on('console', this.handleConsole.bind(this));
    this.page.on('request', this.handleRequest.bind(this));
    this.page.on('response', this.handleResponse.bind(this));
  }

  public getLogs(): TelemetryLog[] {
    return this.logs;
  }

  public clearLogs() {
    this.logs = [];
  }

  private addLog(log: TelemetryLog) {
    this.logs.push(log);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift(); // Keep logs bounded
    }
  }

  private handleConsole(msg: ConsoleMessage) {
    this.addLog({
      type: 'console',
      timestamp: Date.now(),
      data: {
        type: msg.type(),
        text: msg.text(),
        location: msg.location()
      }
    });
  }

  private handleRequest(req: Request) {
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
}
