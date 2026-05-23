import http from 'node:http';
import { BrowserManager } from './BrowserManager.js';

const browser = new BrowserManager();
const port = Number(process.env.SPLICE_BRIDGE_PORT || 4000);

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

async function dispatch(action: string, args: Record<string, any>) {
  await browser.init();

  switch (action) {
    case 'init':
      return { ok: true, activeBranch: browser.activeBranch };
    case 'navigate':
      await browser.navigate(args.url);
      return { ok: true, url: args.url };
    case 'getSemanticTree':
      return browser.getSemanticTree(args.intent, args.lens || 'UX', args.maxTokens);
    case 'interact':
      await browser.interact(args.elementId, args.interaction || args.action, args.value, args.agentId);
      return { ok: true, elementId: args.elementId, action: args.interaction || args.action };
    case 'diagnoseAgentState':
      return browser.diagnoseAgentState(args.goal, Array.isArray(args.lastActions) ? args.lastActions : []);
    case 'compileVerifiedAction':
      return browser.compileVerifiedAction({
        intent: args.intent,
        value: args.value,
        execute: args.execute === true,
        constraints: args.constraints,
      });
    case 'runSecurityAudit':
      return browser.runSecurityAudit(args.targetUrl, args);
    case 'generateObservabilityReport':
      return { path: await browser.generateObservabilityReport() };
    case 'close':
      await browser.close();
      return { ok: true };
    default:
      throw new Error(`Unknown bridge action: ${action}`);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Use POST with { action, args } JSON.' });
    return;
  }

  try {
    const body = await readJson(req);
    const action = String(body.action || '');
    const result = await dispatch(action, body.args || {});
    send(res, 200, { ok: true, result });
  } catch (error: any) {
    send(res, 500, { ok: false, error: error?.message || String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.error(`[Splice Bridge] Listening on http://127.0.0.1:${port}`);
});

const shutdown = async () => {
  await browser.close().catch(() => {});
  server.close(() => process.exit(0));
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
