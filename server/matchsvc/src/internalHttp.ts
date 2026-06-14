// matchsvc 内部 HTTP（S1-M5，不暴露公网）。两类调用方，鉴权均为 X-Internal-Key：
//   • gateway（控制面网关）：转发玩家控制命令 → /mm/room/* · /mm/queue/* · /mm/conn/*；
//   • gameserver（数据面）：启动注册 + 周期心跳 → /mm/game/register · /mm/game/heartbeat。
//
// 用 node:http（matchsvc 不引 fastify）。命令均为「收到即处理、异步事件经 GatewayClient 回推」，
// 故响应只回 {ok:true}（不在 HTTP 响应里带房间态）。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Matchsvc } from './Matchsvc';

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) reject(new Error('payload too large'));
    });
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

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d);

export function startInternalHttp(
  opts: { host: string; port: number; internalKey: string },
  svc: Matchsvc,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-internal-key'] !== opts.internalKey) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method !== 'POST') {
        send(res, 404, { ok: false, error: 'not found' });
        return;
      }
      try {
        const b = await readJson(req);
        switch (req.url) {
          // —— gateway 控制命令 ——
          case '/mm/room/create':
            svc.roomCreate(str(b.accountId), str(b.name));
            break;
          case '/mm/room/join':
            svc.roomJoin(str(b.accountId), str(b.name), str(b.code));
            break;
          case '/mm/room/ready':
            svc.roomReady(str(b.accountId), Boolean(b.ready));
            break;
          case '/mm/room/start':
            svc.roomStart(str(b.accountId));
            break;
          case '/mm/room/leave':
            svc.roomLeave(str(b.accountId));
            break;
          case '/mm/queue/enqueue':
            svc.enqueue(str(b.accountId), str(b.name), num(b.elo, 1000));
            break;
          case '/mm/conn/connected':
            svc.onConnected(str(b.accountId));
            break;
          case '/mm/conn/disconnected':
            svc.onDisconnected(str(b.accountId));
            break;
          // —— gameserver 注册 / 心跳 ——
          case '/mm/game/register':
            if (!b.gameId || !b.wsUrl) {
              send(res, 400, { ok: false, error: 'gameId and wsUrl required' });
              return;
            }
            svc.registerGame(str(b.gameId), str(b.wsUrl), num(b.capacity, 100));
            break;
          case '/mm/game/heartbeat':
            if (!b.gameId) {
              send(res, 400, { ok: false, error: 'gameId required' });
              return;
            }
            svc.gameHeartbeat(str(b.gameId), num(b.load, 0), num(b.rooms, 0));
            break;
          default:
            send(res, 404, { ok: false, error: 'not found' });
            return;
        }
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 400, { ok: false, error: (e as Error).message });
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
