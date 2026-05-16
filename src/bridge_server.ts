import http from 'node:http';
import { BrowserManager } from './BrowserManager.js';
import process from 'node:process';

const manager = new BrowserManager();

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { action, args = {} } = payload;
        
        let result;
        switch (action) {
          case 'init':
            await manager.init();
            result = { status: 'initialized' };
            break;
          case 'navigate':
            await manager.navigate(args.url);
            result = { status: 'navigated' };
            break;
          case 'getSemanticTree':
            result = await manager.getSemanticTree(args.intent, args.lens, args.maxTokens);
            break;
          case 'interact':
            await manager.interact(args.elementId, args.interaction, args.value, args.agentId);
            result = { status: 'interacted' };
            break;
          case 'runSecurityAudit':
            result = await manager.runSecurityAudit(args.targetUrl, args.options);
            break;
          case 'close':
            await manager.close();
            result = { status: 'closed' };
            break;
          default:
            res.statusCode = 400;
            result = { error: `Unknown action: ${action}` };
        }
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found. Use POST with JSON payload.' }));
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[Splice Bridge] Server listening on port ${PORT}`);
});
