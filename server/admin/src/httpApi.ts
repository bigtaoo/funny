// admin 对运维前端的 HTTP API（OPS_DESIGN §4.2）。两层鉴权的第一层：admin JWT（运维用户）。
// 第二层 X-Internal-Key 是 admin 调业务服务时持有（在 clients.ts），与此处无关。
// 用 node:http（admin 不引 fastify）。每个端点后端强校验能力（前端隐藏按钮不算数 §6）。
// CORS：admin 仅内网，但前端是浏览器纯前端 → 放行（Bearer 头鉴权，非 cookie，无需 credentials）。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { signToken, verifyToken, createLogger, roleHasCapability, type AdminCapability, type InternalAuthVerifier, type JwtConfig } from '@nw/shared';
import { AdminError, type Actor, type AdminService } from './service';
import { EventsClientError } from './clients';
import type { CompTarget, EventInput } from '@nw/shared';

const log = createLogger('admin:http');

export interface HttpApiOpts {
  host: string;
  port: number;
  jwt: JwtConfig; // admin 专用 secret + ttl
  /** 内部服务鉴权（X-Internal-Key）：不连库后端轮询 GET /admin/internal/flags 拿原始规则。 */
  internalAuth: InternalAuthVerifier;
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
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  res.end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? undefined;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOpt = (v: string | null): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function startHttpApi(opts: HttpApiOpts, svc: AdminService): Server {
  const { jwt, internalAuth } = opts;

  /** 解出已认证主体；失败抛 AdminError(401)。 */
  const authenticate = async (req: IncomingMessage): Promise<Actor> => {
    const header = req.headers['authorization'];
    const m = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (!m) throw new AdminError(401, 'unauthorized', 'missing bearer token');
    let adminId: string;
    try {
      adminId = verifyToken(m[1]!, jwt);
    } catch {
      throw new AdminError(401, 'unauthorized', 'invalid token');
    }
    const doc = await svc.getAccount(adminId);
    if (!doc || doc.disabled) throw new AdminError(401, 'unauthorized', 'account disabled or gone');
    return { adminId: doc._id, username: doc.username, displayName: doc.displayName, role: doc.role };
  };

  const requireCap = (actor: Actor, cap: AdminCapability): void => {
    if (!roleHasCapability(actor.role, cap)) {
      throw new AdminError(403, 'forbidden', `missing capability: ${cap}`);
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      // CORS 预检。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
        });
        res.end();
        return;
      }
      // 存活探针（无鉴权）。
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'admin' });
        return;
      }
      // ── 内部端点：功能开关原始规则（X-Internal-Key，非 admin JWT；不连库后端轮询此处）──
      // 玩家 JWT 命不中 X-Internal-Key（结构性拒绝），且本端点只读原始规则、不求值——
      // 消费者拿规则在自己进程内按当前 user 上下文 evaluateFlag。
      if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/admin/internal/flags') {
        if (!internalAuth.verify(req.headers).ok) {
          log.warn('internal flags request rejected: bad X-Internal-Key', {
            caller: req.headers['x-internal-caller'],
          });
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        try {
          send(res, 200, { ok: true, flags: await svc.getInternalFlags() });
        } catch (e) {
          log.error('internal flags fetch failed', { err: (e as Error).message });
          send(res, 500, { ok: false, error: 'internal error' });
        }
        return;
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'admin'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      try {
        // ── 登录（无需会话）──
        if (method === 'POST' && path === '/admin/login') {
          const b = await readJson(req);
          const doc = await svc.authenticate(str(b.username), str(b.password), clientIp(req));
          const token = signToken(doc._id, jwt);
          const { admin, capabilities } = svc.meView(doc);
          return send(res, 200, { ok: true, token, admin, capabilities });
        }

        // 其余全部需会话。
        const actor = await authenticate(req);

        if (method === 'POST' && path === '/admin/logout') {
          await svc.audit(actor.adminId, 'logout', { ip: clientIp(req) });
          return send(res, 200, { ok: true });
        }
        if (method === 'GET' && path === '/admin/me') {
          const doc = await svc.getAccount(actor.adminId);
          if (!doc) throw new AdminError(401, 'unauthorized', 'gone');
          return send(res, 200, { ok: true, ...svc.meView(doc) });
        }

        // ── 监控 ──
        if (method === 'GET' && path === '/admin/monitor/live') {
          requireCap(actor, 'monitor.view');
          return send(res, 200, { ok: true, ...(await svc.liveStats()) });
        }
        if (method === 'GET' && path === '/admin/monitor/trend') {
          requireCap(actor, 'monitor.view');
          const points = await svc.trend({
            metric: url.searchParams.get('metric') ?? '',
            from: numOpt(url.searchParams.get('from')),
            to: numOpt(url.searchParams.get('to')),
          });
          return send(res, 200, { ok: true, points });
        }

        // ── 数据分析 ──
        if (method === 'GET' && path === '/admin/analytics/summary') {
          requireCap(actor, 'analytics.view');
          return send(res, 200, { ok: true, ...(await svc.analyticsSummary()) });
        }
        if (method === 'GET' && path === '/admin/analytics/events') {
          requireCap(actor, 'analytics.view');
          const type = url.searchParams.get('type') ?? 'event_counts';
          const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? '7')));
          const platform = url.searchParams.get('platform') ?? undefined;
          return send(res, 200, { ok: true, ...(await svc.analyticsQuery(type, days, platform)) });
        }

        // ── 玩家查询 ──
        if (method === 'GET' && path.startsWith('/admin/player/')) {
          requireCap(actor, 'player.lookup');
          const publicId = decodeURIComponent(path.slice('/admin/player/'.length));
          return send(res, 200, { ok: true, player: await svc.lookupPlayer(publicId) });
        }

        // ── hash mismatch 对局列表（C3）──
        if (method === 'GET' && path === '/admin/mismatches') {
          requireCap(actor, 'anticheat.view');
          const rows = await svc.listMismatches();
          return send(res, 200, { ok: true, mismatches: rows });
        }

        // ── PvE 可疑账号列表（C4）──
        if (method === 'GET' && path === '/admin/suspicious-pve') {
          requireCap(actor, 'anticheat.view');
          const rows = await svc.listSuspiciousPve();
          return send(res, 200, { ok: true, accounts: rows });
        }

        // ── 成就反作弊审查队列（S9-7）──
        if (method === 'GET' && path === '/admin/anticheat/reviews') {
          requireCap(actor, 'anticheat.view');
          const accountId = url.searchParams.get('accountId') ?? undefined;
          const status = url.searchParams.get('status') ?? undefined;
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
          const reviews = await svc.listAntiCheatReviews(actor.adminId, {
            ...(accountId ? { accountId } : {}),
            ...(status ? { status } : {}),
            limit,
          });
          return send(res, 200, { ok: true, reviews });
        }

        // ── 补偿工单 ──
        if (method === 'POST' && path === '/admin/comp/tickets') {
          const b = await readJson(req);
          // 发起能力（single/global）由 service 据 scope 精确校验。
          const ticket = await svc.initiateTicket(actor, {
            scope: str(b.scope),
            target: b.target as CompTarget,
            mail: b.mail as never,
            reason: str(b.reason),
          });
          return send(res, 200, { ok: true, ticket });
        }
        if (method === 'GET' && path === '/admin/comp/tickets') {
          requireCap(actor, 'comp.view');
          const status = url.searchParams.get('status');
          const tickets = await svc.listTickets(status ? { status } : {});
          return send(res, 200, { ok: true, tickets });
        }
        if (method === 'POST' && path === '/admin/comp/preview') {
          const b = await readJson(req);
          return send(res, 200, {
            ok: true,
            ...(await svc.preview({ scope: str(b.scope), target: b.target as CompTarget })),
          });
        }
        const ticketAction = /^\/admin\/comp\/tickets\/([^/]+)\/(approve|reject|cancel|retry)$/.exec(path);
        if (method === 'POST' && ticketAction) {
          const id = decodeURIComponent(ticketAction[1]!);
          const action = ticketAction[2]!;
          if (action === 'approve') {
            return send(res, 200, { ok: true, ticket: await svc.approveTicket(actor, id) });
          }
          if (action === 'reject') {
            const b = await readJson(req);
            return send(res, 200, { ok: true, ticket: await svc.rejectTicket(actor, id, str(b.note)) });
          }
          if (action === 'cancel') {
            return send(res, 200, { ok: true, ticket: await svc.cancelTicket(actor, id) });
          }
          // retry
          return send(res, 200, { ok: true, ticket: await svc.retryTicket(actor, id) });
        }

        // ── 审计 ──
        if (method === 'GET' && path === '/admin/audit') {
          requireCap(actor, 'audit.view.self');
          const entries = await svc.listAudit(actor, {
            ...(url.searchParams.get('actor') ? { actor: url.searchParams.get('actor')! } : {}),
            from: numOpt(url.searchParams.get('from')),
            to: numOpt(url.searchParams.get('to')),
          });
          return send(res, 200, { ok: true, entries });
        }

        // ── 功能开关（feature flags，config.manage）──
        if (method === 'GET' && path === '/admin/config/flags') {
          requireCap(actor, 'config.manage');
          return send(res, 200, { ok: true, flags: await svc.getConfigFlags() });
        }
        const flagPut = /^\/admin\/config\/flags\/([^/]+)$/.exec(path);
        if (method === 'PUT' && flagPut) {
          requireCap(actor, 'config.manage');
          const key = decodeURIComponent(flagPut[1]!);
          const b = await readJson(req);
          const flag = await svc.upsertFlag(actor, key, {
            ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
            ...(b.rollout !== undefined ? { rollout: b.rollout } : {}),
            ...(typeof b.desc === 'string' ? { desc: b.desc } : {}),
          });
          return send(res, 200, { ok: true, flag });
        }

        // ── 账号管理（超管）──
        if (method === 'GET' && path === '/admin/accounts') {
          requireCap(actor, 'admin.manage');
          return send(res, 200, { ok: true, accounts: await svc.listAccounts() });
        }
        if (method === 'POST' && path === '/admin/accounts') {
          requireCap(actor, 'admin.manage');
          const b = await readJson(req);
          const account = await svc.createAccount(actor, {
            username: str(b.username),
            password: str(b.password),
            role: str(b.role),
            displayName: str(b.displayName),
          });
          return send(res, 200, { ok: true, account });
        }
        const acctPatch = /^\/admin\/accounts\/([^/]+)$/.exec(path);
        if (method === 'PATCH' && acctPatch) {
          requireCap(actor, 'admin.manage');
          const id = decodeURIComponent(acctPatch[1]!);
          const b = await readJson(req);
          const account = await svc.updateAccount(actor, id, {
            ...(typeof b.role === 'string' ? { role: b.role } : {}),
            ...(typeof b.disabled === 'boolean' ? { disabled: b.disabled } : {}),
            ...(typeof b.displayName === 'string' ? { displayName: b.displayName } : {}),
          });
          return send(res, 200, { ok: true, account });
        }
        const acctReset = /^\/admin\/accounts\/([^/]+)\/reset-password$/.exec(path);
        if (method === 'POST' && acctReset) {
          requireCap(actor, 'admin.manage');
          const id = decodeURIComponent(acctReset[1]!);
          const b = await readJson(req);
          await svc.resetPassword(actor, id, str(b.password));
          return send(res, 200, { ok: true });
        }

        // ── 天梯赛季运维（SE-3）──
        if (method === 'GET' && path === '/admin/ladder/season/current') {
          requireCap(actor, 'ladder.season.manage');
          const season = await svc.getLadderCurrentSeason();
          return send(res, 200, { ok: true, season });
        }
        if (method === 'POST' && path === '/admin/ladder/season/roll') {
          requireCap(actor, 'ladder.season.manage');
          const season = await svc.rollLadderSeason(actor.adminId);
          return send(res, 200, { ok: true, season });
        }

        // ── SLG 赛季运维（G7/§17.7）──
        if (method === 'GET' && path === '/admin/slg/worlds') {
          requireCap(actor, 'slg.season.view');
          const worlds = await svc.slgListWorlds();
          return send(res, 200, { ok: true, worlds });
        }
        if (method === 'POST' && path === '/admin/slg/season/open') {
          requireCap(actor, 'slg.season.manage');
          const b = await readJson(req);
          await svc.slgOpenSeason(actor.adminId, str(b.worldId), Number(b.season ?? 1), Number(b.shard ?? 1), Number(b.capacity ?? 10000));
          return send(res, 200, { ok: true });
        }
        if (method === 'POST' && path === '/admin/slg/season/settle') {
          requireCap(actor, 'slg.season.manage');
          const b = await readJson(req);
          const ranking = await svc.slgSettleSeason(actor.adminId, str(b.worldId));
          return send(res, 200, { ok: true, ranking });
        }
        if (method === 'POST' && path === '/admin/slg/season/reset') {
          requireCap(actor, 'slg.season.manage');
          const b = await readJson(req);
          const result = await svc.slgResetSeason(actor.adminId, str(b.worldId));
          return send(res, 200, { ok: true, result });
        }
        if (method === 'POST' && path === '/admin/slg/season/close') {
          requireCap(actor, 'slg.season.manage');
          const b = await readJson(req);
          await svc.slgCloseSeason(actor.adminId, str(b.worldId));
          return send(res, 200, { ok: true });
        }

        // ── SLG 异常交易审计（G7 反 RMT，§17.7）──
        if (method === 'GET' && path === '/admin/slg/audit/anomalies') {
          requireCap(actor, 'slg.audit.view');
          const worldId = url.searchParams.get('worldId') ?? '';
          if (!worldId) throw new AdminError(400, 'bad_request', 'worldId required');
          const anomalies = await svc.slgScanAnomalies(worldId, numOpt(url.searchParams.get('windowSec')));
          return send(res, 200, { ok: true, anomalies });
        }
        if (method === 'GET' && path === '/admin/slg/audit/tickets') {
          requireCap(actor, 'slg.audit.view');
          const status = url.searchParams.get('status');
          const tickets = await svc.slgListAuditTickets(status ? { status } : {});
          return send(res, 200, { ok: true, tickets });
        }
        if (method === 'POST' && path === '/admin/slg/audit/tickets') {
          requireCap(actor, 'slg.audit.manage');
          const b = await readJson(req);
          const ticket = await svc.slgFileAuditTicket(actor, b.snapshot as never);
          return send(res, 200, { ok: true, ticket });
        }
        const auditResolve = /^\/admin\/slg\/audit\/tickets\/([^/]+)\/resolve$/.exec(path);
        if (method === 'POST' && auditResolve) {
          requireCap(actor, 'slg.audit.manage');
          const id = decodeURIComponent(auditResolve[1]!);
          const b = await readJson(req);
          const ticket = await svc.slgResolveAuditTicket(actor, id, str(b.disposition), str(b.note));
          return send(res, 200, { ok: true, ticket });
        }

        // ── 限时活动管理（B6，events.manage）──
        if (method === 'GET' && path === '/admin/events') {
          requireCap(actor, 'events.manage');
          return send(res, 200, { ok: true, events: await svc.listEvents() });
        }
        if (method === 'POST' && path === '/admin/events') {
          requireCap(actor, 'events.manage');
          const b = await readJson(req);
          const event = await svc.createEvent(actor, b as unknown as EventInput);
          return send(res, 200, { ok: true, event });
        }
        const eventPut = /^\/admin\/events\/([^/]+)$/.exec(path);
        if (method === 'PATCH' && eventPut) {
          requireCap(actor, 'events.manage');
          const id = decodeURIComponent(eventPut[1]!);
          const b = await readJson(req);
          const event = await svc.updateEvent(actor, id, b as unknown as EventInput);
          return send(res, 200, { ok: true, event });
        }
        const eventDel = /^\/admin\/events\/([^/]+)$/.exec(path);
        if (method === 'DELETE' && eventDel) {
          requireCap(actor, 'events.manage');
          const id = decodeURIComponent(eventDel[1]!);
          await svc.deleteEvent(actor, id);
          return send(res, 200, { ok: true });
        }

        send(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        if (e instanceof AdminError) {
          send(res, e.status, { ok: false, code: e.code, error: e.message });
        } else if (e instanceof EventsClientError) {
          // meta 端校验/冲突/未找到 → 透传状态码与原因（detail 给运营看）。
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
