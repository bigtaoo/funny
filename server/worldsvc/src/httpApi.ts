// worldsvc public REST (S8-0, SLG_DESIGN §14.1 P1 / §14.6). Public-facing surface: /world/* (/family/* already migrated to socialsvc; /auction/* moved to auctionsvc, §9 task 6).
// Auth: reuses the meta JWT; only verifyToken is called to extract accountId (no accounts DB connection, P1).
// Uses node:http (worldsvc does not depend on fastify). Responses wrapped in @nw/shared ApiResp envelope; error codes → HTTP status via ERROR_HTTP_STATUS.
// S8-0: map/player-state implemented; march/defense/troops/family/season return NOT_IMPLEMENTED (S8-1~5).
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
  BUILDING_KEYS,
  type MarchKind,
  type BuildingKey,
} from '@nw/shared';
import type { WorldService } from './service';
import type { TeamTemplate } from './db';
import type { SectService } from './sectService';
import type { NationChannelService } from './nationChannelService';
import type { WorldSocialsvcClient } from './socialsvcClient';
import type { MapTemplateService } from './mapTemplateService';

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
    // Public-facing surface: CORS aligned with meta (fully open in dev, tightened by reverse proxy in production).
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

const NOT_IMPL = (res: ServerResponse, what: string): void =>
  sendErr(res, ErrorCode.NOT_IMPLEMENTED, `${what} not implemented (S8-1~5)`);

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

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
      if (method === 'GET' && req.url?.split('?')[0] === '/world/active-season') {
        return send(res, 200, ok({ season: await svc.getActiveSeasonNo() }));
      }

      // —— Internal ops branch (C4/§17.7): /admin/world/* uses X-Internal-Key, checked before JWT. ——
      // Any logged-in player could previously call /admin/world/reset to wipe an entire region (C4 security hole); now moved out of the JWT branch.
      {
        const aurl = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
        if (aurl.pathname.startsWith('/admin/world/')) {
          if (!internalAuth.verify(req.headers).ok) {
            return sendErr(res, ErrorCode.UNAUTHENTICATED, 'internal endpoint requires X-Internal-Key');
          }

          // ── Map templates (§24 Layer A, admin map editor) — self-contained sub-branch, any method, no worldId gate. ──
          if (aurl.pathname.startsWith('/admin/world/map-templates')) {
            try {
              if (method === 'GET' && aurl.pathname === '/admin/world/map-templates') {
                return send(res, 200, ok(await mapTemplateSvc.listTemplates()));
              }
              if (method === 'POST' && aurl.pathname === '/admin/world/map-templates/generate') {
                const body = await readJson(req);
                const templateId = typeof body.templateId === 'string' ? body.templateId : '';
                const summary = await mapTemplateSvc.generateTemplate(templateId, Number(body.width), Number(body.height));
                return send(res, 200, ok(summary));
              }
              const tilesMatch = /^\/admin\/world\/map-templates\/([^/]+)\/tiles$/.exec(aurl.pathname);
              if (tilesMatch) {
                const templateId = decodeURIComponent(tilesMatch[1]!);
                if (method === 'GET') {
                  const tiles = await mapTemplateSvc.getTiles(
                    templateId,
                    numQ(aurl.searchParams.get('x'), 0),
                    numQ(aurl.searchParams.get('y'), 0),
                    numQ(aurl.searchParams.get('w'), 100),
                    numQ(aurl.searchParams.get('h'), 100),
                  );
                  return send(res, 200, ok(tiles));
                }
                if (method === 'PUT') {
                  const body = await readJson(req);
                  const result = await mapTemplateSvc.saveTilesDiff(templateId, Array.isArray(body.tiles) ? (body.tiles as never[]) : []);
                  return send(res, 200, ok(result));
                }
              }
              const activateMatch = /^\/admin\/world\/map-templates\/([^/]+)\/activate$/.exec(aurl.pathname);
              if (method === 'POST' && activateMatch) {
                await mapTemplateSvc.setActiveTemplate(decodeURIComponent(activateMatch[1]!));
                return send(res, 200, ok({}));
              }
              const deleteMatch = /^\/admin\/world\/map-templates\/([^/]+)$/.exec(aurl.pathname);
              if (method === 'DELETE' && deleteMatch) {
                await mapTemplateSvc.deleteTemplate(decodeURIComponent(deleteMatch[1]!));
                return send(res, 200, ok({}));
              }
              return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
            } catch (e) {
              if (e instanceof SlgError) return sendErr(res, e.code, e.message);
              return send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
            }
          }

          // List summary of all regions (G7/§17.7 admin console).
          if (method === 'GET' && aurl.pathname === '/admin/world/list') {
            return send(res, 200, ok(await svc.listWorlds()));
          }
          // Cross-region isolation patrol (G6/§20): cross-region march / dual-account detection / orphan tile scan.
          if (method === 'GET' && aurl.pathname === '/admin/world/patrol') {
            return send(res, 200, ok(await svc.patrolShardIsolation()));
          }
          if (method !== 'POST') return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
          const body = await readJson(req);
          // New-season region allocation (G6/§20): open N regions using snake-draft balancing based on last season's sect strength, no worldId required (checked before the worldId gate).
          if (aurl.pathname === '/admin/world/allocate') {
            try {
              const seasonNum = Number(body.season);
              if (!Number.isFinite(seasonNum)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
              const cap = body.capacity != null ? Number(body.capacity) : undefined;
              return send(res, 200, ok(await svc.allocateNextSeason(seasonNum, cap)));
            } catch (e) {
              if (e instanceof SlgError) return sendErr(res, e.code, e.message);
              return send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
            }
          }
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          try {
            if (aurl.pathname === '/admin/world/open') {
              await svc.openSeason(worldId, Number(body.season ?? 1), Number(body.shard ?? 1), Number(body.capacity ?? 10000));
              // §24: clone the active map template's tiles as this world's terrain baseline (copy, not a live reference).
              // No-op if no template is marked active — behavior is unchanged (proceduralTile-only) until ops sets one.
              await mapTemplateSvc.cloneActiveTemplateInto(worldId);
              return send(res, 200, ok({}));
            }
            if (aurl.pathname === '/admin/world/settle') {
              return send(res, 200, ok(await svc.settleSeason(worldId)));
            }
            if (aurl.pathname === '/admin/world/reset') {
              const reset = await svc.resetSeason(worldId);
              return send(res, 200, ok(reset));
            }
            if (aurl.pathname === '/admin/world/close') {
              await svc.closeSeason(worldId);
              return send(res, 200, ok({}));
            }
            return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
          } catch (e) {
            if (e instanceof SlgError) return sendErr(res, e.code, e.message);
            return send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
          }
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

      try {
        // ── Map and territory (GET, implemented) ──
        if (method === 'GET' && path === '/world/me') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getMe(worldId, accountId)));
        }
        if (method === 'GET' && path === '/world/map') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const view = await svc.getMap(
            worldId,
            accountId,
            numQ(q.get('cx'), 0),
            numQ(q.get('cy'), 0),
            numQ(q.get('r'), 10),
          );
          return send(res, 200, ok(view));
        }
        if (method === 'GET' && path === '/world/map/sparse') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const lod = q.get('lod') === 'mid' ? 'mid' : 'thin';
          const view = await svc.getMapSparse(
            worldId,
            accountId,
            numQ(q.get('cx'), 0),
            numQ(q.get('cy'), 0),
            numQ(q.get('r'), 10),
            lod,
          );
          return send(res, 200, ok(view));
        }
        if (method === 'GET' && path.startsWith('/world/tile/')) {
          const tid = decodeURIComponent(path.slice('/world/tile/'.length));
          const parts = tid.split(':');
          if (parts.length !== 3) return sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId');
          const worldId = parts[0]!;
          const x = Number(parts[1]);
          const y = Number(parts[2]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'bad tileId coords');
          }
          return send(res, 200, ok(await svc.getTile(worldId, accountId, x, y)));
        }

        // ── March list (S8-2, implemented) ──
        if (method === 'GET' && path === '/world/march') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getMarches(worldId, accountId)));
        }

        // ── Occupation-hold list (2026-07-15, team management status + cancel) ──
        if (method === 'GET' && path === '/world/occupations') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getOccupations(worldId, accountId)));
        }

        // ── Territory Overview panel (2026-07-16, SLG_DESIGN_LOG.md §26): full list of owned tiles ──
        if (method === 'GET' && path === '/world/territories') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.listTerritories(worldId, accountId)));
        }

        // ── Resolve shard by season (G6/§20): resolve only, no base placement; client fetches worldId before entering the map ──
        if (method === 'POST' && path === '/world/season/resolve') {
          const body = await readJson(req);
          const season = Number(body.season);
          if (!Number.isFinite(season)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
          return send(res, 200, ok(await svc.resolveSeasonShard(season, accountId)));
        }

        // ── Season join (G6/§20): server resolves shard and routes automatically (sect > family > solo random, overflow opens a new region) ──
        if (method === 'POST' && path === '/world/season/join') {
          const body = await readJson(req);
          const season = Number(body.season);
          if (!Number.isFinite(season)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
          // System auto-places base (§3.4): no coordinates taken from client, server picks the location.
          return send(res, 200, ok(await svc.joinSeason(season, accountId)));
        }

        // ── Join world (S8-1): system auto-places base (§3.4), only worldId required, no coordinates ──
        if (method === 'POST' && path === '/world/join') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.joinWorld(worldId, accountId)));
        }

        // ── Occupy / abandon / relocate / watchtower (S8-1, implemented, requires coordinates) ──
        if (
          method === 'POST' &&
          (path === '/world/occupy' || path === '/world/abandon' ||
            path === '/world/relocate' || path === '/world/watchtower')
        ) {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const x = Number(body.x);
          const y = Number(body.y);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required');
          }
          if (path === '/world/occupy') {
            return send(res, 200, ok(await svc.occupyTile(worldId, accountId, x, y)));
          }
          if (path === '/world/relocate') {
            return send(res, 200, ok(await svc.relocateBase(worldId, accountId, x, y)));
          }
          if (path === '/world/watchtower') {
            return send(res, 200, ok(await svc.buildWatchtower(worldId, accountId, x, y)));
          }
          return send(res, 200, ok(await svc.abandonTile(worldId, accountId, x, y)));
        }

        // ── March (S8-2, implemented) ──
        if (method === 'POST' && path === '/world/march') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const fromX = Number(body.fromX);
          const fromY = Number(body.fromY);
          const toX = Number(body.toX);
          const toY = Number(body.toY);
          const kind = typeof body.kind === 'string' ? body.kind : '';
          const troops = Number(body.troops);
          const teamId = typeof body.teamId === 'string' ? body.teamId : undefined;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
          }
          return send(
            res,
            200,
            ok(await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind as MarchKind, troops, teamId)),
          );
        }
        {
          const m = /^\/world\/march\/([^/]+)\/recall$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await svc.recallMarch(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }

        // ── Team management "取消指令" (2026-07-15): force an occupation-hold team back to idle ──
        {
          const m = /^\/world\/team\/([^/]+)\/cancel-occupation$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            await svc.cancelOccupation(worldId, accountId, decodeURIComponent(m[1]!));
            return send(res, 200, ok({}));
          }
        }

        // ── Sweep (S8-3, §14.6 convenience alias = march kind:'sweep') ──
        if (method === 'POST' && path === '/world/sweep') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const fromX = Number(body.fromX);
          const fromY = Number(body.fromY);
          const toX = Number(body.toX);
          const toY = Number(body.toY);
          const troops = Number(body.troops);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'fromX/fromY/toX/toY required');
          }
          return send(res, 200, ok(await svc.startMarch(worldId, accountId, fromX, fromY, toX, toY, 'sweep', troops)));
        }

        // ── Defense config (S8-4 remnant, implemented) ──
        if (method === 'GET' && path === '/world/defense') {
          const worldId = q.get('worldId');
          const tileKey = q.get('tileKey') ?? 'base';
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getDefense(worldId, accountId, tileKey)));
        }
        if (method === 'PUT' && path === '/world/defense') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const tileKey = typeof body.tileKey === 'string' ? body.tileKey : 'base';
          const defenseConfig = typeof body.defenseConfig === 'object' && body.defenseConfig && !Array.isArray(body.defenseConfig)
            ? body.defenseConfig as Record<string, unknown>
            : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!defenseConfig) return sendErr(res, ErrorCode.BAD_REQUEST, 'defenseConfig required');
          await svc.setDefense(worldId, accountId, tileKey, defenseConfig);
          return send(res, 200, ok({}));
        }

        // ── Offensive formation templates (teams, G3-2c) ──
        if (method === 'GET' && path === '/world/teams') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getTeams(worldId, accountId)));
        }
        if (method === 'PUT' && path === '/world/teams') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const teams = Array.isArray(body.teams) ? (body.teams as TeamTemplate[]) : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!teams) return sendErr(res, ErrorCode.BAD_REQUEST, 'teams required');
          await svc.setTeams(worldId, accountId, teams);
          return send(res, 200, ok({}));
        }

        // ── CC-3: card troop distribution + injury recovery ──
        if (method === 'POST' && path === '/world/troops/distribute') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const allocations = body.allocations && typeof body.allocations === 'object' && !Array.isArray(body.allocations) ? (body.allocations as Record<string, number>) : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!allocations) return sendErr(res, ErrorCode.BAD_REQUEST, 'allocations required');
          await svc.distributeTroops(worldId, accountId, allocations);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/world/troops/recover') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const cardInstanceId = typeof body.cardInstanceId === 'string' ? body.cardInstanceId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!cardInstanceId) return sendErr(res, ErrorCode.BAD_REQUEST, 'cardInstanceId required');
          await svc.recoverCard(worldId, accountId, cardInstanceId);
          return send(res, 200, ok({}));
        }

        // ── Training queue (S8-2, implemented) ──
        if (method === 'POST' && path === '/world/troops/train') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const qty = Number(body.qty);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!Number.isFinite(qty) || qty < 1) return sendErr(res, ErrorCode.BAD_REQUEST, 'qty required');
          return send(res, 200, ok(await svc.trainTroops(worldId, accountId, qty)));
        }
        if (method === 'POST' && path === '/world/troops/speedup') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const coins = Number(body.coins);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!Number.isFinite(coins) || coins < 1) return sendErr(res, ErrorCode.BAD_REQUEST, 'coins required');
          return send(res, 200, ok(await svc.speedupTraining(worldId, accountId, coins)));
        }

        // ── Home-city buildings (SLG_CITY_DESIGN P1+P2, implemented) ──
        if (method === 'POST' && path === '/world/build/upgrade') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const key = typeof body.key === 'string' ? body.key : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!key || !BUILDING_KEYS.includes(key as BuildingKey)) return sendErr(res, ErrorCode.BAD_REQUEST, 'valid building key required');
          return send(res, 200, ok(await svc.upgradeBuilding(worldId, accountId, key as BuildingKey)));
        }
        if (method === 'POST' && path === '/world/build/speedup') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const coins = Number(body.coins);
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          if (!Number.isFinite(coins) || coins < 1) return sendErr(res, ErrorCode.BAD_REQUEST, 'coins required');
          return send(res, 200, ok(await svc.speedupBuild(worldId, accountId, coins)));
        }

        // ── Siege replay spectator view (G3-2c, seed + both-side formations, readable by both attacker and defender) ──
        {
          const m = /^\/world\/siege\/([^/]+)\/replay$/.exec(path);
          if (method === 'GET' && m) {
            const worldId = q.get('worldId');
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await svc.getSiegeReplay(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }


        // ── Sect (S8-4b, implemented) ────────────────────────────────────────
        if (method === 'GET' && path === '/sect/list') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await sectSvc.listSects(worldId)));
        }
        {
          const m = /^\/sect\/([^/]+)$/.exec(path);
          if (method === 'GET' && m && path !== '/sect/list' && path !== '/sect/channel') {
            return send(res, 200, ok(await sectSvc.getSect(decodeURIComponent(m[1]!))));
          }
        }
        if (method === 'POST' && path === '/sect/create') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const name = typeof body.name === 'string' ? body.name : null;
          const tag = typeof body.tag === 'string' ? body.tag : null;
          if (!worldId || !name || !tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + name + tag required');
          return send(res, 200, ok(await sectSvc.createSect(worldId, accountId, name, tag)));
        }
        if (method === 'POST' && path === '/sect/join') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const sectId = typeof body.sectId === 'string' ? body.sectId : null;
          if (!worldId || !sectId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + sectId required');
          await sectSvc.joinSect(worldId, accountId, sectId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/sect/leave') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          await sectSvc.leaveSect(worldId, accountId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/sect/dissolve') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          await sectSvc.dissolveSect(worldId, accountId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/sect/ally') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const targetSectId = typeof body.targetSectId === 'string' ? body.targetSectId : null;
          if (!worldId || !targetSectId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetSectId required');
          await sectSvc.allySect(worldId, accountId, targetSectId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/sect/unally') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const targetSectId = typeof body.targetSectId === 'string' ? body.targetSectId : null;
          if (!worldId || !targetSectId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetSectId required');
          await sectSvc.unallySect(worldId, accountId, targetSectId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/sect/vote-remove-leader') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const nomineeFamilyId = typeof body.nomineeFamilyId === 'string' ? body.nomineeFamilyId : null;
          if (!worldId || !nomineeFamilyId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + nomineeFamilyId required');
          return send(res, 200, ok(await sectSvc.voteRemoveLeader(worldId, accountId, nomineeFamilyId)));
        }
        if (method === 'POST' && path === '/sect/message') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const msgBody = typeof body.body === 'string' ? body.body : null;
          const senderName = typeof body.senderName === 'string' ? body.senderName : accountId;
          if (!worldId || !msgBody) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + body required');
          return send(res, 200, ok(await sectSvc.sendMessage(worldId, accountId, senderName, msgBody)));
        }
        if (method === 'GET' && path === '/sect/channel') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const before = q.get('before') ? Number(q.get('before')) : undefined;
          const limit = numQ(q.get('limit'), 30);
          return send(res, 200, ok(await sectSvc.getChannel(worldId, accountId, before, limit)));
        }

        // ── Nation/world public channel (B7, §6.4) ────────────────────────────────────
        if (method === 'POST' && path === '/nation/message') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const msgBody = typeof body.body === 'string' ? body.body : null;
          const senderName = typeof body.senderName === 'string' ? body.senderName : accountId;
          if (!worldId || !msgBody) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + body required');
          return send(res, 200, ok(await nationChannelSvc.sendMessage(worldId, accountId, senderName, msgBody)));
        }
        if (method === 'GET' && path === '/nation/channel') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const before = q.get('before') ? Number(q.get('before')) : undefined;
          const limit = numQ(q.get('limit'), 30);
          return send(res, 200, ok(await nationChannelSvc.getChannel(worldId, accountId, before, limit)));
        }

        // ── Nation (S8-6.5, implemented) ──
        if (method === 'GET' && path === '/world/nations') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getNations(worldId)));
        }
        {
          const m = /^\/world\/nations\/(\d+)\/name$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            const name = typeof body.name === 'string' ? body.name : null;
            if (!worldId || !name) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + name required');
            await svc.setNationName(worldId, accountId, Number(m[1]), name);
            return send(res, 200, ok({}));
          }
        }

        // ── Season (S8-7, implemented) ──
        if (method === 'GET' && path === '/world/season') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const season = await svc.getSeason(worldId);
          if (!season) return sendErr(res, ErrorCode.NOT_FOUND, 'world not found');
          return send(res, 200, ok(season));
        }

        // ── SLG shop (S8-8, implemented) ──
        if (method === 'GET' && path === '/world/shop/items') {
          return send(res, 200, ok(svc.getSlgShopItems()));
        }
        if (method === 'POST' && path === '/world/shop/buy') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const itemId = typeof body.itemId === 'string' ? body.itemId : null;
          if (!worldId || !itemId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + itemId required');
          return send(res, 200, ok(await svc.buySlgShopItem(worldId, accountId, itemId)));
        }

        // Season management /admin/world/* has been moved out of the JWT branch to use X-Internal-Key (C4/§17.7, see internal branch above).

        return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
      } catch (e) {
        if (e instanceof SlgError) return sendErr(res, e.code, e.message);
        send(res, 500, err(ErrorCode.INTERNAL, (e as Error).message));
      }
    })();
  });
  server.listen(opts.port, opts.host);
  return server;
}
