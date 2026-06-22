// analyticsvc HTTP API（A9-1 / A9-2 / A9-3）。
// node:http + 四个端点：
//   GET  /health              无鉴权（Docker healthcheck）
//   GET  /analytics/config    无鉴权（匿名用户 session 开始时拉）
//   POST /analytics/events    JWT 可选（有 token 附 user_id，否则匿名）
//   GET  /internal/query      X-Internal-Key（ops 后台聚合查询）
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  extractBearer,
  verifyToken,
  ErrorCode,
  ERROR_HTTP_STATUS,
  ok,
  err,
  type InternalAuthVerifier,
} from '@nw/shared';
import type { AnalyticsService, EventBatch } from './service';

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
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalAuth: InternalAuthVerifier },
  svc: AnalyticsService,
): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = req.url?.split('?')[0] ?? '';

      if (method === 'GET' && url === '/health') {
        return send(res, 200, { ok: true, service: 'analyticsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      // ─── GET /analytics/config（无鉴权，匿名可拉）─────────────────────────
      if (method === 'GET' && url === '/analytics/config') {
        return send(res, 200, ok(svc.getConfig()));
      }

      // ─── POST /analytics/events（JWT 可选）────────────────────────────────
      if (method === 'POST' && url === '/analytics/events') {
        let userId: string | undefined;
        const token = extractBearer(req.headers['authorization']);
        if (token) {
          try {
            userId = verifyToken(token, { secret: opts.jwtSecret });
          } catch {
            // JWT 无效：继续作匿名处理，不拒绝请求（分析数据宽容）
          }
        }

        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch {
          return sendErr(res, ErrorCode.BAD_REQUEST, 'invalid JSON');
        }

        const batch = body as unknown as EventBatch;
        if (!Array.isArray(batch.events) || batch.events.length === 0) {
          return sendErr(res, ErrorCode.BAD_REQUEST, 'events must be a non-empty array');
        }
        if (batch.events.length > 100) {
          return sendErr(res, ErrorCode.BAD_REQUEST, 'events 最多 100 条/请求');
        }

        // C5-c GDPR：已识别用户（userId 存在）必须携带 consent=true 才落库；匿名用户直接通过。
        if (userId && !batch.consent) {
          return send(res, 200, ok(null)); // 无同意静默丢弃，不返回错误（不影响体验）
        }
        // fire-and-forget：上报失败静默返回 200（不影响游戏体验）
        svc.ingestEvents(batch, userId).catch(() => {/* 静默 */});
        return send(res, 200, ok(null));
      }

      // ─── GET /internal/query（X-Internal-Key，ops 后台用，A9-6）─────────
      if (method === 'GET' && url.startsWith('/internal/query')) {
        if (!opts.internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, 'invalid internal key');
        }
        const qs = new URL(req.url ?? '/', 'http://x').searchParams;
        const type = qs.get('type') ?? 'event_counts';
        const days = Math.min(90, Math.max(1, Number(qs.get('days') ?? '7')));
        const platform = qs.get('platform') ?? undefined;

        if (type === 'event_counts') {
          const counts = await svc.queryEventCounts(days);
          return send(res, 200, ok({ type, counts }));
        }
        if (type === 'dau') {
          const dau = await svc.queryDau(days);
          return send(res, 200, ok({ type, dau }));
        }
        if (type === 'funnel') {
          const funnel = await svc.queryFunnel(days, platform);
          return send(res, 200, ok({ type, funnel }));
        }
        if (type === 'region_dist') {
          const regions = await svc.queryRegionDist(days);
          return send(res, 200, ok({ type, regions }));
        }
        if (type === 'os_dist') {
          const os_dist = await svc.queryOsDist(days);
          return send(res, 200, ok({ type, os_dist }));
        }
        if (type === 'login_hour') {
          const login_hour = await svc.queryLoginHour(days);
          return send(res, 200, ok({ type, login_hour }));
        }
        if (type === 'retention') {
          const retention = await svc.queryRetention(days);
          return send(res, 200, ok({ type, retention }));
        }
        return sendErr(res, ErrorCode.BAD_REQUEST, `unknown query type: ${type}`);
      }

      return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
    })();
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`[analyticsvc] listening on ${opts.host}:${opts.port}`);
  });
  return server;
}
