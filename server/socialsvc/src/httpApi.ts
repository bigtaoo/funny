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
import type { SocialGatewayClient, SocialPushMsg } from './gatewayClient';

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

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalKey: string },
  familySvc: FamilyService,
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
          if (!channel || !event) return sendErr(res, ErrorCode.BAD_REQUEST, 'channel + event required');

          const msg: SocialPushMsg = {
            kind: event as SocialPushMsg['kind'],
            ...(payload as object),
          } as SocialPushMsg;

          if (channel.kind === 'account' && channel.accountId) {
            await gateway.push(channel.accountId, msg);
          } else if (channel.kind === 'family' && channel.familyId) {
            // 推给所有家族在线成员（O(n)，≤30 人）
            const detail = await familySvc.getFamily(channel.familyId);
            if (detail) {
              await gateway.pushMany(detail.members.map((m) => m.accountId), msg);
            }
          }
          return send(res, 200, ok({}));
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
