// auctionsvc HTTP API (auction task 3: health check only; /auction/* routes land in task 4).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

export function startHttpApi(opts: { host: string; port: number }): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = req.url?.split('?')[0] ?? '';

    if (method === 'GET' && url === '/health') {
      return send(res, 200, { ok: true, service: 'auctionsvc' });
    }
    if (method === 'OPTIONS') {
      return send(res, 204, {});
    }

    send(res, 404, { ok: false, error: 'not_found' });
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`[auctionsvc] listening on ${opts.host}:${opts.port}`);
  });

  return server;
}
