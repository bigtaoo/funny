// HTTP API exposed to the ops frontend (OPS_DESIGN §4.2). First layer of two-layer auth: admin JWT (ops user).
// The second layer, X-Internal-Key, is held by admin when calling business services (in clients.ts) and is unrelated here.
// Uses node:http (admin does not import fastify). Every endpoint enforces capability checks server-side (hiding buttons in the frontend does not count, §6).
// CORS: admin is internal-only, but the frontend is a pure browser client → allow all origins (Bearer header auth, not cookie, no credentials needed).
//
// startHttpApi was a single ~712-line function (one big if-chain over node:http request/response, not a
// framework router) — 2026-08-10 split into a thin dispatcher + one file per route domain under
// ./httpApi/, same "chain of responsibility" shape worldsvc/httpApi.ts pioneered: each domain handler
// takes the shared `RouteCtx` and returns `true` once it has matched a route and sent a response, `false`
// to let the next handler try. No two domain files match the same method+path, so route resolution is
// unchanged even though the call order below groups differently than the original physical if-chain order
// (e.g. `pvp-card-stats` moved next to `analytics.view`'s other routes, `reports`/`appeals`/`feedback`
// moved next to `anticheat` under one "trust & safety" file) — safe precisely because path sets are
// disjoint across groups, same reasoning as an index-creation call order having no behavioral meaning
// once the collections don't overlap. `session.ts` is the one exception mirroring worldsvc's
// `/admin/world/*`: its `handlePreAuth` runs BEFORE the JWT/actor exists at all (health/OPTIONS/the three
// X-Internal-Key internal endpoints), and `handleLogin` runs after that but still before `authenticate()`.
//   httpApi/helpers.ts        wire helpers (readJson/send/clientIp/str/numOpt) + authenticate/requireCap + RouteDeps/BaseCtx/RouteCtx types
//   httpApi/session.ts        preAuth (health/OPTIONS/internal flags+shop-prices+wordlists) + login + logout/me
//   httpApi/monitorRoutes.ts  monitor live/trend, analytics summary/events, PvP card win-rate report
//   httpApi/playerRoutes.ts   player search/detail/password-reset, manual ban/unban (S4-4)
//   httpApi/trustSafetyRoutes.ts anticheat review queue, UGC report queue, player appeal queue, feedback (read-only)
//   httpApi/compRoutes.ts     compensation ticket create/list/preview/approve/reject/cancel/retry
//   httpApi/opsConfigRoutes.ts audit log, feature flags, SLG shop price overrides, moderation wordlist overlays
//   httpApi/accountRoutes.ts  admin account management (superadmin)
//   httpApi/slgRoutes.ts      ladder season ops + SLG season/audit/map-template ops (worldsvc proxy, G7/§17.7/§24)
//   httpApi/commerceRoutes.ts Paddle webhook event log, limited-time events, custom gacha pools
import { createServer, type Server } from 'http';
import { createLogger, type InternalAuthVerifier, type JwtConfig } from '@nw/shared';
import { AdminError, type AdminService } from './service';
import { EventsClientError } from './clients';
import { send, authenticate, type BaseCtx, type RouteCtx } from './httpApi/helpers';
import { handlePreAuth, handleLogin, handleSession } from './httpApi/session';
import { handleMonitorRoutes } from './httpApi/monitorRoutes';
import { handlePlayerRoutes } from './httpApi/playerRoutes';
import { handleTrustSafetyRoutes } from './httpApi/trustSafetyRoutes';
import { handleCompRoutes } from './httpApi/compRoutes';
import { handleOpsConfigRoutes } from './httpApi/opsConfigRoutes';
import { handleAccountRoutes } from './httpApi/accountRoutes';
import { handleSlgRoutes } from './httpApi/slgRoutes';
import { handleCommerceRoutes } from './httpApi/commerceRoutes';

const log = createLogger('admin:http');

export interface HttpApiOpts {
  host: string;
  port: number;
  jwt: JwtConfig; // admin-specific secret + ttl
  /** Internal service authentication (X-Internal-Key): database-less backends poll GET /admin/internal/flags to fetch raw flag rules. */
  internalAuth: InternalAuthVerifier;
}

export function startHttpApi(opts: HttpApiOpts, svc: AdminService): Server {
  const { jwt, internalAuth } = opts;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'admin'}`);
      const base: BaseCtx = { req, res, method: req.method ?? 'GET', path: url.pathname, url, svc, jwt, internalAuth };

      // CORS preflight / health / internal (X-Internal-Key) endpoints — all reachable with zero admin JWT.
      if (await handlePreAuth(base)) return;

      try {
        // Login (no session required — this is what creates one).
        if (await handleLogin(base)) return;

        // All other endpoints require a session.
        const actor = await authenticate(req, jwt, svc);
        const ctx: RouteCtx = { ...base, actor };

        if (await handleSession(ctx)) return;
        if (await handleMonitorRoutes(ctx)) return;
        if (await handlePlayerRoutes(ctx)) return;
        if (await handleTrustSafetyRoutes(ctx)) return;
        if (await handleCompRoutes(ctx)) return;
        if (await handleOpsConfigRoutes(ctx)) return;
        if (await handleAccountRoutes(ctx)) return;
        if (await handleSlgRoutes(ctx)) return;
        if (await handleCommerceRoutes(ctx)) return;

        send(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        if (e instanceof AdminError) {
          send(res, e.status, { ok: false, code: e.code, error: e.message });
        } else if (e instanceof EventsClientError) {
          // meta-side validation / conflict / not found → pass through status code and reason (detail for operator visibility).
          send(res, e.status >= 400 && e.status < 600 ? e.status : 502, { ok: false, error: e.message });
        } else {
          log.error('unhandled error', { url: req.url, err: (e as Error).message });
          send(res, 500, { ok: false, error: 'internal error' });
        }
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
