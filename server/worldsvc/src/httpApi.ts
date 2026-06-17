// worldsvc 公网 REST（S8-0，SLG_DESIGN §14.1 P1 / §14.6）。第四公网面：/world/* /family/* /auction/*。
// 鉴权：复用 meta JWT，仅 verifyToken 验签取 accountId（不连 accounts 库，P1）。
// 用 node:http（worldsvc 不引 fastify）。响应走 @nw/shared ApiResp 包络，错误码 → HTTP 经 ERROR_HTTP_STATUS。
// S8-0：地图/玩家状态做实；行军/防守/兵力/家族/拍卖/赛季返回 NOT_IMPLEMENTED（S8-1~5）。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  ok,
  err,
  extractBearer,
  verifyToken,
  SlgError,
  type MarchKind,
} from '@nw/shared';
import type { WorldService } from './service';

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
  res.writeHead(status, {
    'content-type': 'application/json',
    // 公网面：CORS 与 meta 对齐（dev 全开，生产由反代收紧）。
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

const NOT_IMPL = (res: ServerResponse, what: string): void =>
  sendErr(res, ErrorCode.NOT_IMPLEMENTED, `${what} 未实现（S8-1~5）`);

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string },
  svc: WorldService,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // 存活探针（无需鉴权）：docker healthcheck / CI 等待用。
      if (method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'worldsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      // —— JWT 验签（P1：仅取 accountId，不连库）——
      const token = extractBearer(req.headers['authorization']);
      let accountId: string;
      try {
        if (!token) throw new Error('no bearer');
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, '需要登录');
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
      const path = url.pathname;
      const q = url.searchParams;

      try {
        // ── 地图与领地（GET，做实）──
        if (method === 'GET' && path === '/world/me') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getMe(worldId, accountId)));
        }
        if (method === 'GET' && path === '/world/map') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const view = await svc.getMap(
            worldId,
            accountId,
            numQ(q.get('cx'), 0),
            numQ(q.get('cy'), 0),
            numQ(q.get('r'), 10),
          );
          return send(res, 200, ok(view));
        }
        if (method === 'GET' && path.startsWith('/world/tile/')) {
          const tid = decodeURIComponent(path.slice('/world/tile/'.length));
          const parts = tid.split(':');
          if (parts.length !== 3) return sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId');
          const worldId = parts[0]!;
          const x = Number(parts[1]);
          const y = Number(parts[2]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId coords');
          }
          return send(res, 200, ok(await svc.getTile(worldId, accountId, x, y)));
        }

        // ── 行军列表（S8-2，做实）──
        if (method === 'GET' && path === '/world/march') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getMarches(worldId, accountId)));
        }

        // ── 进入世界 / 占领 / 放弃（S8-1，做实）──
        if (method === 'POST' && (path === '/world/join' || path === '/world/occupy' || path === '/world/abandon')) {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const x = Number(body.x);
          const y = Number(body.y);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required');
          }
          if (path === '/world/join') {
            return send(res, 200, ok(await svc.joinWorld(worldId, accountId, x, y)));
          }
          if (path === '/world/occupy') {
            return send(res, 200, ok(await svc.occupyTile(worldId, accountId, x, y)));
          }
          return send(res, 200, ok(await svc.abandonTile(worldId, accountId, x, y)));
        }

        // ── 行军（S8-2，做实）──
        if (method === 'POST' && path === '/world/march') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const fromX = Number(body.fromX);
          const fromY = Number(body.fromY);
          const toX = Number(body.toX);
          const toY = Number(body.toY);
          const kind = typeof body.kind === 'string' ? body.kind : '';
          const troops = Number(body.troops);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
          }
          return send(
            res,
            200,
            ok(await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind as MarchKind, troops)),
          );
        }
        {
          const m = /^\/world\/march\/([^/]+)\/recall$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await svc.recallMarch(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }

        // ── 扫荡（S8-3，§14.6 便捷别名 = march kind:'sweep'）──
        if (method === 'POST' && path === '/world/sweep') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const fromX = Number(body.fromX);
          const fromY = Number(body.fromY);
          const toX = Number(body.toX);
          const toY = Number(body.toY);
          const troops = Number(body.troops);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
          }
          return send(res, 200, ok(await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, 'sweep', troops)));
        }

        // ── 防守 / 兵力（写，S8-3+ stub）──
        if (method === 'PUT' && path === '/world/defense') return NOT_IMPL(res, 'defense');
        if (method === 'POST' && path === '/world/troops/train') return NOT_IMPL(res, 'train');
        if (method === 'POST' && path === '/world/troops/speedup') return NOT_IMPL(res, 'speedup');

        // ── 家族 / 拍卖 / 赛季（S8-4/S8-5/S8-7 stub）──
        if (path.startsWith('/family')) return NOT_IMPL(res, 'family');
        if (path.startsWith('/auction')) return NOT_IMPL(res, 'auction');
        if (method === 'GET' && path === '/world/season') return NOT_IMPL(res, 'season');

        return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
      } catch (e) {
        if (e instanceof SlgError) return sendErr(res, e.code, e.message);
        send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
