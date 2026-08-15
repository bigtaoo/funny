// Plain HTTP handler for the gameserver's non-WS surface, extracted from index.ts's
// `createServer((req, res) => ...)` callback so it's unit-testable against fake req/res objects.
// GET /health is unauthenticated by design (docker healthcheck / CI wait loops); everything else
// (including WS upgrade requests ws itself doesn't intercept) gets a plain 426.
import type { IncomingMessage, ServerResponse } from 'http';

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'gameserver' }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('Upgrade Required');
}
