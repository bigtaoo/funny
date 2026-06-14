// gateway 内部 HTTP（S1-M5，不暴露公网）：matchsvc 把异步事件经 /gw/push 推回 gateway，
// gateway 据 accountId 找到玩家 socket 下发。鉴权：X-Internal-Key。
//
// （拆 matchsvc 为独立进程前，这里曾接 gameserver 的 game 注册/心跳——那两个端点已随
//  GameRegistry 迁到 matchsvc 自己的内部 HTTP，gameserver 现直接注册到 matchsvc。）
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Gateway } from './Gateway';
import type { PushMsg } from './matchsvcClient';

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

export function startInternalHttp(
  opts: { host: string; port: number; internalKey: string },
  gateway: Gateway,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-internal-key'] !== opts.internalKey) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      try {
        if (req.method === 'POST' && req.url === '/gw/push') {
          const b = (await readJson(req)) as { accountId?: string; msg?: PushMsg };
          if (!b.accountId || !b.msg) {
            send(res, 400, { ok: false, error: 'accountId and msg required' });
            return;
          }
          gateway.push(b.accountId, b.msg);
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
