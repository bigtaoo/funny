// socialsvc 公网 REST（SOCIAL_SVC_DESIGN §4）。第五公网面：/social/*。
// 鉴权：复用 meta JWT，仅 verifyToken 验签取 accountId（不连 accounts 库）。
// 内部端点：/internal/*，X-Internal-Key 鉴权（其他服务调用）。
// 用 node:http（与 worldsvc 同风格）。响应走 @nw/shared ApiResp 包络。
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
import type { SocialGatewayClient, SocialPushMsg } from './gatewayClient';
import { CHAT_SEND_RATE_PER_MIN, type ChatRegion } from '@nw/shared';

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

      // ── 内部端点（/internal/*）────────────────────────────────────────
      if (path.startsWith('/internal/')) {
        if (!internalAuth.verify(req.headers).ok) {
          return sendErr(res, ErrorCode.UNAUTHENTICATED, '内部端点需 X-Internal-Key');
        }

        // 查玩家所在 familyId（worldsvc 调用，SS7）
        {
          const m = /^\/internal\/family\/by-account\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            const accountId = decodeURIComponent(m[1]!);
            const familyId = await familySvc.getFamilyIdByAccount(accountId);
            return send(res, 200, ok({ familyId }));
          }
        }

        // 委托推送（worldsvc / metaserver 调用，§4.2 /internal/push）
        if (method === 'POST' && path === '/internal/push') {
          const body = await readJson(req);
          const channel = body.channel as { kind: string; familyId?: string; sectId?: string; worldId?: string; accountId?: string } | undefined;
          const event = typeof body.event === 'string' ? body.event : '';
          const payload = body.payload;
          // targets：调用方已计算好的收件人列表（P1 过渡，sect/world 频道 Redis pub/sub P3 实现前的兜底）。
          const targets = Array.isArray(body.targets) ? (body.targets as string[]) : null;
          if (!channel || !event) return sendErr(res, ErrorCode.BAD_REQUEST, 'channel + event required');

          const msg: SocialPushMsg = {
            kind: event as SocialPushMsg['kind'],
            ...(payload as object),
          } as SocialPushMsg;

          if (targets && targets.length > 0) {
            // 调用方提供了明确收件人列表（sect/world 频道 P1 兜底）。
            await gateway.pushMany(targets, msg);
          } else if (channel.kind === 'account' && channel.accountId) {
            await gateway.push(channel.accountId, msg);
          } else if (channel.kind === 'family' && channel.familyId) {
            // 推给所有家族在线成员（O(n)，≤30 人）
            const detail = await familySvc.getFamily(channel.familyId);
            if (detail) {
              await gateway.pushMany(detail.members.map((m) => m.accountId), msg);
            }
          }
          // sect/world channel 无 targets 时：P3 将改用 Redis pub/sub 路由（当前仅落库，无实时推送）。
          return send(res, 200, ok({}));
        }

        // P2：邮件原子领取（metaserver 调用：标 claimed 取附件列表，metaserver 再发货）
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

        // P2：系统邮件单发（metaserver admin/赛季结算调用）
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

        // P2：系统邮件批量 fan-out（metaserver admin/赛季结算调用）
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
          // 对新插入的收件人 push 红点
          if (r.insertedAccountIds.length > 0) {
            for (const aid of r.insertedAccountIds) {
              // best-effort，不影响本次响应
              void gateway.push(aid, { kind: 'mail_new', mailId: `${dispatchKey}:${aid}`, hasAttachment: r.hasAttachment });
            }
          }
          return send(res, 200, ok(r));
        }

        // 活跃度累加（worldsvc 占领/战斗时调用，SS7）
        if (method === 'POST' && path === '/internal/family/activity') {
          const body = await readJson(req);
          const familyId = typeof body.familyId === 'string' ? body.familyId : null;
          const delta = typeof body.delta === 'number' ? body.delta : 1;
          if (!familyId) return sendErr(res, ErrorCode.BAD_REQUEST, 'familyId required');
          await familySvc.bumpActivity(familyId, delta);
          return send(res, 200, ok({}));
        }

        // Presence 事件（gateway 调用，P3）
        if (method === 'POST' && (path === '/internal/presence/online' || path === '/internal/presence/offline')) {
          // P3 期实现好友在线通知扇出；当前仅 200 OK 占位
          return send(res, 200, ok({}));
        }

        return sendErr(res, ErrorCode.NOT_FOUND, '内部端点不存在');
      }

      // ── 公网端点（/social/*）─────────────────────────────────────────
      // JWT 鉴权
      const token = extractBearer(req.headers['authorization']);
      if (!token) return sendErr(res, ErrorCode.UNAUTHENTICATED, '缺少 Authorization');
      let accountId: string;
      try {
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, '无效 token');
      }

      try {
        // ── 家族 ──────────────────────────────────────────────────────
        if (method === 'GET' && path === '/social/family/mine') {
          return send(res, 200, ok(await familySvc.getMyFamily(accountId)));
        }

        if (method === 'GET' && path === '/social/family/search') {
          const tag = q.get('tag');
          if (!tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'tag required');
          return send(res, 200, ok(await familySvc.searchByTag(tag)));
        }

        if (method === 'POST' && path === '/social/family') {
          const body = await readJson(req);
          const name = typeof body.name === 'string' ? body.name : null;
          const tag = typeof body.tag === 'string' ? body.tag : null;
          if (!name || !tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'name + tag required');
          return send(res, 201, ok(await familySvc.createFamily(accountId, name, tag)));
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
            await familySvc.joinFamily(accountId, decodeURIComponent(m[1]!));
            return send(res, 200, ok({}));
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
              // 查频道历史：需验证调用者在该家族（familyService.getChannel 内部校验）
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

        // ── 好友（P2）────────────────────────────────────────────────────
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

        // ── 私聊（P2）────────────────────────────────────────────────────
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

        // ── 邮件（P2）────────────────────────────────────────────────────
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
            await mailSvc.deleteMail(accountId, decodeURIComponent(m[1]!));
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

        return sendErr(res, ErrorCode.NOT_FOUND, '接口不存在');
      } catch (e) {
        if (e instanceof SlgError) {
          return sendErr(res, e.code as ErrorCode, e.message);
        }
        console.error('[socialsvc] unhandled error:', e);
        return sendErr(res, ErrorCode.INTERNAL, '服务器内部错误');
      }
    })();
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`socialsvc listening on ${opts.host}:${opts.port}`);
  });

  return server;
}
