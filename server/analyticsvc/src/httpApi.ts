// analyticsvc HTTP API (A9-1 / A9-2 / A9-3).
// node:http + four endpoints:
//   GET  /health              no auth (Docker healthcheck)
//   GET  /analytics/config    no auth (pulled by anonymous users at session start)
//   POST /analytics/events    optional JWT (attaches user_id if token present, otherwise anonymous)
//   GET  /internal/query      X-Internal-Key (aggregation queries from ops back-end)
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import geoip from 'geoip-lite';
import {
  extractBearer,
  verifyToken,
  ErrorCode,
  ERROR_HTTP_STATUS,
  ok,
  err,
  type InternalAuthVerifier,
} from '@nw/shared';
import type { AnalyticsService, EventBatch, ResolvedGeo } from './service';

/** Client IP from the Caddy-injected X-Forwarded-For (first hop) or the raw socket as a fallback. */
function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (first) return first.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? undefined;
}

/**
 * Resolve an IP to coarse geo via geoip-lite (offline lookup, no network call) and pass the IP itself
 * through — stored for account-protection use (shared-IP abuse / multi-account detection).
 */
function resolveGeo(ip: string | undefined): ResolvedGeo | undefined {
  if (!ip) return undefined;
  const hit = geoip.lookup(ip);
  return { ip, country: hit?.country || undefined, region: hit?.region || undefined, city: hit?.city || undefined };
}

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

      // ─── GET /analytics/config (no auth, accessible anonymously) ─────────────────────────
      if (method === 'GET' && url === '/analytics/config') {
        return send(res, 200, ok(svc.getConfig()));
      }

      // ─── POST /analytics/events (optional JWT) ────────────────────────────────
      if (method === 'POST' && url === '/analytics/events') {
        let userId: string | undefined;
        const token = extractBearer(req.headers['authorization']);
        if (token) {
          try {
            userId = verifyToken(token, { secret: opts.jwtSecret });
          } catch {
            // Invalid JWT: continue as anonymous — do not reject the request (analytics data is lenient)
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
          return sendErr(res, ErrorCode.BAD_REQUEST, 'events: max 100 per request');
        }

        // C5-c GDPR: identified users (userId present) must include consent=true to be persisted; anonymous users pass through directly.
        if (userId && !batch.consent) {
          return send(res, 200, ok(null)); // no consent: silently discard, do not return error (preserves user experience)
        }
        const geo = resolveGeo(clientIp(req));
        // fire-and-forget: silently return 200 on ingestion failure (does not affect game experience)
        svc.ingestEvents(batch, userId, geo).catch(() => {/* silent */});
        return send(res, 200, ok(null));
      }

      // ─── GET /internal/query (X-Internal-Key, used by ops back-end, A9-6) ─────────
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
        if (type === 'first_session') {
          const first_session = await svc.queryFirstSession(days);
          return send(res, 200, ok({ type, first_session }));
        }
        if (type === 'level_funnel') {
          const level_funnel = await svc.queryLevelFunnel(days, platform);
          return send(res, 200, ok({ type, level_funnel }));
        }
        if (type === 'tutorial_funnel') {
          const tutorial_funnel = await svc.queryTutorialFunnel(days);
          return send(res, 200, ok({ type, tutorial_funnel }));
        }
        if (type === 'scene_funnel') {
          const scene_funnel = await svc.querySceneFunnel(days);
          return send(res, 200, ok({ type, scene_funnel }));
        }
        if (type === 'browser_dist') {
          const browser_dist = await svc.queryBrowserDist(days);
          return send(res, 200, ok({ type, browser_dist }));
        }
        if (type === 'device_type_dist') {
          const device_type_dist = await svc.queryDeviceTypeDist(days);
          return send(res, 200, ok({ type, device_type_dist }));
        }
        if (type === 'geo_dist') {
          const geo_dist = await svc.queryGeoDist(days);
          return send(res, 200, ok({ type, geo_dist }));
        }
        if (type === 'badge_dist') {
          const badge_dist = await svc.queryBadgeDist(days);
          return send(res, 200, ok({ type, badge_dist }));
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
