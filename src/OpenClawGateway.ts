import { WebSocketServer, WebSocket } from 'ws';
import type { BrowserManager } from './BrowserManager.js';

export class OpenClawGateway {
  private wss: WebSocketServer | null = null;
  private activeConnections: Set<WebSocket> = new Set();
  private port: number;

  constructor(private browser: BrowserManager) {
    this.port = process.env.OPENCLAW_GATEWAY_PORT ? parseInt(process.env.OPENCLAW_GATEWAY_PORT) : 18789;
  }

  /**
   * Start the OpenClaw Gateway WebSocket Server.
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (this.wss) {
          console.warn("[OpenClaw Gateway] Server is already running.");
          resolve();
          return;
        }

        this.wss = new WebSocketServer({ port: this.port, host: '127.0.0.1' });

        this.wss.on('listening', () => {
          console.error(`[OpenClaw Gateway] Active and listening securely on ws://127.0.0.1:${this.port}`);
          resolve();
        });

        this.wss.on('connection', (ws) => {
          console.error("[OpenClaw Gateway] New OpenClaw client connected.");
          this.activeConnections.add(ws);

          // Send immediate handshake confirmation with advertised capabilities
          ws.send(JSON.stringify({
            event: 'handshake',
            status: 'connected',
            version: '2.2.0',
            engine: 'Splice Enterprise Browser Core',
            capabilities: [
              'navigate',
              'interact',
              'diagnose',
              'compile_verified_action',
              'get_semantic_tree',
              'get_semantic_delta',
              'run_security_audit',
              'capture_screenshot',
              'session_status',
              'get_runtime_health',
              'get_agent_analytics'
            ],
            timestamp: Date.now()
          }));

          ws.on('message', async (data) => {
            try {
              const message = JSON.parse(data.toString());
              await this.handleMessage(ws, message);
            } catch (e: any) {
              ws.send(JSON.stringify({
                status: 'error',
                error: `Invalid message format: ${e.message}`
              }));
            }
          });

          ws.on('close', () => {
            console.error("[OpenClaw Gateway] Client disconnected.");
            this.activeConnections.delete(ws);
          });

          ws.on('error', (err) => {
            console.error(`[OpenClaw Gateway] Connection error: ${err.message}`);
            this.activeConnections.delete(ws);
          });
        });

        this.wss.on('error', (err: any) => {
          console.error(`[OpenClaw Gateway] Server error: ${err.message}`);
          reject(err);
        });

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the server and close all client connections.
   */
  public async stop(): Promise<void> {
    if (!this.wss) return;

    console.error("[OpenClaw Gateway] Stopping Gateway Server...");
    for (const ws of this.activeConnections) {
      ws.close();
    }
    this.activeConnections.clear();

    await new Promise<void>((resolve) => {
      this.wss!.close(() => {
        this.wss = null;
        resolve();
      });
    });
    console.error("[OpenClaw Gateway] Server stopped successfully.");
  }

  /**
   * Broadcast message to all active clients (useful for real-time telemetry/forensics).
   */
  public broadcast(event: string, payload: any) {
    if (!this.wss || this.activeConnections.size === 0) return;

    const data = JSON.stringify({ event, data: payload, timestamp: Date.now() });
    for (const ws of this.activeConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Parse and execute commands originating from OpenClaw clients.
   */
  private async handleMessage(ws: WebSocket, msg: any) {
    const { command, args, id } = msg;

    if (!command) {
      ws.send(JSON.stringify({ id, status: 'error', error: 'Missing "command" field' }));
      return;
    }

    try {
      console.error(`[OpenClaw Gateway] Received command: "${command}"`);
      let result: any;

      switch (command) {
        case 'navigate': {
          const { url } = args || {};
          if (!url) throw new Error('Missing "url" parameter for navigate');
          await this.browser.navigate(url);
          result = { success: true, url };
          break;
        }

        case 'interact': {
          const { elementId, action, value, agentId } = args || {};
          if (!elementId || !action) throw new Error('Missing "elementId" or "action" parameters for interact');
          await this.browser.interact(elementId, action, value, agentId);
          result = { success: true, elementId, action };
          break;
        }

        case 'diagnose': {
          const { goal, lastActions } = args || {};
          const diagnosis = await this.browser.diagnoseAgentState(goal, lastActions);
          result = diagnosis;
          break;
        }

        case 'compile_verified_action': {
          const { intent, value, constraints, execute, includeVision } = args || {};
          if (!intent) throw new Error('Missing "intent" parameter for compile_verified_action');
          result = await this.browser.compileVerifiedAction({
            intent,
            value,
            constraints,
            execute: execute === true,
            includeVision: includeVision === true
          });
          break;
        }

        case 'get_runtime_health': {
          result = this.browser.getRuntimeHealth();
          break;
        }

        case 'get_agent_analytics': {
          const { agentId } = args || {};
          result = agentId
            ? this.browser.agentTracker.getProfile(agentId) ?? { error: `No tracked activity for agent "${agentId}".` }
            : this.browser.agentTracker.getAllProfiles();
          break;
        }

        case 'get_semantic_tree': {
          const { intent, lens, maxTokens } = args || {};
          const tree = await this.browser.getSemanticTree(intent, lens, maxTokens);
          result = tree;
          break;
        }

        case 'get_semantic_delta': {
          const { intent, lens, lastSnapshotHash, structuralOnly } = args || {};
          result = await this.browser.getSemanticDelta(intent, lens, lastSnapshotHash, structuralOnly === true);
          break;
        }

        case 'run_security_audit': {
          const { targetUrl, safeMode, crawl, maxCrawlDepth, checks } = args || {};
          if (!targetUrl) throw new Error('Missing "targetUrl" parameter for security audit');
          const report = await this.browser.runSecurityAudit(targetUrl, {
            safeMode,
            crawl,
            maxCrawlDepth,
            checks
          });
          result = report;
          break;
        }

        case 'capture_screenshot': {
          const screenshot = await this.browser.captureAnnotatedScreenshot();
          result = { screenshot: `data:image/png;base64,${screenshot}` };
          break;
        }

        case 'session_status': {
          result = {
            url: this.browser.getActivePage().url(),
            title: await this.browser.getActivePage().title(),
            metrics: this.browser.metrics,
            liveFeed: this.browser.getLiveFeed()
          };
          break;
        }

        default:
          throw new Error(`Unsupported OpenClaw command: "${command}"`);
      }

      ws.send(JSON.stringify({
        id,
        status: 'success',
        command,
        data: result,
        timestamp: Date.now()
      }));

    } catch (e: any) {
      ws.send(JSON.stringify({
        id,
        status: 'error',
        command,
        error: e.message,
        timestamp: Date.now()
      }));
    }
  }
}
