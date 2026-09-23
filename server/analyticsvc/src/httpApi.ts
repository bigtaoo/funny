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

/** Build targets the launch counter accepts. Anything else is bucketed rather than stored verbatim. */
const BOOT_PLATFORMS = new Set(['web', 'wechat', 'crazygames']);

/**
 * What a config request contributes to the launch counter: the `?p=` build target, and whether `?d=1`
 * marks it as a launch by a player who refused analytics (ANALYTICS_DESIGN §3.6c).
 *
 * The platform allowlist is the point: this value becomes part of a document `_id`, on an endpoint
 * that needs no auth, so an unclamped string would let anyone mint unbounded documents in
 * `boots_daily` (and scatter the real counts across near-miss spellings). An unrecognised or missing
 * value counts as `unknown`, which is still a launch and still belongs in the denominator. `d` adds
 * no cardinality at all — it is one bit choosing which counter on an existing document to bump.
 */
function bootTick(rawUrl: string | undefined): { platform: string; declined: boolean } {
  const q = new URL(rawUrl ?? '/', 'http://x').searchParams;
  const p = q.get('p') ?? '';
  return { platform: BOOT_PLATFORMS.has(p) ? p : 'unknown', declined: q.get('d') === '1' };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1 << 20) {
        // Stop reading — a settled promise doesn't stop 'data' events, so without destroy() an
        // oversized body kept accumulating into `body` unbounded (OOM risk, P0-9 — this internal-port
        // fix was applied to gateway/matchsvc in the 2026-07-28 comm audit but missed this public port).
        req.destroy();
        reject(new Error('payload too large'));
      }
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

// How long a browser may cache the preflight for POST /analytics/events. Load-bearing, not a
// micro-optimisation: that POST carries an `Authorization` header, which makes it preflighted, and
// the client's hide/unload flush (analytics/queue.ts flushSync) has to complete while the page is
// going away. Without caching, every flush pays an OPTIONS round trip first and the unload one is
// racing teardown to do it. With it, the periodic flush keeps the preflight warm and the unload
// flush goes out as a single request. 24h is the practical ceiling browsers honour.
const PREFLIGHT_MAX_AGE_S = 86_400;

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': String(PREFLIGHT_MAX_AGE_S),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body) ?? 'null', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    // Declare the length rather than letting node fall back to chunked framing — see worldsvc's
    // httpApi/helpers.ts for the full reasoning (WORLDSVC_CONCURRENCY_AUDIT §8.5): the reverse proxy
    // now compresses JSON with a minimum-size threshold, and it cannot honour a size threshold on a
    // response whose size it does not know, so with chunked framing it compresses EVERYTHING and tiny
    // JSON replies come out ~20 bytes LARGER than they went in. No 204 branch needed here: preflight
    // replies already go through sendPreflight() below rather than through send().
    'content-length': String(payload.byteLength),
    ...corsHeaders(),
  });
  res.end(payload);
}

/** Preflight reply: headers only. A 204 must not carry a body, so this cannot go through send(). */
function sendPreflight(res: ServerResponse): void {
  res.writeHead(204, corsHeaders());
  res.end();
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
        return sendPreflight(res);
      }

      // ─── GET /analytics/config (no auth, accessible anonymously) ─────────────────────────
      if (method === 'GET' && url === '/analytics/config') {
        // Count the launch (ANALYTICS_DESIGN §3.6b). This request is the only one every launch makes
        // *before* the age and consent gates, which makes it the only denominator for the players who
        // answer neither — they never reach session_start, so every other query on this service
        // reports them as if they had not existed. Nothing identifying is recorded: only the date and
        // the build target, and the client is not asked for anything else.
        //
        // `?d=1` is the same request made a second time by a client whose player refused analytics
        // (§3.6c): it bumps the refusal counter on the same document instead of the launch counter,
        // so the launch is counted once and the ops funnel can tell "left at a gate" from "playing,
        // reporting nothing". Refusal cannot be sent as an event — it is the one answer that would
        // have to use the thing it refuses — so it arrives here, where nobody is stored either way.
        //
        // Fire-and-forget, deliberately: a Mongo hiccup must cost a tick in a trend, never the config
        // response — a client that fails to get this body runs the whole session with analytics off.
        const tick = bootTick(req.url);
        void (tick.declined ? svc.countDeclinedLaunch(tick.platform) : svc.countBoot(tick.platform))
          .catch(() => {/* silent */});
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
          const newCohort = qs.get('newCohort') === '1';
          const retention = await svc.queryRetention(days, { platform, newCohort });
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
        if (type === 'feature_guide_funnel') {
          const feature_guide_funnel = await svc.queryFeatureGuideFunnel(days, platform);
          return send(res, 200, ok({ type, feature_guide_funnel }));
        }
        if (type === 'browser_dist') {
          const browser_dist = await svc.queryBrowserDist(days);
          return send(res, 200, ok({ type, browser_dist }));
        }
        if (type === 'webview_dist') {
          const webview_dist = await svc.queryWebViewDist(days);
          return send(res, 200, ok({ type, webview_dist }));
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
        if (type === 'boot_funnel') {
          const boot_funnel = await svc.queryBootFunnel(days);
          return send(res, 200, ok({ type, boot_funnel }));
        }
        if (type === 'load_time') {
          const load_time = await svc.queryLoadTime(days);
          return send(res, 200, ok({ type, load_time }));
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
