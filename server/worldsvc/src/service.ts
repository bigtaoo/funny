// worldsvc 业务层（S8-0 骨架）。S8-0 落地：地图读取（程序化默认 + 稀疏 DB 覆盖合并）+ 玩家状态
// （资源惰性结算）。行军 / 占领 / 防守 / 围攻 / 家族 / 拍卖为 S8-1~5，此处仅留接口签名 stub。
import {
  proceduralTile,
  tileId,
  playerWorldId,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  type TileType,
  type ResourceType,
} from '@nw/shared';
import type { WorldCollections } from './db';
import type { WorldRedis } from './redis';

/** 视区单格视图（REST 响应；不泄露 accountId——owner 用 publicId，占领逻辑 S8-1 落地时填）。 */
export interface WorldTileView {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  owner?: string; // publicId（中立=undefined）
  familyId?: string;
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

export class WorldService {
  constructor(private readonly deps: WorldServiceDeps) {}

  /** 视区格子：合并程序化默认（中立世界）与稀疏 DB 覆盖（被占领/改动的格）。§14.2。 */
  async getMap(worldId: string, cx: number, cy: number, r: number): Promise<WorldMapView> {
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
        if (o) {
          tiles.push({
            x,
            y,
            type: o.type,
            level: o.level,
            ...(o.resType ? { resType: o.resType } : {}),
            ...(o.familyId ? { familyId: o.familyId } : {}),
            ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
            // owner publicId 由占领逻辑（S8-1）写入 TileDoc 后映射；骨架阶段无占领。
          });
        } else {
          const d = proceduralTile(worldId, x, y);
          tiles.push({
            x,
            y,
            type: d.type,
            level: d.level,
            ...(d.resType ? { resType: d.resType } : {}),
          });
        }
      }
    }
    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, tiles };
  }

  /** 单格详情。DB 覆盖优先，否则程序化默认。 */
  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    const o = await this.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) });
    if (o) {
      return {
        x,
        y,
        type: o.type,
        level: o.level,
        ...(o.resType ? { resType: o.resType } : {}),
        ...(o.familyId ? { familyId: o.familyId } : {}),
        ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
      };
    }
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) };
  }

  /** 玩家在世界的状态：资源惰性结算（读时按 yieldRate × dt 补算并封顶）。§14.3。 */
  async getMe(worldId: string, accountId: string): Promise<PlayerWorldView> {
    const doc = await this.deps.cols.playerWorld.findOne({
      _id: playerWorldId(worldId, accountId),
    });
    if (!doc) return { joined: false };
    const now = this.deps.now();
    const dtHours = Math.max(0, (now - doc.lastTickAt) / 3_600_000);
    const resources = { ...doc.resources } as Record<ResourceType, number>;
    for (const rt of RESOURCE_TYPES) {
      const settled = (resources[rt] ?? 0) + (doc.yieldRate[rt] ?? 0) * dtHours;
      resources[rt] = Math.min(RESOURCE_CAP, Math.floor(settled));
    }
    return {
      joined: true,
      troops: doc.troops,
      troopCap: doc.troopCap,
      resources,
      yieldRate: doc.yieldRate,
      ...(doc.mainBaseTile ? { mainBaseTile: doc.mainBaseTile } : {}),
      ...(doc.familyId ? { familyId: doc.familyId } : {}),
    };
  }

  // ── S8-1~5 stub（占位，REST 层返回 NOT_IMPLEMENTED）──────────
  // 行军：POST /world/march、/world/march/{id}/recall、/world/sweep（S8-2）
  // 占领/防守：PUT /world/defense、占领写 TileDoc + 更新 yieldRate（S8-1）
  // 兵力：POST /world/troops/train、/speedup（S8-2）
  // 家族：/family/*（S8-4）  拍卖：/auction/*（S8-5）  围攻复算（S8-3）
}
