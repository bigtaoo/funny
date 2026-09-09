// Plain HTTP handler for the gameserver's non-WS surface, extracted from index.ts's
// `createServer((req, res) => ...)` callback so it's unit-testable against fake req/res objects.
// GET /health is unauthenticated by design (docker healthcheck / CI wait loops); everything else
// (including WS upgrade requests ws itself doesn't intercept) gets a plain 426.
import type { IncomingMessage, ServerResponse } from 'http';

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/health') {
    // Declared length, not node's chunked fallback — see worldsvc/src/httpApi/helpers.ts for the
    // reasoning; enforced by scripts/checkEdgeCompression.mjs. One rule with no exceptions.
    const payload = Buffer.from(JSON.stringify({ ok: true, service: 'gameserver' }), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.byteLength) });
    res.end(payload);
    return;
  }
  const upgrade = Buffer.from('Upgrade Required', 'utf8');
  res.writeHead(426, { 'content-type': 'text/plain', 'content-length': String(upgrade.byteLength) });
  res.end(upgrade);
}
