// 内部 HTTP（M17，不暴露公网）：gameserver 启动注册 + 周期心跳，让 matchsvc 知道
// 哪台 game 空闲可分配（SERVER_API.md §8.1 game → matchsvc）。鉴权：X-Internal-Key。
//
// 用 node:http（避免给 gateway 引 fastify）。端点极少，手写路由足够。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Matchsvc } from './matchsvc/Matchsvc';

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

export function startInternalHttp(
  opts: { host: string; port: number; internalKey: string },
  matchsvc: Matchsvc,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      // 内部密钥鉴权
      if (req.headers['x-internal-key'] !== opts.internalKey) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      try {
        if (req.method === 'POST' && req.url === '/mm/game/register') {
          const b = (await readJson(req)) as { gameId: string; wsUrl: string; capacity?: number };
          if (!b.gameId || !b.wsUrl) {
            send(res, 400, { ok: false, error: 'gameId and wsUrl required' });
            return;
          }
          matchsvc.registerGame(b.gameId, b.wsUrl, b.capacity ?? 100);
          send(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && req.url === '/mm/game/heartbeat') {
          const b = (await readJson(req)) as { gameId: string; load?: number; rooms?: number };
          if (!b.gameId) {
            send(res, 400, { ok: false, error: 'gameId required' });
            return;
          }
          matchsvc.gameHeartbeat(b.gameId, b.load ?? 0, b.rooms ?? 0);
          send(res, 200, { ok: true });
          return;
        }
        send(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        send(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
