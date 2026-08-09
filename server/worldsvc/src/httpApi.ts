// worldsvc public REST (S8-0, SLG_DESIGN §14.1 P1 / §14.6). Public-facing surface: /world/* (/family/* already migrated to socialsvc; /auction/* moved to auctionsvc, §9 task 6).
// Auth: reuses the meta JWT; only verifyToken is called to extract accountId (no accounts DB connection, P1).
// Uses node:http (worldsvc does not depend on fastify). Responses wrapped in @nw/shared ApiResp envelope; error codes → HTTP status via ERROR_HTTP_STATUS.
// S8-0: map/player-state implemented; march/defense/troops/family/season return NOT_IMPLEMENTED (S8-1~5).
//
// startHttpApi was a single ~843-line function (one big if-chain over node:http request/response,
// not a framework router) — 2026-08-09 split into a thin dispatcher + one file per route domain
// under ./httpApi/, "chain of responsibility" style: each domain handler takes the shared
// `RouteCtx` and returns `true` once it has matched a route and sent a response, `false` to let
// the next handler try. Handlers run in the SAME order the original if-chain tested them in, and
// no two domain files match the same method+path, so route resolution is unchanged. The one
// exception is the internal `/admin/world/*` branch (X-Internal-Key, no JWT) — it runs BEFORE
// JWT verification and always sends a response once its path prefix matches, so `admin.ts`
// exports a void handler rather than a chain link.
//   httpApi/helpers.ts     wire helpers (readJson/send/sendErr/numQ/sanitizeSenderNameFallback) + RouteDeps/RouteCtx types
//   httpApi/admin.ts       /admin/world/* (map-templates, list, patrol, allocate/open/settle/reset/close/merge) — C4/§17.7
//   httpApi/mapRoutes.ts   map/tile reads, march/occupations/stationed/territories lists
//   httpApi/seasonRoutes.ts season resolve/join/transfer, world join/enter
//   httpApi/actionRoutes.ts abandon/relocate/watchtower, structure build/demolish, march dispatch/recall/instant-return, team cancel/recall, sweep
//   httpApi/economyRoutes.ts defense, teams, troops distribute/recover/train/speedup, build upgrade/speedup, season info, shop
//   httpApi/siegeRoutes.ts  siege replay + recent sieges list
//   httpApi/sectRoutes.ts   sect create/join/leave/dissolve/ally/unally/vote/message/channel (S8-4b)
//   httpApi/nationRoutes.ts nation/world public channel + nation naming (B7/§6.4, S8-6.5)
import { createServer, type Server } from 'http';
import { ErrorCode, ok, err, extractBearer, verifyToken, loadInternalAuth, SlgError, createLogger } from '@nw/shared';
import type { WorldService } from './service';
import type { SectService } from './sectService';
import type { NationChannelService } from './nationChannelService';
import type { WorldSocialsvcClient } from './socialsvcClient';
import type { MapTemplateService } from './mapTemplateService';
import { send, sendErr, type RouteDeps, type RouteCtx } from './httpApi/helpers';
import { handleAdminRoutes } from './httpApi/admin';
import { handleMapRoutes } from './httpApi/mapRoutes';
import { handleSeasonRoutes } from './httpApi/seasonRoutes';
import { handleActionRoutes } from './httpApi/actionRoutes';
import { handleEconomyRoutes } from './httpApi/economyRoutes';
import { handleSiegeRoutes } from './httpApi/siegeRoutes';
import { handleSectRoutes } from './httpApi/sectRoutes';
import { handleNationRoutes } from './httpApi/nationRoutes';

const log = createLogger('worldsvc');

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalKey: string },
  svc: WorldService,
  sectSvc: SectService,
  nationChannelSvc: NationChannelService,
  socialsvc: WorldSocialsvcClient,
  mapTemplateSvc: MapTemplateService,
): Server {
  // Internal ops authentication (C4/§17.7): /admin/world/* uses X-Internal-Key, not player JWT.
  const internalAuth = loadInternalAuth(opts.internalKey);
  const deps: RouteDeps = { svc, sectSvc, nationChannelSvc, socialsvc, mapTemplateSvc };
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // Health probe (no auth required): used by docker healthcheck / CI readiness waits.
      if (method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'worldsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      // Public: active season number (§20.8). No auth required; lets the client resolve CURRENT_SEASON dynamically.
      // try/catch required here specifically because this route is reachable with zero credentials —
      // an uncaught rejection (e.g. a transient Mongo error) would otherwise crash the whole process
      // (unhandled rejections terminate the process on Node >=15).
      if (method === 'GET' && req.url?.split('?')[0] === '/world/active-season') {
        try {
          return send(res, 200, ok({ season: await svc.getActiveSeasonNo() }));
        } catch (e) {
          if (e instanceof SlgError) return sendErr(res, e.code, e.message);
          log.error('unhandled error (active-season)', { err: e instanceof Error ? e : String(e) });
          return send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
        }
      }

      // —— Internal ops branch (C4/§17.7): /admin/world/* uses X-Internal-Key, checked before JWT. ——
      // Any logged-in player could previously call /admin/world/reset to wipe an entire region (C4 security hole); now moved out of the JWT branch.
      {
        const aurl = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
        if (aurl.pathname.startsWith('/admin/world/')) {
          return handleAdminRoutes(req, res, method, aurl, internalAuth, deps);
        }
      }

      // —— JWT verification (P1: extract accountId only, no DB connection) ——
      const token = extractBearer(req.headers['authorization']);
      let accountId: string;
      try {
        if (!token) throw new Error('no bearer');
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, 'authentication required');
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
      const path = url.pathname;
      const q = url.searchParams;
      // X-NW-Platform (ADR-020, comm-audit-internal-2026-07-28 P0-7): which recharged-pool bucket a
      // spend should draw from — mirrors metaserver's clientPlatformOf. Threaded into every coin-sink
      // call below (speedup/build/sect/chat/relocate/shop) so worldsvc no longer defaults everyone to
      // the 'web' bucket regardless of platform.
      const clientPlatformHeader = req.headers['x-nw-platform'];
      const clientPlatform = typeof clientPlatformHeader === 'string' && clientPlatformHeader ? clientPlatformHeader : undefined;

      const ctx: RouteCtx = { req, res, method, path, q, accountId, clientPlatform, ...deps };

      try {
        if (await handleMapRoutes(ctx)) return;
        if (await handleSeasonRoutes(ctx)) return;
        if (await handleActionRoutes(ctx)) return;
        if (await handleEconomyRoutes(ctx)) return;
        if (await handleSiegeRoutes(ctx)) return;
        if (await handleSectRoutes(ctx)) return;
        if (await handleNationRoutes(ctx)) return;

        // Season management /admin/world/* has been moved out of the JWT branch to use X-Internal-Key (C4/§17.7, see internal branch above).

        return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
      } catch (e) {
        if (e instanceof SlgError) return sendErr(res, e.code, e.message);
        log.error('unhandled error', { err: e instanceof Error ? e : String(e) });
        send(res, 500, err(ErrorCode.INTERNAL, 'internal server error'));
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
