// HTTP API exposed to the ops frontend (OPS_DESIGN §4.2). First layer of two-layer auth: admin JWT (ops user).
// The second layer, X-Internal-Key, is held by admin when calling business services (in clients.ts) and is unrelated here.
// Uses node:http (admin does not import fastify). Every endpoint enforces capability checks server-side (hiding buttons in the frontend does not count, §6).
// CORS: admin is internal-only, but the frontend is a pure browser client → allow all origins (Bearer header auth, not cookie, no credentials needed).
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { signToken, verifyToken, createLogger, roleHasCapability, type AdminCapability, type InternalAuthVerifier, type JwtConfig } from '@nw/shared';
import { AdminError, type Actor, type AdminService } from './service';
import { EventsClientError } from './clients';
import type { CompTarget, EventInput, CustomPoolConfig } from '@nw/shared';

const log = createLogger('admin:http');

export interface HttpApiOpts {
  host: string;
  port: number;
  jwt: JwtConfig; // admin-specific secret + ttl
  /** Internal service authentication (X-Internal-Key): database-less backends poll GET /admin/internal/flags to fetch raw flag rules. */
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

  /** Extracts the authenticated actor; throws AdminError(401) on failure. */
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
      // CORS preflight.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type',
        });
        res.end();
        return;
      }
      // Liveness probe (no auth).
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true, service: 'admin' });
        return;
      }
      // ── Internal endpoint: raw feature flag rules (X-Internal-Key, not admin JWT; database-less backends poll here) ──
      // A player JWT cannot satisfy X-Internal-Key (structurally rejected), and this endpoint only reads raw rules without evaluating them —
      // consumers fetch the rules and call evaluateFlag in their own process with the current user context.
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
      // ── Internal endpoint: raw SLG shop price overrides (X-Internal-Key; worldsvc has no DB connection to admin) ──
      // Same shape as the internal flags endpoint above: raw override docs only, worldsvc merges them onto
      // SLG_SHOP_ITEMS locally via resolveSlgShopItem.
      if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/admin/internal/slg-shop-prices') {
        if (!internalAuth.verify(req.headers).ok) {
          log.warn('internal slg-shop-prices request rejected: bad X-Internal-Key', {
            caller: req.headers['x-internal-caller'],
          });
          send(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        try {
          send(res, 200, { ok: true, items: await svc.getInternalShopPrices() });
        } catch (e) {
          log.error('internal slg-shop-prices fetch failed', { err: (e as Error).message });
          send(res, 500, { ok: false, error: 'internal error' });
        }
        return;
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'admin'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      try {
        // ── Login (no session required) ──
        if (method === 'POST' && path === '/admin/login') {
          const b = await readJson(req);
          const doc = await svc.authenticate(str(b.username), str(b.password), clientIp(req));
          const token = signToken(doc._id, jwt);
          const { admin, capabilities } = svc.meView(doc);
          return send(res, 200, { ok: true, token, admin, capabilities });
        }

        // All other endpoints require a session.
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

        // ── Monitoring ──
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

        // ── Analytics ──
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

        // ── Player fuzzy search (nickname / login account / public id / accountId) ──
        if (method === 'GET' && path === '/admin/players/search') {
          requireCap(actor, 'player.lookup');
          const q = url.searchParams.get('q') ?? '';
          return send(res, 200, { ok: true, players: await svc.searchPlayers(actor.adminId, q) });
        }

        // ── Player detail (by accountId, fetched after clicking a fuzzy search result) ──
        if (method === 'GET' && path.startsWith('/admin/player/account/')) {
          requireCap(actor, 'player.lookup');
          const accountId = decodeURIComponent(path.slice('/admin/player/account/'.length));
          return send(res, 200, { ok: true, player: await svc.lookupPlayerByAccountId(accountId) });
        }

        // ── Player detail (by 9-digit public id) ──
        if (method === 'GET' && path.startsWith('/admin/player/')) {
          requireCap(actor, 'player.lookup');
          const publicId = decodeURIComponent(path.slice('/admin/player/'.length));
          return send(res, 200, { ok: true, player: await svc.lookupPlayer(publicId) });
        }

        // ── Player password reset (player.password_reset, super only): support tool for players with no
        // contact method on file, who cannot use self-service /auth/password/change (needs the old password) ──
        const pwResetMatch = path.match(/^\/admin\/players\/([^/]+)\/reset-password$/);
        if (method === 'POST' && pwResetMatch) {
          requireCap(actor, 'player.password_reset');
          const accountId = decodeURIComponent(pwResetMatch[1] ?? '');
          const b = await readJson(req);
          await svc.resetPlayerPassword(actor.adminId, accountId, str(b.password));
          return send(res, 200, { ok: true });
        }

        // ── Hash mismatch match list (C3) ──
        if (method === 'GET' && path === '/admin/mismatches') {
          requireCap(actor, 'anticheat.view');
          const rows = await svc.listMismatches();
          return send(res, 200, { ok: true, mismatches: rows });
        }

        // ── PvE suspicious account list (C4) ──
        if (method === 'GET' && path === '/admin/suspicious-pve') {
          requireCap(actor, 'anticheat.view');
          const rows = await svc.listSuspiciousPve();
          return send(res, 200, { ok: true, accounts: rows });
        }

        // ── Manual ban / unban (S4-4) ──
        const banMatch = path.match(/^\/admin\/accounts\/([^/]+)\/(ban|unban)$/);
        if (method === 'POST' && banMatch) {
          requireCap(actor, 'anticheat.action');
          const accountId = decodeURIComponent(banMatch[1] ?? '');
          const action = (banMatch[2] ?? 'ban') as 'ban' | 'unban';
          const result = action === 'ban'
            ? await svc.banAccount(accountId)
            : await svc.unbanAccount(accountId);
          await svc.audit(actor.adminId, action === 'ban' ? 'account.ban' : 'account.unban', { target: accountId });
          return send(res, result.ok ? 200 : 502, { ok: result.ok });
        }

        // ── Achievement anti-cheat review queue (S9-7) ──
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

        // ── Resolve an anti-cheat review (anticheat.action): human decides dismiss vs ban ──
        const reviewResolveMatch = path.match(/^\/admin\/anticheat\/reviews\/([^/]+)\/resolve$/);
        if (method === 'POST' && reviewResolveMatch) {
          requireCap(actor, 'anticheat.action');
          const id = decodeURIComponent(reviewResolveMatch[1] ?? '');
          const b = await readJson(req);
          const resolution = str(b.resolution);
          if (resolution !== 'dismissed' && resolution !== 'banned') {
            return send(res, 400, { ok: false, error: 'resolution must be dismissed or banned' });
          }
          await svc.resolveAntiCheatReview(actor.adminId, id, str(b.accountId), resolution);
          return send(res, 200, { ok: true });
        }

        // ── Compensation tickets ──
        if (method === 'POST' && path === '/admin/comp/tickets') {
          const b = await readJson(req);
          // Initiating capability (single/global) is precisely validated by service based on scope.
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

        // ── Audit ──
        if (method === 'GET' && path === '/admin/audit') {
          requireCap(actor, 'audit.view.self');
          const entries = await svc.listAudit(actor, {
            ...(url.searchParams.get('actor') ? { actor: url.searchParams.get('actor')! } : {}),
            from: numOpt(url.searchParams.get('from')),
            to: numOpt(url.searchParams.get('to')),
          });
          return send(res, 200, { ok: true, entries });
        }

        // ── Feature flags (config.manage) ──
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

        // ── SLG shop price overrides (slg.shop.manage) ──
        if (method === 'GET' && path === '/admin/config/slg-shop') {
          requireCap(actor, 'slg.shop.manage');
          return send(res, 200, { ok: true, items: await svc.getShopConfig() });
        }
        const shopPut = /^\/admin\/config\/slg-shop\/([^/]+)$/.exec(path);
        if (method === 'PUT' && shopPut) {
          requireCap(actor, 'slg.shop.manage');
          const id = decodeURIComponent(shopPut[1]!);
          const b = await readJson(req);
          const item = await svc.upsertShopItem(actor, id, {
            ...(b.cost !== undefined ? { cost: b.cost } : {}),
            ...(b.effect !== undefined ? { effect: b.effect } : {}),
          });
          return send(res, 200, { ok: true, item });
        }

        // ── Account management (superadmin) ──
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

        // ── Ladder season operations (SE-3) ──
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

        // ── SLG season operations (G7/§17.7) ──
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
        if (method === 'POST' && path === '/admin/slg/season/merge') {
          requireCap(actor, 'slg.season.manage');
          const b = await readJson(req);
          const result = await svc.slgMergeShard(actor.adminId, str(b.worldId), str(b.targetWorldId));
          return send(res, 200, { ok: true, result });
        }

        // ── SLG anomalous transaction audit (G7 anti-RMT, §17.7) ──
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

        // ── SLG map templates (§24, admin map editor) ──
        if (method === 'GET' && path === '/admin/slg/map-templates') {
          requireCap(actor, 'slg.map.view');
          return send(res, 200, { ok: true, templates: await svc.slgListMapTemplates() });
        }
        if (method === 'POST' && path === '/admin/slg/map-templates/generate') {
          requireCap(actor, 'slg.map.manage');
          const b = await readJson(req);
          const summary = await svc.slgGenerateMapTemplate(actor.adminId, str(b.templateId), Number(b.width), Number(b.height));
          return send(res, 200, { ok: true, template: summary });
        }
        const mapTiles = /^\/admin\/slg\/map-templates\/([^/]+)\/tiles$/.exec(path);
        if (method === 'GET' && mapTiles) {
          requireCap(actor, 'slg.map.view');
          const templateId = decodeURIComponent(mapTiles[1]!);
          const tiles = await svc.slgGetMapTemplateTiles(
            templateId,
            Number(url.searchParams.get('x') ?? '0'),
            Number(url.searchParams.get('y') ?? '0'),
            Number(url.searchParams.get('w') ?? '100'),
            Number(url.searchParams.get('h') ?? '100'),
          );
          return send(res, 200, { ok: true, tiles });
        }
        if (method === 'PUT' && mapTiles) {
          requireCap(actor, 'slg.map.manage');
          const templateId = decodeURIComponent(mapTiles[1]!);
          const b = await readJson(req);
          const result = await svc.slgSaveMapTemplateTiles(actor.adminId, templateId, Array.isArray(b.tiles) ? (b.tiles as never[]) : []);
          return send(res, 200, { ok: true, ...result });
        }
        const mapActivate = /^\/admin\/slg\/map-templates\/([^/]+)\/activate$/.exec(path);
        if (method === 'POST' && mapActivate) {
          requireCap(actor, 'slg.map.manage');
          await svc.slgActivateMapTemplate(actor.adminId, decodeURIComponent(mapActivate[1]!));
          return send(res, 200, { ok: true });
        }
        const mapDelete = /^\/admin\/slg\/map-templates\/([^/]+)$/.exec(path);
        if (method === 'DELETE' && mapDelete) {
          requireCap(actor, 'slg.map.manage');
          await svc.slgDeleteMapTemplate(actor.adminId, decodeURIComponent(mapDelete[1]!));
          return send(res, 200, { ok: true });
        }

        // ── Promo code management (B-PROMO, promo.manage) ──
        if (method === 'GET' && path === '/admin/promo/codes') {
          requireCap(actor, 'promo.manage');
          return send(res, 200, { ok: true, codes: await svc.listPromoCodes() });
        }
        if (method === 'POST' && path === '/admin/promo/codes') {
          requireCap(actor, 'promo.manage');
          const b = await readJson(req);
          const code = typeof b.code === 'string' ? b.code : '';
          const coins = typeof b.coins === 'number' ? b.coins : 0;
          if (!code || coins <= 0) throw new AdminError(400, 'bad_request', 'code + coins required');
          const result = await svc.createPromoCode(actor, {
            code,
            coins,
            ...(typeof b.expiresAt === 'number' ? { expiresAt: b.expiresAt } : {}),
            ...(typeof b.totalLimit === 'number' ? { totalLimit: b.totalLimit } : {}),
            ...(typeof b.note === 'string' && b.note ? { note: b.note } : {}),
          });
          return send(res, 200, { ok: true, ...result });
        }

        // ── Paddle webhook event log (support/CS lookup, paddle.events.view) ──
        if (method === 'GET' && path === '/admin/paddle/events') {
          requireCap(actor, 'paddle.events.view');
          const events = await svc.listPaddleEvents({
            accountId: url.searchParams.get('accountId') ?? undefined,
            transactionId: url.searchParams.get('transactionId') ?? undefined,
            limit: numOpt(url.searchParams.get('limit')),
          });
          return send(res, 200, { ok: true, events });
        }

        // ── Limited-time event management (B6, events.manage) ──
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

        // ── Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage) ──
        if (method === 'GET' && path === '/admin/gacha/pools') {
          requireCap(actor, 'gacha.pools.manage');
          return send(res, 200, { ok: true, pools: await svc.listGachaPools() });
        }
        if (method === 'GET' && path === '/admin/gacha/catalog') {
          requireCap(actor, 'gacha.pools.manage');
          return send(res, 200, { ok: true, catalog: await svc.gachaCatalog() });
        }
        if (method === 'POST' && path === '/admin/gacha/pools/custom') {
          requireCap(actor, 'gacha.pools.manage');
          const b = await readJson(req);
          const r = await svc.createCustomPool(actor, b as unknown as CustomPoolConfig);
          return send(res, 200, { ok: true, id: r.id });
        }
        if (method === 'POST' && path === '/admin/gacha/pools/close') {
          requireCap(actor, 'gacha.pools.manage');
          const b = (await readJson(req)) as { id?: string };
          const r = await svc.closeGachaPool(actor, String(b.id ?? ''));
          return send(res, 200, { ok: true, id: r.id });
        }

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
