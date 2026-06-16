// worldsvc 业务层（S8-0 骨架 + S8-1 占领）。
// S8-0：地图读取（程序化默认 + 稀疏 DB 覆盖合并）+ 玩家状态（资源惰性结算）。
// S8-1：进入世界（建主城 + 保护罩）、占领格子（写 TileDoc + 更新 yieldRate + 驻军扣兵）、
//        放弃格子（退还驻军 + 重算产率）。行军（旅行耗时）/ 围攻为 S8-2/S8-3，此处直占即生效。
import {
  proceduralTile,
  tileId,
  playerWorldId,
  tileYield,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  TROOP_CAP_BASE,
  GARRISON_PER_TILE,
  PROTECTION_SEC,
  SlgError,
  type TileType,
  type ResourceType,
} from '@nw/shared';
import type { WorldCollections, TileDoc, PlayerWorldDoc } from './db';
import type { WorldRedis } from './redis';

/** 视区单格视图（REST 响应；不泄露 accountId——`mine` 标识是否归请求者，他人身份[publicId]待 S8-1 后补）。 */
export interface WorldTileView {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** 是否已被任意玩家占领（中立/未占领=false 或缺省）。 */
  occupied?: boolean;
  /** 是否归请求者所有。 */
  mine?: boolean;
  familyId?: string;
  garrison?: number;
  protectedUntil?: number;
}

export interface WorldMapView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  tiles: WorldTileView[];
}

export interface PlayerWorldView {
  joined: boolean;
  troops?: number;
  troopCap?: number;
  resources?: Record<ResourceType, number>;
  yieldRate?: Record<ResourceType, number>;
  mainBaseTile?: string;
  territoryCount?: number;
  familyId?: string;
}

/** 视区半径上限（防一次拉太多格；P9 视区订阅模型规模化前的硬上限）。 */
const MAP_VIEW_MAX_RADIUS = 40;

export interface WorldServiceDeps {
  cols: WorldCollections;
  redis: WorldRedis | null;
  mapW: number;
  mapH: number;
  now: () => number;
}

const emptyResources = (): Record<ResourceType, number> => ({ food: 0, iron: 0, wood: 0 });

export class WorldService {
  constructor(private readonly deps: WorldServiceDeps) {}

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

  /** 视区格子：合并程序化默认（中立世界）与稀疏 DB 覆盖（被占领/改动的格）。§14.2。 */
  async getMap(
    worldId: string,
    accountId: string,
    cx: number,
    cy: number,
    r: number,
  ): Promise<WorldMapView> {
    const { cols, mapW, mapH } = this.deps;
    const rad = Math.max(0, Math.min(MAP_VIEW_MAX_RADIUS, Math.floor(r)));
    const x0 = Math.max(0, Math.floor(cx) - rad);
    const x1 = Math.min(mapW - 1, Math.floor(cx) + rad);
    const y0 = Math.max(0, Math.floor(cy) - rad);
    const y1 = Math.min(mapH - 1, Math.floor(cy) + rad);

    const overrides = await cols.tiles
      .find({ worldId, x: { $gte: x0, $lte: x1 }, y: { $gte: y0, $lte: y1 } })
      .toArray();
    const byKey = new Map(overrides.map((t) => [`${t.x}:${t.y}`, t]));

    const tiles: WorldTileView[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = byKey.get(`${x}:${y}`);
        tiles.push(o ? this.tileDocView(o, accountId) : this.proceduralView(worldId, x, y));
      }
    }
    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, tiles };
  }

  /** 单格详情。DB 覆盖优先，否则程序化默认。 */
  async getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const o = await this.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) });
    return o ? this.tileDocView(o, accountId) : this.proceduralView(worldId, x, y);
  }

  /** 玩家在世界的状态：资源惰性结算（读时按 yieldRate × dt 补算并封顶）。§14.3。 */
  async getMe(worldId: string, accountId: string): Promise<PlayerWorldView> {
    const doc = await this.deps.cols.playerWorld.findOne({
      _id: playerWorldId(worldId, accountId),
    });
    if (!doc) return { joined: false };
    const resources = this.settle(doc, this.deps.now());
    return {
      joined: true,
      troops: doc.troops,
      troopCap: doc.troopCap,
      resources,
      yieldRate: doc.yieldRate,
      territoryCount: await this.deps.cols.tiles.countDocuments({ worldId, ownerId: accountId }),
      ...(doc.mainBaseTile ? { mainBaseTile: doc.mainBaseTile } : {}),
      ...(doc.familyId ? { familyId: doc.familyId } : {}),
    };
  }

  // ── S8-1：进入世界 / 占领 / 放弃 ───────────────────────────

  /**
   * 进入世界：在 (x,y) 落主城。幂等（已进入直接返回当前状态，不二次落城）。
   * 校验：世界开放 + 未满员 + 坐标界内 + 目标格非世界中心 + 未被他人占领。
   * 落地：写 base TileDoc（带新手保护罩 PROTECTION_SEC）+ 建 playerWorld（满兵力 + 起步产率）。
   */
  async joinWorld(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const existing = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (existing) return this.getMe(worldId, accountId); // 幂等

    if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', '主城坐标越界');
    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心不可落城');

    const tid = tileId(worldId, x, y);
    const occ = await cols.tiles.findOne({ _id: tid });
    if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', '该格已被占领');

    // 容量守卫（仅在 world 文档存在时强制——dev 无 world 文档则不限）。
    const world = await cols.worlds.findOne({ _id: worldId });
    if (world) {
      if (world.status !== 'open' && world.status !== 'active') {
        throw new SlgError('WORLD_CLOSED', '世界未开放');
      }
      const inc = await cols.worlds.findOneAndUpdate(
        { _id: worldId, status: { $in: ['open', 'active'] }, $expr: { $lt: ['$population', '$capacity'] } },
        { $inc: { population: 1 } },
      );
      if (!inc) throw new SlgError('WORLD_FULL', '世界已满员');
    }

    const t = now();
    const yieldRate = this.yieldRecord([{ type: 'base', level: proc.level }]);
    const tileDoc: TileDoc = {
      _id: tid,
      worldId,
      x,
      y,
      type: 'base',
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison: GARRISON_PER_TILE,
      protectedUntil: t + PROTECTION_SEC * 1000,
      rev: 0,
    };
    await cols.tiles.updateOne({ _id: tid }, { $setOnInsert: tileDoc }, { upsert: true });

    const pw: PlayerWorldDoc = {
      _id: playerWorldId(worldId, accountId),
      worldId,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: emptyResources(),
      yieldRate,
      lastTickAt: t,
      mainBaseTile: tid,
      rev: 0,
    };
    await cols.playerWorld.insertOne(pw);
    return this.getMe(worldId, accountId);
  }

  /**
   * 占领格子（S8-1 直占，无行军旅行；S8-2 改走 march occupy）。
   * 校验：已进入 + 坐标界内 + 非中心 + 兵力够一队驻军 + 目标未被他人占领。
   * 落地：先结算资源 → 扣 GARRISON_PER_TILE 兵 → 写 territory TileDoc（保留资源种类）→ 重算 yieldRate。
   */
  async occupyTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
    if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', '坐标越界');

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心由宗门争夺，不可直占');

    const tid = tileId(worldId, x, y);
    const occ = await cols.tiles.findOne({ _id: tid });
    if (occ?.ownerId === accountId) return this.tileDocView(occ, accountId); // 幂等
    if (occ?.ownerId) {
      // 他人领地：S8-1 无围攻，受保护或一律拒绝（夺地走 S8-3 siege）。
      if (occ.protectedUntil && occ.protectedUntil > now()) {
        throw new SlgError('PROTECTED', '目标处于保护期');
      }
      throw new SlgError('TILE_OCCUPIED', '该格已被占领（夺地需围攻，S8-3）');
    }

    if (pw.troops < GARRISON_PER_TILE) throw new SlgError('NO_TROOPS', '兵力不足以驻守');

    const t = now();
    const resources = this.settle(pw, t);

    const resType = proc.resType;
    const tileDoc: TileDoc = {
      _id: tid,
      worldId,
      x,
      y,
      type: 'territory',
      level: proc.level,
      ...(resType ? { resType } : {}),
      ownerId: accountId,
      garrison: GARRISON_PER_TILE,
      rev: 0,
    };
    await cols.tiles.updateOne({ _id: tid }, { $set: tileDoc }, { upsert: true });

    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: -GARRISON_PER_TILE, rev: 1 },
      },
    );
    const after = await cols.tiles.findOne({ _id: tid });
    return this.tileDocView(after!, accountId);
  }

  /**
   * 放弃格子：退还驻军 + 重算产率。不可放弃主城。
   */
  async abandonTile(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');

    const tid = tileId(worldId, x, y);
    const tile = await cols.tiles.findOne({ _id: tid });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', '非己方领地');
    if (tile.type === 'base') throw new SlgError('TILE_NOT_OWNED', '主城不可放弃');

    const t = now();
    const resources = this.settle(pw, t);
    const refund = tile.garrison ?? 0;
    await cols.tiles.deleteOne({ _id: tid }); // 放弃 → 回归程序化中立（稀疏存储不留空壳）
    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: refund, rev: 1 },
      },
    );
    return this.getMe(worldId, accountId);
  }

  // ── 内部辅助 ─────────────────────────────────────────────

  /** 资源惰性结算：resources += yieldRate × dt(小时)，封顶 RESOURCE_CAP。 */
  private settle(doc: PlayerWorldDoc, now: number): Record<ResourceType, number> {
    const dtHours = Math.max(0, (now - doc.lastTickAt) / 3_600_000);
    const out = emptyResources();
    for (const rt of RESOURCE_TYPES) {
      const settled = (doc.resources[rt] ?? 0) + (doc.yieldRate[rt] ?? 0) * dtHours;
      out[rt] = Math.min(RESOURCE_CAP, Math.floor(settled));
    }
    return out;
  }

  /** 把一组 {type,level,resType} 累加成每小时产率记录。 */
  private yieldRecord(
    tiles: { type: TileType; level: number; resType?: ResourceType }[],
  ): Record<ResourceType, number> {
    const acc = emptyResources();
    for (const tl of tiles) {
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += y[rt] ?? 0;
    }
    return acc;
  }

  /** 从 DB 当前所有己方格子重算聚合产率（占领/放弃后调用）。 */
  private async recomputeYield(
    worldId: string,
    accountId: string,
  ): Promise<Record<ResourceType, number>> {
    const owned = await this.deps.cols.tiles.find({ worldId, ownerId: accountId }).toArray();
    return this.yieldRecord(owned);
  }

  private tileDocView(o: TileDoc, accountId: string): WorldTileView {
    return {
      x: o.x,
      y: o.y,
      type: o.type,
      level: o.level,
      ...(o.resType ? { resType: o.resType } : {}),
      ...(o.ownerId ? { occupied: true } : {}),
      ...(o.ownerId === accountId ? { mine: true } : {}),
      ...(o.familyId ? { familyId: o.familyId } : {}),
      ...(o.garrison ? { garrison: o.garrison } : {}),
      ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
    };
  }

  private proceduralView(worldId: string, x: number, y: number): WorldTileView {
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) };
  }
}
