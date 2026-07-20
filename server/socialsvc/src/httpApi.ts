// socialsvc public REST (SOCIAL_SVC_DESIGN §4). Fifth public face: /social/*.
// Auth: reuses meta JWT — verifyToken only, extracts accountId (no connection to the accounts DB).
// Internal endpoints: /internal/*, authenticated via X-Internal-Key (called by other services).
// Uses node:http (same style as worldsvc). Responses wrapped in @nw/shared ApiResp envelope.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import {
  ErrorCode,
  ERROR_HTTP_STATUS,
  ok,
  err,
  extractBearer,
  verifyToken,
  loadInternalAuth,
  SlgError,
} from '@nw/shared';
import type { FamilyService } from './familyService';
import type { FriendService } from './friendService';
import type { MailService } from './mailService';
import type { SocialMetaClient } from './metaClient';
import type { SocialGatewayClient, SocialPushMsg } from './gatewayClient';
import { CHAT_SEND_RATE_PER_MIN, type ChatRegion } from '@nw/shared';

/**
 * Fan-out of friend online/offline notifications (P3, SOCIAL_SVC_DESIGN §5 Presence push chain).
 * Online: push "I came online" to online friends + push each online friend's status back to me.
 * Offline: only push "I went offline" to online friends (I am already disconnected, no need to push back to me).
 * All best-effort: failures do not affect the main flow.
 */
async function presenceFanOut(
  accountId: string,
  online: boolean,
  _familySvc: FamilyService,
  friendSvc: FriendService,
  gateway: SocialGatewayClient,
): Promise<void> {
  if (!gateway.available) return;
  const friendIds = await friendSvc.getFriendAccountIds(accountId);
  if (friendIds.length === 0) return;

  const myProfiles = await friendSvc.batchPublicIds([accountId]);
  const myPublicId = myProfiles.get(accountId);
  if (!myPublicId) return; // account has no publicId, skip broadcast

  const presenceMap = await gateway.presence(friendIds);
  const onlineFriendIds = friendIds.filter((id) => presenceMap[id]);
  if (onlineFriendIds.length === 0 && !online) return;

  // Push to online friends: I came online / went offline
  if (onlineFriendIds.length > 0) {
    await gateway.pushMany(onlineFriendIds, { kind: 'friend_presence', publicId: myPublicId, online });
  }

  // On coming online: push each online friend's status back to me (so I know who is online)
  if (online && onlineFriendIds.length > 0) {
    const friendPids = await friendSvc.batchPublicIds(onlineFriendIds);
    await Promise.allSettled(
      onlineFriendIds.map((fid) => {
        const pid = friendPids.get(fid);
        if (!pid) return Promise.resolve();
        return gateway.push(accountId, { kind: 'friend_presence', publicId: pid, online: true });
      }),
    );
  }
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
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

type SocialError = 'NOT_FOUND' | 'BAD_REQUEST' | 'ALREADY_FRIEND' | 'FRIEND_CAP_REACHED' | 'NOT_FRIEND' | 'BLOCKED';
function sendSocialErr(res: ServerResponse, e: SocialError): void {
  switch (e) {
    case 'NOT_FOUND': return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
    case 'ALREADY_FRIEND': return sendErr(res, ErrorCode.ALREADY_FRIEND, 'already friends');
    case 'FRIEND_CAP_REACHED': return sendErr(res, ErrorCode.FRIEND_CAP_REACHED, 'friend cap reached');
    case 'NOT_FRIEND': return sendErr(res, ErrorCode.NOT_FRIEND, 'not friends');
    case 'BLOCKED': return sendErr(res, ErrorCode.BLOCKED, 'blocked');
    default: return sendErr(res, ErrorCode.BAD_REQUEST, 'bad request');
  }
}

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

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

      // ── Internal endpoints (/internal/*) ─────────────────────────────
      if (path.startsWith('/internal/')) {
        if (!internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
        }

        // Look up the familyId the player belongs to (called by worldsvc, SS7)
        {
          const m = /^\/internal\/family\/by-account\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            const accountId = decodeURIComponent(m[1]!);
            const familyId = await familySvc.getFamilyIdByAccount(accountId);
            return send(res, 200, ok({ familyId }));
          }
        }

        // Delegated push (called by worldsvc / metaserver, §4.2 /internal/push)
        if (method === 'POST' && path === '/internal/push') {
          const body = await readJson(req);
          const channel = body.channel as { kind: string; familyId?: string; sectId?: string; worldId?: string; accountId?: string } | undefined;
          const event = typeof body.event === 'string' ? body.event : '';
          const payload = body.payload;
          // targets: recipient list pre-computed by the caller (P1 interim fallback before sect/world channel Redis pub/sub is implemented in P3).
          const targets = Array.isArray(body.targets) ? (body.targets as string[]) : null;
          if (!channel || !event) return sendErr(res, ErrorCode.BAD_REQUEST, 'channel + event required');

          const msg: SocialPushMsg = {
            kind: event as SocialPushMsg['kind'],
            ...(payload as object),
          } as SocialPushMsg;

          if (targets && targets.length > 0) {
            // Caller provided an explicit recipient list (sect/world channel P1 fallback).
            await gateway.pushMany(targets, msg);
          } else if (channel.kind === 'account' && channel.accountId) {
            await gateway.push(channel.accountId, msg);
          } else if (channel.kind === 'family' && channel.familyId) {
            // Push to all online family members (O(n), ≤30 members)
            const detail = await familySvc.getFamily(channel.familyId);
            if (detail) {
              await gateway.pushMany(detail.members.map((m) => m.accountId), msg);
            }
          }
          // sect/world channel with no targets: P3 will switch to Redis pub/sub routing (currently only persisted to DB, no real-time push).
          return send(res, 200, ok({}));
        }

        // P2: atomic mail claim (called by metaserver: marks as claimed and returns the attachment list; metaserver then delivers goods)
        {
          const m = /^\/internal\/mail\/([^/]+)\/claim$/.exec(path);
          if (method === 'POST' && m) {
            const mailId = decodeURIComponent(m[1]!);
            const body = await readJson(req);
            const accountId = typeof body.accountId === 'string' ? body.accountId : null;
            const orderId = typeof body.orderId === 'string' ? body.orderId : null;
            if (!accountId || !orderId) return sendErr(res, ErrorCode.BAD_REQUEST, 'accountId + orderId required');
            const result = await mailSvc.claimMailAtomic(accountId, mailId, orderId);
            if ('error' in result) {
              const code = result.error === 'NOT_FOUND' ? ErrorCode.NOT_FOUND
                : result.error === 'ALREADY_CLAIMED' ? ErrorCode.ALREADY_CLAIMED
                : ErrorCode.NO_ATTACHMENT;
              return sendErr(res, code, result.error);
            }
            return send(res, 200, ok({ doc: result.doc }));
          }
        }

        // P2: send a single system mail (called by metaserver admin / season settlement)
        if (method === 'POST' && path === '/internal/mail/system') {
          const body = await readJson(req);
          const { dispatchKey, to, content } = body as {
            dispatchKey: string;
            to: string;
            content: { subject: string; body: string; expireDays: number };
          };
          if (!dispatchKey || !to || !content?.subject) return sendErr(res, ErrorCode.BAD_REQUEST, 'dispatchKey + to + content required');
          const r = await mailSvc.insertSystemMail(dispatchKey, to, content);
          return send(res, 200, ok(r));
        }

        // P2: bulk system mail fan-out (called by metaserver admin / season settlement)
        if (method === 'POST' && path === '/internal/mail/system/bulk') {
          const body = await readJson(req);
          const { dispatchKey, accountIds, content } = body as {
            dispatchKey: string;
            accountIds: string[];
            content: { subject: string; body: string; expireDays: number };
          };
          if (!dispatchKey || !Array.isArray(accountIds) || !content?.subject) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'dispatchKey + accountIds + content required');
          }
          const r = await mailSvc.bulkInsertSystemMail(dispatchKey, accountIds, content);
          // Push a notification badge to newly inserted recipients
          if (r.insertedAccountIds.length > 0) {
            for (const aid of r.insertedAccountIds) {
              // best-effort, does not affect the current response
              void gateway.push(aid, { kind: 'mail_new', mailId: `${dispatchKey}:${aid}`, hasAttachment: r.hasAttachment });
            }
          }
          return send(res, 200, ok(r));
        }

        // Accumulate activity score (called by worldsvc on capture/battle, SS7)
        if (method === 'POST' && path === '/internal/family/activity') {
          const body = await readJson(req);
          const familyId = typeof body.familyId === 'string' ? body.familyId : null;
          const delta = typeof body.delta === 'number' ? body.delta : 1;
          if (!familyId) return sendErr(res, ErrorCode.BAD_REQUEST, 'familyId required');
          await familySvc.bumpActivity(familyId, delta);
          return send(res, 200, ok({}));
        }

        // Membership + family identity in one round trip (called by worldsvc sect permission checks)
        {
          const m = /^\/internal\/family\/member\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            const accountId = decodeURIComponent(m[1]!);
            const member = await familySvc.getMember(accountId);
            return send(res, 200, ok({ member }));
          }
        }

        // Batch fetch families by id (called by worldsvc for sect roster display / season settlement)
        if (method === 'POST' && path === '/internal/family/batch') {
          const body = await readJson(req);
          const familyIds = Array.isArray(body.familyIds) ? (body.familyIds as string[]) : [];
          return send(res, 200, ok({ families: await familySvc.getFamiliesByIds(familyIds) }));
        }

        // All families currently in a given sect (called by worldsvc sect roster / vote / penalty fan-out)
        {
          const m = /^\/internal\/family\/by-sect\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            const sectId = decodeURIComponent(m[1]!);
            return send(res, 200, ok({ families: await familySvc.getFamiliesBySect(sectId) }));
          }
        }

        // Set/clear the sect a family belongs to (worldsvc is authoritative; this is a read cache for clients, SLG_DESIGN §8.2)
        {
          const m = /^\/internal\/family\/([^/]+)\/sect$/.exec(path);
          if (method === 'POST' && m) {
            const familyId = decodeURIComponent(m[1]!);
            const body = await readJson(req);
            const sectId = typeof body.sectId === 'string' ? body.sectId : null;
            const sectName = typeof body.sectName === 'string' ? body.sectName : null;
            await familySvc.setSect(familyId, sectId, sectName);
            return send(res, 200, ok({}));
          }
        }

        // Recompute + persist prosperity from a worldsvc-supplied territoryCount (worldsvc owns tile ownership)
        {
          const m = /^\/internal\/family\/([^/]+)\/prosperity\/refresh$/.exec(path);
          if (method === 'POST' && m) {
            const familyId = decodeURIComponent(m[1]!);
            const body = await readJson(req);
            const territoryCount = typeof body.territoryCount === 'number' ? body.territoryCount : 0;
            const prosperity = await familySvc.refreshProsperity(familyId, territoryCount);
            return send(res, 200, ok({ prosperity }));
          }
        }

        // Zero SLG season state on world reset (called by worldsvc's resetSeason, SLG_DESIGN §17.3)
        {
          const m = /^\/internal\/family\/([^/]+)\/slg-reset$/.exec(path);
          if (method === 'POST' && m) {
            const familyId = decodeURIComponent(m[1]!);
            await familySvc.resetSlgState(familyId);
            return send(res, 200, ok({}));
          }
        }

        // Presence event (called by gateway, P3): fan-out of friend online/offline notifications
        if (method === 'POST' && (path === '/internal/presence/online' || path === '/internal/presence/offline')) {
          const body = await readJson(req);
          const presenceAccountId = typeof body.accountId === 'string' ? body.accountId : null;
          if (!presenceAccountId) return sendErr(res, ErrorCode.BAD_REQUEST, 'accountId required');
          const isOnline = path.endsWith('/online');
          void presenceFanOut(presenceAccountId, isOnline, familySvc, friendSvc, gateway).catch(() => { /* best-effort */ });
          return send(res, 200, ok({}));
        }

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

      try {
        // ── Family ────────────────────────────────────────────────────
        if (method === 'GET' && path === '/social/family/mine') {
          return send(res, 200, ok(await familySvc.getMyFamily(accountId)));
        }

        if (method === 'GET' && path === '/social/family/search') {
          const tag = q.get('tag');
          if (!tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'tag required');
          return send(res, 200, ok(await familySvc.searchByTag(tag)));
        }

        if (method === 'GET' && path === '/social/family/browse') {
          const query = q.get('q') ?? undefined;
          const limitRaw = q.get('limit');
          const limit = limitRaw ? Number(limitRaw) : 10;
          return send(res, 200, ok(await familySvc.browseFamilies(query, limit)));
        }

        if (method === 'POST' && path === '/social/family') {
          const body = await readJson(req);
          const name = typeof body.name === 'string' ? body.name : null;
          const tag = typeof body.tag === 'string' ? body.tag : null;
          if (!name || !tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'name + tag required');
          return send(res, 201, ok(await familySvc.createFamily(accountId, name, tag)));
        }

        // Must be checked before the generic GET /social/family/:id route below, since "requests"
        // would otherwise be captured as a familyId by that route's [^/]+ pattern.
        if (method === 'GET' && path === '/social/family/requests') {
          return send(res, 200, ok({ requests: await familySvc.listJoinRequests(accountId) }));
        }

        {
          const m = /^\/social\/family\/requests\/([^/]+)\/respond$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const accept = body.accept === true;
            await familySvc.respondJoinRequest(accountId, decodeURIComponent(m[1]!), accept);
            return send(res, 200, ok({}));
          }
        }

        {
          const m = /^\/social\/family\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            return send(res, 200, ok(await familySvc.getFamily(decodeURIComponent(m[1]!))));
          }
        }

        {
          const m = /^\/social\/family\/([^/]+)\/join$/.exec(path);
          if (method === 'POST' && m) {
            return send(res, 200, ok(await familySvc.requestJoin(accountId, decodeURIComponent(m[1]!))));
          }
        }

        if (method === 'POST' && path === '/social/family/leave') {
          await familySvc.leaveFamily(accountId);
          return send(res, 200, ok({}));
        }

        if (method === 'POST' && path === '/social/family/kick') {
          const body = await readJson(req);
          const targetId = typeof body.targetId === 'string' ? body.targetId : null;
          if (!targetId) return sendErr(res, ErrorCode.BAD_REQUEST, 'targetId required');
          await familySvc.kickMember(accountId, targetId);
          return send(res, 200, ok({}));
        }

        if (method === 'POST' && path === '/social/family/role') {
          const body = await readJson(req);
          const targetId = typeof body.targetId === 'string' ? body.targetId : null;
          const role = typeof body.role === 'string' ? body.role : null;
          if (!targetId || !role) return sendErr(res, ErrorCode.BAD_REQUEST, 'targetId + role required');
          await familySvc.setRole(accountId, targetId, role as import('@nw/shared').FamilyRole);
          return send(res, 200, ok({}));
        }

        if (method === 'POST' && path === '/social/family/disband') {
          await familySvc.dissolveFamily(accountId);
          return send(res, 200, ok({}));
        }

        if (method === 'POST' && path === '/social/family/announcement') {
          const body = await readJson(req);
          const announcement = typeof body.announcement === 'string' ? body.announcement : null;
          if (announcement == null) return sendErr(res, ErrorCode.BAD_REQUEST, 'announcement required');
          await familySvc.setAnnouncement(accountId, announcement);
          return send(res, 200, ok({}));
        }

        {
          const m = /^\/social\/family\/([^/]+)\/messages$/.exec(path);
          if (m) {
            const familyId = decodeURIComponent(m[1]!);
            if (method === 'GET') {
              // Fetch channel history: caller must be a member of the family (validated internally by familyService.getChannel)
              const before = q.get('before') ? Number(q.get('before')) : undefined;
              const limit = numQ(q.get('limit'), 30);
              return send(res, 200, ok(await familySvc.getChannel(accountId, before, limit)));
            }
            if (method === 'POST') {
              const body = await readJson(req);
              const msgBody = typeof body.body === 'string' ? body.body : null;
              const senderName = typeof body.senderName === 'string' ? body.senderName : accountId;
              if (!msgBody) return sendErr(res, ErrorCode.BAD_REQUEST, 'body required');
              return send(res, 200, ok(await familySvc.sendMessage(accountId, senderName, msgBody)));
            }
            void familyId; // suppress unused var
          }
        }

        // Ladder rank + ELO for an arbitrary player (unified profile popup — family roster / world chat
        // sender / friends list all open the same popup and want the same "rank" line self-profile already had).
        {
          const m = /^\/social\/player\/([^/]+)\/rank$/.exec(path);
          if (method === 'GET' && m) {
            const targetId = decodeURIComponent(m[1]!);
            const rank = await meta.getPlayerRank(targetId);
            return send(res, 200, ok(rank ?? {}));
          }
        }

        // ── Friends (P2) ──────────────────────────────────────────────────
        if (method === 'GET' && path === '/social/friends') {
          return send(res, 200, ok({ friends: await friendSvc.getFriends(accountId) }));
        }
        if (method === 'GET' && path === '/social/friends/requests') {
          return send(res, 200, ok(await friendSvc.listRequests(accountId)));
        }
        if (method === 'GET' && path === '/social/badges') {
          return send(res, 200, ok(await friendSvc.getSocialBadges(accountId)));
        }
        if (method === 'POST' && path === '/social/friends/search') {
          const body = await readJson(req);
          const publicId = typeof body.publicId === 'string' ? body.publicId : null;
          if (!publicId) return sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required');
          const found = await friendSvc.searchFriend(publicId);
          if (!found) return sendErr(res, ErrorCode.NOT_FOUND, 'player not found');
          return send(res, 200, ok(found));
        }
        if (method === 'POST' && path === '/social/friends/request') {
          const body = await readJson(req);
          const publicId = typeof body.publicId === 'string' ? body.publicId : null;
          const message = typeof body.message === 'string' ? body.message : undefined;
          if (!publicId) return sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required');
          const r2 = await friendSvc.requestFriend(accountId, publicId, message);
          if (r2.kind === 'error') return sendSocialErr(res, r2.error);
          return send(res, 200, ok({ requestId: r2.requestId }));
        }
        if (method === 'POST' && path === '/social/friends/respond') {
          const body = await readJson(req);
          const requestId = typeof body.requestId === 'string' ? body.requestId : null;
          const accept = typeof body.accept === 'boolean' ? body.accept : null;
          if (!requestId || accept === null) return sendErr(res, ErrorCode.BAD_REQUEST, 'requestId + accept required');
          const r2 = await friendSvc.respondFriend(accountId, requestId, accept);
          if (r2.kind === 'error') return sendSocialErr(res, r2.error);
          return send(res, 200, ok({ ok: true }));
        }
        {
          const m = /^\/social\/friends\/([^/]+)$/.exec(path);
          if (method === 'DELETE' && m) {
            await friendSvc.removeFriend(accountId, decodeURIComponent(m[1]!));
            return send(res, 200, ok({ ok: true }));
          }
        }
        if (method === 'POST' && path === '/social/friends/block') {
          const body = await readJson(req);
          const publicId = typeof body.publicId === 'string' ? body.publicId : null;
          if (!publicId) return sendErr(res, ErrorCode.BAD_REQUEST, 'publicId required');
          const ok2 = await friendSvc.blockUser(accountId, publicId);
          if (!ok2) return sendErr(res, ErrorCode.NOT_FOUND, 'player not found');
          return send(res, 200, ok({ ok: true }));
        }
        {
          const m = /^\/social\/friends\/block\/([^/]+)$/.exec(path);
          if (method === 'DELETE' && m) {
            await friendSvc.unblockUser(accountId, decodeURIComponent(m[1]!));
            return send(res, 200, ok({ ok: true }));
          }
        }

        // ── Direct messages (P2) ──────────────────────────────────────────
        if (method === 'GET' && path === '/social/chat/conversations') {
          return send(res, 200, ok({ conversations: await friendSvc.getConversations(accountId) }));
        }
        {
          const m = /^\/social\/chat\/([^/]+)\/messages$/.exec(path);
          if (method === 'GET' && m) {
            const convId = decodeURIComponent(m[1]!);
            const before = q.get('before') ? Number(q.get('before')) : undefined;
            const limit = numQ(q.get('limit'), 30);
            const messages = await friendSvc.getMessages(accountId, convId, before, limit);
            if (messages === null) return sendErr(res, ErrorCode.NOT_FOUND, 'conversation not found');
            return send(res, 200, ok({ messages }));
          }
        }
        if (method === 'POST' && path === '/social/chat/send') {
          const body = await readJson(req);
          const toPublicId = typeof body.toPublicId === 'string' ? body.toPublicId : null;
          const msgBody = typeof body.body === 'string' ? body.body : null;
          if (!toPublicId || !msgBody) return sendErr(res, ErrorCode.BAD_REQUEST, 'toPublicId + body required');
          if (!friendSvc.allowChat(accountId, Date.now(), CHAT_SEND_RATE_PER_MIN)) {
            return sendErr(res, ErrorCode.RATE_LIMITED, 'too many messages');
          }
          const region = (req.headers['x-chat-region'] as ChatRegion | undefined) ?? 'global';
          const r = await friendSvc.sendMessage(accountId, toPublicId, msgBody, region);
          if (r.kind === 'error') return sendSocialErr(res, r.error);
          return send(res, 200, ok({ messageId: r.messageId, ts: r.ts }));
        }
        if (method === 'POST' && path === '/social/chat/read') {
          const body = await readJson(req);
          const convId = typeof body.convId === 'string' ? body.convId : null;
          if (!convId) return sendErr(res, ErrorCode.BAD_REQUEST, 'convId required');
          await friendSvc.markConversationRead(accountId, convId);
          return send(res, 200, ok({ ok: true }));
        }

        // ── Mail (P2) ────────────────────────────────────────────────────
        if (method === 'GET' && path === '/social/mail') {
          return send(res, 200, ok(await mailSvc.getMail(accountId)));
        }
        {
          const m = /^\/social\/mail\/([^/]+)\/read$/.exec(path);
          if (method === 'POST' && m) {
            const mailId = decodeURIComponent(m[1]!);
            const ok2 = await mailSvc.readMail(accountId, mailId);
            if (!ok2) return sendErr(res, ErrorCode.NOT_FOUND, 'mail not found');
            return send(res, 200, ok({ ok: true }));
          }
        }
        {
          const m = /^\/social\/mail\/([^/]+)$/.exec(path);
          if (method === 'DELETE' && m) {
            const r = await mailSvc.deleteMail(accountId, decodeURIComponent(m[1]!));
            if ('error' in r) {
              return sendErr(res, ErrorCode.MAIL_HAS_UNCLAIMED_ATTACHMENT, 'mail has an unclaimed attachment; claim it before deleting');
            }
            return send(res, 200, ok({ ok: true }));
          }
        }
        if (method === 'POST' && path === '/social/mail/send') {
          const body = await readJson(req);
          const toPublicId = typeof body.toPublicId === 'string' ? body.toPublicId : null;
          const subject = typeof body.subject === 'string' ? body.subject : null;
          const mailBody = typeof body.body === 'string' ? body.body : '';
          if (!toPublicId || !subject) return sendErr(res, ErrorCode.BAD_REQUEST, 'toPublicId + subject required');
          const r = await mailSvc.sendPlayerMail(accountId, toPublicId, subject, mailBody);
          if (r.kind === 'error') {
            if (r.error === 'NOT_FRIEND') return sendErr(res, ErrorCode.NOT_FRIEND, 'not friends');
            if (r.error === 'NOT_FOUND') return sendErr(res, ErrorCode.NOT_FOUND, 'player not found');
            return sendErr(res, ErrorCode.BAD_REQUEST, 'bad request');
          }
          return send(res, 200, ok({ mailId: r.mailId }));
        }

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
