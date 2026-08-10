// socialsvc public REST (SOCIAL_SVC_DESIGN §4). Fifth public face: /social/*.
// Auth: reuses meta JWT — verifyToken only, extracts accountId (no connection to the accounts DB).
// Internal endpoints: /internal/*, authenticated via X-Internal-Key (called by other services).
// Uses node:http (same style as worldsvc). Responses wrapped in @nw/shared ApiResp envelope.
//
// startHttpApi was a single ~708-line function (one big if-chain over node:http request/response, not a
// framework router) — 2026-08-10 split into a thin dispatcher + one file per route domain under
// ./httpApi/, same "chain of responsibility" shape worldsvc/httpApi.ts and admin/httpApi.ts already use:
// each domain handler takes the shared context and returns `true` once it has matched a route and sent a
// response, `false` to let the next handler try. No two domain files match the same method+path, so route
// resolution is unchanged. Two tiers of context mirror the two auth mechanisms: `BaseCtx` (no accountId)
// for the four /internal/* domains — X-Internal-Key is checked ONCE by the shell before any of them run,
// same as the original single `if (!internalAuth.verify(...).ok)` guard — and `RouteCtx` (BaseCtx +
// accountId) for the five public /social/* domains, built only after JWT verification succeeds.
//   httpApi/helpers.ts             wire helpers (readJson/send/sendErr/sendSocialErr/numQ) + RouteDeps/BaseCtx/RouteCtx types
//   httpApi/internalFamilyRoutes.ts   /internal/family/* (by-account, member, batch, by-sect, sect, prosperity/refresh, activity(-and-prosperity), slg-reset)
//   httpApi/internalMailRoutes.ts     /internal/mail/* (atomic claim/unclaim, system mail single + bulk)
//   httpApi/internalPushRoutes.ts     /internal/push (generic delegated push) + /internal/presence/{online,offline} (friend presence fan-out)
//   httpApi/internalReportsRoutes.ts  /internal/reports (UGC review queue list + resolve)
//   httpApi/familyRoutes.ts        /social/family/* (create/search/browse/join/leave/kick/role/disband/announcement/channel)
//   httpApi/profileRoutes.ts       /social/profile/:publicId/extra (unified profile-popup rank/family/sect extras)
//   httpApi/friendRoutes.ts        /social/friends/* + /social/badges (P2)
//   httpApi/chatRoutes.ts          /social/chat/* direct messages (P2)
//   httpApi/mailRoutes.ts          /social/mail/* player mail (P2)
import { createServer, type Server } from 'http';
import { ErrorCode, extractBearer, verifyToken, loadInternalAuth, SlgError } from '@nw/shared';
import type { FamilyService } from './familyService';
import type { FriendService } from './friendService';
import type { MailService } from './mailService';
import type { SocialMetaClient } from './metaClient';
import type { SocialGatewayClient } from './gatewayClient';
import { send, sendErr, type BaseCtx, type RouteCtx } from './httpApi/helpers';
import { handleInternalFamilyRoutes } from './httpApi/internalFamilyRoutes';
import { handleInternalMailRoutes } from './httpApi/internalMailRoutes';
import { handleInternalPushRoutes } from './httpApi/internalPushRoutes';
import { handleInternalReportsRoutes } from './httpApi/internalReportsRoutes';
import { handleFamilyRoutes } from './httpApi/familyRoutes';
import { handleProfileRoutes } from './httpApi/profileRoutes';
import { handleFriendRoutes } from './httpApi/friendRoutes';
import { handleChatRoutes } from './httpApi/chatRoutes';
import { handleMailRoutes } from './httpApi/mailRoutes';

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalKey: string },
  familySvc: FamilyService,
  friendSvc: FriendService,
  mailSvc: MailService,
  gateway: SocialGatewayClient,
  meta: SocialMetaClient,
): Server {
  const internalAuth = loadInternalAuth(opts.internalKey);

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';

      if (method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'socialsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'social'}`);
      const path = url.pathname;
      const q = url.searchParams;
      const base: BaseCtx = { req, res, method, path, url, q, familySvc, friendSvc, mailSvc, gateway, meta };

      // ── Internal endpoints (/internal/*) ─────────────────────────────
      if (path.startsWith('/internal/')) {
        if (!internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
        }
        if (await handleInternalFamilyRoutes(base)) return;
        if (await handleInternalMailRoutes(base)) return;
        if (await handleInternalPushRoutes(base)) return;
        if (await handleInternalReportsRoutes(base)) return;
        return sendErr(res, ErrorCode.NOT_FOUND, 'internal endpoint not found');
      }

      // ── Public endpoints (/social/*) ─────────────────────────────────
      // JWT authentication
      const token = extractBearer(req.headers['authorization']);
      if (!token) return sendErr(res, ErrorCode.UNAUTHENTICATED, 'missing Authorization header');
      let accountId: string;
      try {
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, 'invalid token');
      }

      const ctx: RouteCtx = { ...base, accountId };

      try {
        if (await handleFamilyRoutes(ctx)) return;
        if (await handleProfileRoutes(ctx)) return;
        if (await handleFriendRoutes(ctx)) return;
        if (await handleChatRoutes(ctx)) return;
        if (await handleMailRoutes(ctx)) return;

        return sendErr(res, ErrorCode.NOT_FOUND, 'endpoint not found');
      } catch (e) {
        if (e instanceof SlgError) {
          return sendErr(res, e.code as ErrorCode, e.message);
        }
        console.error('[socialsvc] unhandled error:', e);
        return sendErr(res, ErrorCode.INTERNAL, 'internal server error');
      }
    })();
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`socialsvc listening on ${opts.host}:${opts.port}`);
  });

  return server;
}
