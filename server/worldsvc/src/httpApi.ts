// worldsvc 公网 REST（S8-0，SLG_DESIGN §14.1 P1 / §14.6）。第四公网面：/world/* /family/* /auction/*。
// 鉴权：复用 meta JWT，仅 verifyToken 验签取 accountId（不连 accounts 库，P1）。
// 用 node:http（worldsvc 不引 fastify）。响应走 @nw/shared ApiResp 包络，错误码 → HTTP 经 ERROR_HTTP_STATUS。
// S8-0：地图/玩家状态做实；行军/防守/兵力/家族/拍卖/赛季返回 NOT_IMPLEMENTED（S8-1~5）。
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
  type MarchKind,
} from '@nw/shared';
import type { WorldService } from './service';
import type { TeamTemplate } from './db';
import type { FamilyService } from './familyService';
import type { SectService } from './sectService';
import type { AuctionService } from './auctionService';

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
    // 公网面：CORS 与 meta 对齐（dev 全开，生产由反代收紧）。
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-internal-key,x-internal-caller',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  });
  res.end(JSON.stringify(body));
}

function sendErr(res: ServerResponse, code: ErrorCode, message: string): void {
  send(res, ERROR_HTTP_STATUS[code] ?? 400, err(code, message));
}

const NOT_IMPL = (res: ServerResponse, what: string): void =>
  sendErr(res, ErrorCode.NOT_IMPLEMENTED, `${what} 未实现（S8-1~5）`);

const numQ = (v: string | null, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function startHttpApi(
  opts: { host: string; port: number; jwtSecret: string; internalKey: string },
  svc: WorldService,
  familySvc: FamilyService,
  sectSvc: SectService,
  auctionSvc: AuctionService,
): Server {
  // 内部运维鉴权（C4/§17.7）：/admin/world/* 走 X-Internal-Key，不走玩家 JWT。
  const internalAuth = loadInternalAuth(opts.internalKey);
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // 存活探针（无需鉴权）：docker healthcheck / CI 等待用。
      if (method === 'GET' && req.url === '/health') {
        return send(res, 200, { ok: true, service: 'worldsvc' });
      }
      if (method === 'OPTIONS') {
        return send(res, 204, {});
      }

      // —— 内部运维分支（C4/§17.7）：/admin/world/* 走 X-Internal-Key，先于 JWT。——
      // 任意登录玩家曾可调 /admin/world/reset 清整个大区（C4 安全洞）；现迁出 JWT 分支。
      {
        const aurl = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
        if (aurl.pathname.startsWith('/admin/world/')) {
          if (!internalAuth.verify(req.headers).ok) {
            return sendErr(res, ErrorCode.UNAUTHENTICATED, '内部端点需 X-Internal-Key');
          }
          // 列出各大区概要（G7/§17.7 admin 后台）。
          if (method === 'GET' && aurl.pathname === '/admin/world/list') {
            return send(res, 200, ok(await svc.listWorlds()));
          }
          // 跨区隔离巡检（G6/§20）：跨区行军 / 玩家双开 / 孤儿格扫描。
          if (method === 'GET' && aurl.pathname === '/admin/world/patrol') {
            return send(res, 200, ok(await svc.patrolShardIsolation()));
          }
          // 拍卖异常交易审计扫描（D/G7/§17.7）：近期 sold 配对聚合，供 admin 审计队列拉取。
          if (method === 'GET' && aurl.pathname === '/admin/world/audit/anomalies') {
            const wid = aurl.searchParams.get('worldId');
            if (!wid) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            const winQ = aurl.searchParams.get('windowSec');
            const windowSec = winQ != null && Number.isFinite(Number(winQ)) ? Number(winQ) : undefined;
            return send(res, 200, ok(await auctionSvc.scanAnomalies(wid, windowSec)));
          }
          if (method !== 'POST') return sendErr(res, ErrorCode.NOT_FOUND, 'not found');
          const body = await readJson(req);
          // 新赛季开区编排（G6/§20）：按上季宗门强弱蛇形均衡开 N 区，无 worldId（先于 worldId 门）。
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
              return send(res, 200, ok({}));
            }
            if (aurl.pathname === '/admin/world/settle') {
              return send(res, 200, ok(await svc.settleSeason(worldId)));
            }
            if (aurl.pathname === '/admin/world/reset') {
              // F 季末清算：先清算拍卖行（退还卖方挂存 + 退还竞拍托管 + 清价格滑窗），再清地图态。
              const auctionCleared = await auctionSvc.clearWorldOnReset(worldId);
              const reset = await svc.resetSeason(worldId);
              return send(res, 200, ok({ ...reset, auctionCleared }));
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

      // —— JWT 验签（P1：仅取 accountId，不连库）——
      const token = extractBearer(req.headers['authorization']);
      let accountId: string;
      try {
        if (!token) throw new Error('no bearer');
        accountId = verifyToken(token, { secret: opts.jwtSecret });
      } catch {
        return sendErr(res, ErrorCode.UNAUTHENTICATED, '需要登录');
      }

      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'world'}`);
      const path = url.pathname;
      const q = url.searchParams;

      try {
        // ── 地图与领地（GET，做实）──
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

        // ── 行军列表（S8-2，做实）──
        if (method === 'GET' && path === '/world/march') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await svc.getMarches(worldId, accountId)));
        }

        // ── 按赛季解析 shard（G6/§20）：只解析不落城，客户端进图前拿 worldId ──
        if (method === 'POST' && path === '/world/season/resolve') {
          const body = await readJson(req);
          const season = Number(body.season);
          if (!Number.isFinite(season)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
          return send(res, 200, ok(await svc.resolveSeasonShard(season, accountId)));
        }

        // ── 按赛季 join（G6/§20）：服务端解析 shard 自动路由（宗门>家族>单随，溢出开新区）──
        if (method === 'POST' && path === '/world/season/join') {
          const body = await readJson(req);
          const season = Number(body.season);
          const x = Number(body.x);
          const y = Number(body.y);
          if (!Number.isFinite(season)) return sendErr(res, ErrorCode.BAD_REQUEST, 'season required');
          if (!Number.isFinite(x) || !Number.isFinite(y)) return sendErr(res, ErrorCode.BAD_REQUEST, 'x/y required');
          return send(res, 200, ok(await svc.joinSeason(season, accountId, x, y)));
        }

        // ── 进入世界 / 占领 / 放弃（S8-1，做实）──
        if (
          method === 'POST' &&
          (path === '/world/join' || path === '/world/occupy' || path === '/world/abandon' ||
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
          if (path === '/world/join') {
            return send(res, 200, ok(await svc.joinWorld(worldId, accountId, x, y)));
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

        // ── 行军（S8-2，做实）──
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

        // ── 扫荡（S8-3，§14.6 便捷别名 = march kind:'sweep'）──
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

        // ── 防守 config（S8-4 残留，做实）──
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

        // ── 进攻布阵模板（队伍，G3-2c）──
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

        // ── 训练队列（S8-2，做实）──
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

        // ── 围攻重播观战关卡（G3-2c，seed + 双方布阵，攻守双方可读）──
        {
          const m = /^\/world\/siege\/([^/]+)\/replay$/.exec(path);
          if (method === 'GET' && m) {
            const worldId = q.get('worldId');
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await svc.getSiegeReplay(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }


        // ── 家族（S8-4，做实）──────────────────────────────────────────
        if (method === 'GET' && path === '/family/list') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await familySvc.listFamilies(worldId)));
        }
        {
          const m = /^\/family\/([^/]+)$/.exec(path);
          if (method === 'GET' && m) {
            return send(res, 200, ok(await familySvc.getFamily(decodeURIComponent(m[1]!))));
          }
        }
        if (method === 'POST' && path === '/family/create') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const name = typeof body.name === 'string' ? body.name : null;
          const tag = typeof body.tag === 'string' ? body.tag : null;
          if (!worldId || !name || !tag) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + name + tag required');
          return send(res, 200, ok(await familySvc.createFamily(worldId, accountId, name, tag)));
        }
        if (method === 'POST' && path === '/family/join') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const familyId = typeof body.familyId === 'string' ? body.familyId : null;
          if (!worldId || !familyId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + familyId required');
          await familySvc.joinFamily(worldId, accountId, familyId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/family/leave') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          await familySvc.leaveFamily(worldId, accountId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/family/kick') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const targetId = typeof body.targetId === 'string' ? body.targetId : null;
          if (!worldId || !targetId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetId required');
          await familySvc.kickMember(worldId, accountId, targetId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/family/role') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const targetId = typeof body.targetId === 'string' ? body.targetId : null;
          const role = typeof body.role === 'string' ? body.role : null;
          if (!worldId || !targetId || !role) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + targetId + role required');
          await familySvc.setRole(worldId, accountId, targetId, role as import('@nw/shared').FamilyRole);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/family/dissolve') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          await familySvc.dissolveFamily(worldId, accountId);
          return send(res, 200, ok({}));
        }
        if (method === 'POST' && path === '/family/message') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const msgBody = typeof body.body === 'string' ? body.body : null;
          const senderName = typeof body.senderName === 'string' ? body.senderName : accountId;
          if (!worldId || !msgBody) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + body required');
          return send(res, 200, ok(await familySvc.sendMessage(worldId, accountId, senderName, msgBody)));
        }
        if (method === 'GET' && path === '/family/channel') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const before = q.get('before') ? Number(q.get('before')) : undefined;
          const limit = numQ(q.get('limit'), 30);
          return send(res, 200, ok(await familySvc.getChannel(worldId, accountId, before, limit)));
        }

        // ── 宗门（S8-4b，做实）────────────────────────────────────────
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

        // ── 拍卖（S8-5，做实）──────────────────────────────────────────
        if (method === 'GET' && path === '/auction/list') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const itemType = q.get('itemType') ?? undefined;
          const limit = numQ(q.get('limit'), 20);
          return send(res, 200, ok(await auctionSvc.listAuctions(worldId, itemType, limit)));
        }
        if (method === 'GET' && path === '/auction/mine') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          return send(res, 200, ok(await auctionSvc.getMyListings(worldId, accountId)));
        }
        if (method === 'POST' && path === '/auction/create') {
          const body = await readJson(req);
          const worldId = typeof body.worldId === 'string' ? body.worldId : null;
          const itemType = typeof body.itemType === 'string' ? body.itemType : null;
          const item = typeof body.item === 'object' && body.item && !Array.isArray(body.item) ? body.item as Record<string, unknown> : null;
          const qty = Number(body.qty);
          const durationSec = Number(body.durationSec);
          const designatedBuyerId = typeof body.designatedBuyerId === 'string' ? body.designatedBuyerId : undefined;
          const saleMode = body.saleMode === 'auction' ? 'auction' : 'fixed';
          if (!worldId || !itemType || !item || !Number.isFinite(qty) || !Number.isFinite(durationSec)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + itemType + item + qty + durationSec required');
          }
          // fixed → price 必填；auction → startPrice 必填，buyoutPrice 可选
          const price = body.price != null ? Number(body.price) : undefined;
          const startPrice = body.startPrice != null ? Number(body.startPrice) : undefined;
          const buyoutPrice = body.buyoutPrice != null ? Number(body.buyoutPrice) : undefined;
          if (saleMode === 'fixed' && !Number.isFinite(price ?? NaN)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'price required for fixed sale');
          }
          if (saleMode === 'auction' && !Number.isFinite(startPrice ?? NaN)) {
            return sendErr(res, ErrorCode.BAD_REQUEST, 'startPrice required for auction sale');
          }
          return send(res, 200, ok(await auctionSvc.createAuction({
            worldId, sellerId: accountId, itemType: itemType as 'material' | 'equipment',
            item, qty, durationSec, designatedBuyerId, saleMode,
            ...(price != null ? { price } : {}),
            ...(startPrice != null ? { startPrice } : {}),
            ...(buyoutPrice != null ? { buyoutPrice } : {}),
          })));
        }
        {
          const m = /^\/auction\/([^/]+)\/bid$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            const amount = Number(body.amount);
            if (!worldId || !Number.isFinite(amount)) {
              return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId + amount required');
            }
            return send(res, 200, ok(await auctionSvc.placeBid(worldId, accountId, decodeURIComponent(m[1]!), amount)));
          }
        }
        {
          const m = /^\/auction\/([^/]+)\/buy$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await auctionSvc.buyAuction(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }
        {
          const m = /^\/auction\/([^/]+)\/cancel$/.exec(path);
          if (method === 'POST' && m) {
            const body = await readJson(req);
            const worldId = typeof body.worldId === 'string' ? body.worldId : null;
            if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
            return send(res, 200, ok(await auctionSvc.cancelAuction(worldId, accountId, decodeURIComponent(m[1]!))));
          }
        }

        // ── 国家（S8-6.5，做实）──
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

        // ── 赛季（S8-7，做实）──
        if (method === 'GET' && path === '/world/season') {
          const worldId = q.get('worldId');
          if (!worldId) return sendErr(res, ErrorCode.BAD_REQUEST, 'worldId required');
          const season = await svc.getSeason(worldId);
          if (!season) return sendErr(res, ErrorCode.NOT_FOUND, '世界不存在');
          return send(res, 200, ok(season));
        }

        // ── SLG 商店（S8-8，做实）──
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

        // 赛季管理 /admin/world/* 已迁出 JWT 分支，改 X-Internal-Key（C4/§17.7，见上方内部分支）。
        // F 季末清算（拍卖行 clearWorldOnReset）已并入上方内部 /admin/world/reset 处理。

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
