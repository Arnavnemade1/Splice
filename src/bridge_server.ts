/**
 * Splice Bridge Server
 *
 * Localhost HTTP bridge used by the Python MCP wrapper (python/splice_mcp).
 * Accepts POST { action, args } on 127.0.0.1:4000 and proxies into the same
 * BrowserManager core as the Node MCP server, with the same runtime
 * reliability guarantees: journaled calls, typed error envelopes, per-call
 * deadlines, agent tracking, and self-healing recovery.
 *
 * Responses use the { ok, result } envelope the Python wrapper unwraps;
 * errors carry { ok: false, error, errorCode, errorEnvelope }.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { BrowserManager } from './BrowserManager.js';
import { RunJournal } from './RunJournal.js';
import { classifyError, withTimeout, errorMessage } from './Resilience.js';

const PORT = Number(process.env.SPLICE_BRIDGE_PORT || 4000);
const HOST = '127.0.0.1';
const CALL_TIMEOUT_MS = 120_000;

const spliceDir = path.join(process.cwd(), '.splice');
fs.mkdirSync(spliceDir, { recursive: true });

const journal = new RunJournal(spliceDir);
const browser = new BrowserManager();
browser.onReliabilityEvent = (kind, detail) => journal.record({ kind, outcome: 'info', detail });
browser.journalStatsProvider = () => journal.getStats() as unknown as Record<string, unknown>;

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await browser.init();
    initialized = true;
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function dispatch(action: string, args: Record<string, any>): Promise<unknown> {
  await ensureInit();
  switch (action) {
    case 'init':
      return { ok: true, activeBranch: browser.activeBranch };
    case 'navigate':
      await browser.navigate(args.url);
      return { ok: true, url: args.url };
    case 'getSemanticTree':
      return browser.getSemanticTree(args.intent, args.lens || 'UX', args.maxTokens);
    case 'interact': {
      // Python wrapper sends "interaction"; Node tools send "action".
      const interaction = args.interaction || args.action;
      await browser.interact(args.elementId, interaction, args.value, args.agentId);
      return { ok: true, elementId: args.elementId, action: interaction };
    }
    case 'diagnoseAgentState':
      return browser.diagnoseAgentState(args.goal, Array.isArray(args.lastActions) ? args.lastActions : []);
    case 'compileVerifiedAction':
      return browser.compileVerifiedAction({
        intent: args.intent,
        value: args.value,
        constraints: args.constraints,
        execute: args.execute === true,
      });
    case 'runSecurityAudit':
      return browser.runSecurityAudit(args.targetUrl, args);
    case 'generateObservabilityReport':
      return { path: await browser.generateObservabilityReport() };
    case 'getRuntimeHealth':
      return { ...browser.getRuntimeHealth(), journal: journal.getStats() };
    case 'exportRunJournal': {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : 50;
      return { journalPath: journal.journalPath, sessionId: journal.sessionId, entries: journal.tail(limit) };
    }
    case 'getAgentAnalytics':
      if (args.agentId) {
        return browser.agentTracker.getProfile(args.agentId) ?? { error: `No tracked activity for agent "${args.agentId}".` };
      }
      return browser.agentTracker.getAllProfiles();
    case 'close':
      await browser.close();
      initialized = false;
      return { ok: true };
    default:
      throw new Error(`Unknown bridge action: "${action}"`);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'Use POST with { action, args } JSON.' });
    return;
  }
  const startedAt = Date.now();
  let action = 'unknown';
  try {
    const body = await readJson(req);
    action = String(body.action || 'unknown');
    const args = body.args || {};
    const result = await withTimeout(dispatch(action, args), CALL_TIMEOUT_MS, `bridge:${action}`);
    const durationMs = Date.now() - startedAt;
    journal.record({ kind: 'tool_call', tool: `bridge:${action}`, arguments: args, outcome: 'ok', durationMs });
    if (typeof args.agentId === 'string') {
      browser.agentTracker.recordAction(args.agentId, { tool: action, outcome: 'ok', durationMs });
    }
    send(res, 200, { ok: true, result });
  } catch (e) {
    const classified = classifyError(e);
    journal.record({
      kind: 'tool_call',
      tool: `bridge:${action}`,
      outcome: 'error',
      durationMs: Date.now() - startedAt,
      errorCode: classified.code,
      detail: classified.message,
    });
    send(res, 500, {
      ok: false,
      error: classified.message,
      errorCode: classified.code,
      errorEnvelope: classified.toEnvelope(),
    });
  }
});

process.on('unhandledRejection', (reason) => {
  journal.record({ kind: 'crash', outcome: 'error', errorCode: 'UNHANDLED_REJECTION', detail: errorMessage(reason) });
  console.error('[Splice Bridge] Unhandled rejection absorbed:', errorMessage(reason));
});
process.on('uncaughtException', (error) => {
  journal.record({ kind: 'crash', outcome: 'error', errorCode: 'UNCAUGHT_EXCEPTION', detail: errorMessage(error) });
  console.error('[Splice Bridge] Uncaught exception absorbed:', errorMessage(error));
});

async function shutdown(signal: string) {
  console.error(`[Splice Bridge] Received ${signal} — shutting down gracefully...`);
  journal.record({ kind: 'lifecycle', outcome: 'info', detail: `shutdown_${signal.toLowerCase()}` });
  server.close();
  try {
    await withTimeout(browser.close(), 10_000, 'bridge shutdown');
  } catch (e) {
    console.error('[Splice Bridge] Browser close during shutdown failed:', errorMessage(e));
  }
  journal.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.error(`[Splice Bridge] Listening on http://${HOST}:${PORT} (journal: ${journal.journalPath})`);
});
