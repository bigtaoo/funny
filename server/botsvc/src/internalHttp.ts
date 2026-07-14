// Internal admin API (BOTSVC_DESIGN §2): status/scale/pause for ops, gated by X-Internal-Key like every
// other internal-only port in this codebase. Not reachable from the public internet.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { InternalAuthVerifier } from '@nw/shared';
import type { Scheduler } from './scheduler';

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startInternalHttp(
  opts: { host: string; port: number; internalAuth: InternalAuthVerifier },
  scheduler: Scheduler,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'botsvc' });
      }
      const authz = opts.internalAuth.verify(req.headers);
      if (!authz.ok) return send(res, 401, { ok: false, error: 'unauthorized' });

      if (req.method === 'GET' && req.url === '/internal/bots/status') {
        return send(res, 200, { ok: true, ...scheduler.status() });
      }
      if (req.method === 'POST' && req.url === '/internal/bots/scale') {
        const b = await readJson(req);
        const target = typeof b.targetOnline === 'number' ? b.targetOnline : undefined;
        if (target === undefined) return send(res, 400, { ok: false, error: 'targetOnline required' });
        scheduler.setTargetOnline(target);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/internal/bots/pause') {
        scheduler.pause();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/internal/bots/resume') {
        scheduler.resume();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { ok: false, error: 'not found' });
    })().catch((e) => send(res, 400, { ok: false, error: (e as Error).message }));
  });
  server.listen(opts.port, opts.host);
  return server;
}
