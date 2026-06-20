// worldsvc 业务层（S8-0 骨架 + S8-1 占领）。
// S8-0：地图读取（程序化默认 + 稀疏 DB 覆盖合并）+ 玩家状态（资源惰性结算）。
// S8-1：进入世界（建主城 + 保护罩）、占领格子（写 TileDoc + 更新 yieldRate + 驻军扣兵）、
//        放弃格子（退还驻军 + 重算产率）。行军（旅行耗时）/ 围攻为 S8-2/S8-3，此处直占即生效。
import {
  proceduralTile,
  tileId,
  marchId,
  siegeId,
  playerWorldId,
  tileYield,
  resolveSiege,
  siegeSeedFromId,
  buildSiegeLevel,
  npcGarrison,
  findMarchPath,
  marchDurationFromPath,
  capitalPositions,
  capitalIdxAt,
  nearestCapitalIdx,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  TROOP_CAP_BASE,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  PROTECTION_SEC,
  TROOP_TRAIN_FOOD_COST,
  TROOP_TRAIN_TIME_SEC,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_TRAIN_QUEUE_MAX,
  TROOP_SPEEDUP_SECS_PER_COIN,
  NATION_BONUS_PRODUCTION,
  nationDefenseStrength,
  SECT_LEADER_PENALTY_RATE,
  RELOCATE_COST,
  SLG_SHOP_ITEMS,
  CAPITAL_FRACTIONS,
  SlgError,
  type PathCell,
  type TileType,
  type ResourceType,
  type MarchKind,
  type SiegeOutcome,
  type SiegeResolution,
} from '@nw/shared';
import type { WorldCollections, TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, NationDoc, TrainingEntry } from './db';
import type { WorldRedis } from './redis';
import { nullWorldGatewayClient, type WorldGatewayClient, type WorldJudgeArgs } from './gatewayClient';
import { nullWorldMetaClient, type WorldMetaClient, type PlayerProfile } from './metaClient';
import { nullWorldCommercialClient, type WorldCommercialClient } from './commercialClient';

/** 视区单格视图（REST 响应）。`mine` 标识是否归请求者；`ownerPublicId`/`ownerName` 为他人领地昵称（需 meta 可用）。 */
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
  /** 他人领地：占领者 9 位公开 id（meta 可用时填充）。 */
  ownerPublicId?: string;
  /** 他人领地：占领者昵称（meta 可用时填充）。 */
  ownerName?: string;
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
  /** 训练队列（S8-2，按 completeAt 升序）；客户端 C4 据此渲染倒计时。 */
  trainingQueue?: { qty: number; startAt: number; completeAt: number }[];
}

/** 行军视图（REST 响应 / push 载荷源）。 */
export interface MarchView {
  marchId: string;
  kind: MarchKind;
  fromTile: string;
  toTile: string;
  troops: number;
  departAt: number;
  arriveAt: number;
  status: MarchDoc['status'];
}

/** 视区半径上限（防一次拉太多格；P9 视区订阅模型规模化前的硬上限）。 */
const MAP_VIEW_MAX_RADIUS = 40;

export interface WorldServiceDeps {
  cols: WorldCollections;
  redis: WorldRedis | null;
  mapW: number;
  mapH: number;
  now: () => number;
  /** 实时事件推送（march_update/tile_update）；缺省 = 无 gateway，push no-op（REST 轮询）。 */
  gateway?: WorldGatewayClient;
  /** 解析玩家档案（publicId/displayName）；缺省 = 不填充昵称。 */
  meta?: WorldMetaClient;
  /** 金币扣费（训练加速/SLG 商店）；缺省 = 金币操作不可用。 */
  commercial?: WorldCommercialClient;
}

const emptyResources = (): Record<ResourceType, number> => ({ food: 0, iron: 0, wood: 0 });

/** 出征许可的玩家面 kind（return 仅内部撤军腿，禁止外部直接发起）。 */
const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep']);

export class WorldService {
  private readonly gateway: WorldGatewayClient;
  private readonly meta: WorldMetaClient;
  private readonly commercial: WorldCommercialClient;
  /** 进程内单调序号，保证同毫秒多次出征 marchId 不撞键。 */
  private marchSeq = 0;
  /** 进程内单调序号，保证同毫秒多次围攻 siegeId 不撞键。 */
  private siegeSeq = 0;
  /** 缓存当前 mapW/mapH 派生的首府坐标列表（懒初始化）。 */
  private _capitals: [number, number][] | null = null;

  constructor(private readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
  }

  private get capitals(): [number, number][] {
    if (!this._capitals) {
      this._capitals = capitalPositions(this.deps.mapW, this.deps.mapH);
    }
    return this._capitals;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

  /**
   * A* 行军寻路：预取所有已占领关隘格，组装 passableGateKeys，再调 findMarchPath。
   * 关隘通行规则（S8-4）：己方占领的关隘 + 同一家族成员占领的关隘均可通行
   * （盟友宗门通行 S8-4+ 联盟系统 pending，当前仅己方家族内互通）。
   * 无路 → throw PATH_BLOCKED (HTTP 400)。
   */
  private async computeMarchPath(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    requesterId: string,
  ): Promise<PathCell[]> {
    // 取请求者当前家族（如果有），同族成员占领的关隘也视为可通行。
    const memDoc = await this.deps.cols.familyMembers.findOne({
      _id: `${worldId}:${requesterId}`,
    });
    const allyFamilyId = memDoc?.familyId;

    // 关隘稀疏（全图 ~20-40 个）；一次性取出再过滤，避免 A* 内异步。
    const gateTiles = await this.deps.cols.tiles
      .find({ worldId, type: 'gate' })
      .project<{ _id: string; x: number; y: number; ownerId: string | undefined; familyId: string | undefined }>({
        _id: 1, x: 1, y: 1, ownerId: 1, familyId: 1,
      })
      .toArray();
    const passableGateKeys = new Set<string>(
      gateTiles
        .filter((g) =>
          g.ownerId === requesterId ||
          (allyFamilyId && g.familyId === allyFamilyId),
        )
        .map((g) => `${g.x}:${g.y}`),
    );
    const path = findMarchPath(
      worldId,
      this.deps.mapW,
      this.deps.mapH,
      fromX,
      fromY,
      toX,
      toY,
      passableGateKeys,
    );
    if (!path) throw new SlgError('PATH_BLOCKED', '找不到可行路径');
    return path;
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

    // 批量解析他人领地昵称（去重 + Promise.allSettled，meta 不可用时降级为空 Map）
    const otherOwnerIds = [...new Set(
      overrides.filter((o) => o.ownerId && o.ownerId !== accountId).map((o) => o.ownerId!),
    )];
    const profileMap = new Map<string, PlayerProfile>();
    if (otherOwnerIds.length > 0 && this.meta.available) {
      const results = await Promise.allSettled(
        otherOwnerIds.map((id) => this.meta.getProfile(id).then((p) => ({ id, p }))),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.p) profileMap.set(r.value.id, r.value.p);
      }
    }

    const tiles: WorldTileView[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = byKey.get(`${x}:${y}`);
        const ownerProfile = (o?.ownerId && o.ownerId !== accountId)
          ? profileMap.get(o.ownerId) : undefined;
        tiles.push(o ? this.tileDocView(o, accountId, ownerProfile) : this.proceduralView(worldId, x, y));
      }
    }
    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, tiles };
  }

  /** 单格详情。DB 覆盖优先，否则程序化默认。 */
  async getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const o = await this.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) });
    if (!o) return this.proceduralView(worldId, x, y);
    const ownerProfile = (o.ownerId && o.ownerId !== accountId && this.meta.available)
      ? await this.meta.getProfile(o.ownerId).catch(() => null) : undefined;
    return this.tileDocView(o, accountId, ownerProfile ?? undefined);
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
      ...(doc.trainingQueue && doc.trainingQueue.length > 0
        ? { trainingQueue: doc.trainingQueue.map((e) => ({ qty: e.qty, startAt: e.startAt, completeAt: e.completeAt })) }
        : {}),
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
    if (proc.type === 'obstacle' || proc.type === 'gate') throw new SlgError('BAD_REQUEST', '障碍/关隘不可落城');

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
    if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', '阻挡地形不可占领');

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

  /**
   * 主动迁城（§3.4 / §8.2，所有玩家通用）：花 RELOCATE_COST 金币把主城迁到自选的合法空格。
   * 校验：已进入 + 目标界内 + 非中心/障碍/关隘 + 未被任何人占领。保留全部领地（仅被动迁城失地）。
   * 落地：扣币 → 删旧 base 格 → 在新址写 base 格（沿用旧城驻军与剩余保护罩）→ 改 mainBaseTile + 重算产率。
   */
  async relocateBase(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw || !pw.mainBaseTile) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
    if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', '迁城坐标越界');

    const newTid = tileId(worldId, x, y);
    if (newTid === pw.mainBaseTile) return this.getMe(worldId, accountId); // 原地迁城 = no-op，不扣费

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心不可落城');
    if (proc.type === 'obstacle' || proc.type === 'gate') throw new SlgError('BAD_REQUEST', '障碍/关隘不可落城');
    const occ = await cols.tiles.findOne({ _id: newTid });
    if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', '该格已被占领');

    // 先扣金币（失败抛 INSUFFICIENT_FUNDS，不动地图）。
    const orderId = `slg_relocate:${worldId}:${accountId}:${now()}`;
    await this.commercial.spend(accountId, RELOCATE_COST, orderId);

    const t = now();
    const oldBase = await cols.tiles.findOne({ _id: pw.mainBaseTile });
    const carryGarrison = oldBase?.garrison ?? GARRISON_PER_TILE;
    const carryProtect = oldBase?.protectedUntil; // 沿用旧城剩余保护罩（自愿迁城不额外续）
    await cols.tiles.deleteOne({ _id: pw.mainBaseTile });

    const tileDoc: TileDoc = {
      _id: newTid,
      worldId,
      x,
      y,
      type: 'base',
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison: carryGarrison,
      ...(carryProtect ? { protectedUntil: carryProtect } : {}),
      rev: 0,
    };
    await cols.tiles.updateOne({ _id: newTid }, { $set: tileDoc }, { upsert: true });

    const resources = this.settle(pw, t);
    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );

    // 推新旧两格变更（旧址回归中立、新址主城）。
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) void this.pushTile(accountId, after);
    return this.getMe(worldId, accountId);
  }

  // ── S8-2：行军 / 撤军 / 到点处理 ──────────────────────────

  /**
   * 发起行军（occupy / reinforce；attack/sweep=围攻 S8-3）。出征**即从兵力池扣兵**（在途），
   * 到达时按 kind 落地（占领写 TileDoc / 增援加 garrison）；失败或撤军时退回兵力池。
   * 校验（出征时刻）：已进入 + kind 合法 + from/to 界内 + from 是己方格 + 兵力够 +
   *   occupy 目标为空闲格(非中心/未被占) 且带兵 ≥ OCCUPY_MIN_TROOPS / reinforce 目标为己方格。
   */
  async startMarch(
    worldId: string,
    accountId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: MarchKind,
    troops: number,
  ): Promise<MarchView> {
    const { cols, now } = this.deps;
    if (!MARCHABLE_KINDS.has(kind)) {
      throw new SlgError('NOT_IMPLEMENTED', `行军类型 ${kind} 未实现（围攻 S8-3）`);
    }
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
    if (!this.inBounds(fromX, fromY) || !this.inBounds(toX, toY)) {
      throw new SlgError('OUT_OF_RANGE', '坐标越界');
    }
    if (!Number.isFinite(troops) || troops < MARCH_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', '出征兵力无效');
    }
    troops = Math.floor(troops);
    if (kind === 'occupy' && troops < OCCUPY_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', `占领至少需带 ${OCCUPY_MIN_TROOPS} 兵`);
    }

    const fromTid = tileId(worldId, fromX, fromY);
    const fromTile = await cols.tiles.findOne({ _id: fromTid });
    if (!fromTile || fromTile.ownerId !== accountId) {
      throw new SlgError('TILE_NOT_OWNED', '只能从己方格出征');
    }

    // 目标格出征时校验（到达时会再校验一次，状态可能已变）。
    const toTid = tileId(worldId, toX, toY);
    const proc = proceduralTile(worldId, toX, toY);
    if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', '阻挡地形不可进军');
    const toTile = await cols.tiles.findOne({ _id: toTid });
    let defenderId: string | undefined; // attack：被攻击方 accountId（出征即推 under_attack 预警）
    if (kind === 'occupy') {
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心不可直占');
      if (toTile?.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', '该格已是己方领地（用增援）');
      if (toTile?.ownerId) {
        if (toTile.protectedUntil && toTile.protectedUntil > now()) {
          throw new SlgError('PROTECTED', '目标处于保护期');
        }
        throw new SlgError('TILE_OCCUPIED', '该格已被占领（夺地需围攻 attack）');
      }
    } else if (kind === 'reinforce') {
      if (!toTile || toTile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', '只能增援己方格');
    } else if (kind === 'attack') {
      // 围攻：目标必须是他人领地/主城（中立无主格请用占领/扫荡）。
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心由宗门争夺，不可围攻');
      if (!toTile?.ownerId) throw new SlgError('TILE_NOT_OWNED', '围攻目标无主（用占领/扫荡）');
      if (toTile.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', '不能围攻己方领地');
      if (toTile.protectedUntil && toTile.protectedUntil > now()) {
        throw new SlgError('PROTECTED', '目标处于保护期');
      }
      if (troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `围攻至少需带 ${OCCUPY_MIN_TROOPS} 兵`);
      defenderId = toTile.ownerId;
    } else {
      // sweep：清中立 / 资源格的 NPC 守军（不占地，回师带回缴获）。
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', '世界中心不可扫荡');
      if (toTile?.ownerId) throw new SlgError('TILE_OCCUPIED', '目标已被占领（夺地用围攻 attack）');
    }

    const t = now();
    const resources = this.settle(pw, t);
    if (pw.troops < troops) throw new SlgError('NO_TROOPS', '兵力不足');

    const path = await this.computeMarchPath(worldId, fromX, fromY, toX, toY, accountId);
    const departAt = t;
    const arriveAt = departAt + marchDurationFromPath(path) * 1000;
    const mid = marchId(worldId, accountId, departAt, ++this.marchSeq);
    const doc: MarchDoc = {
      _id: mid,
      worldId,
      ownerId: accountId,
      fromTile: fromTid,
      toTile: toTid,
      kind,
      troops,
      departAt,
      arriveAt,
      status: 'marching',
      rev: 0,
    };
    await cols.marches.insertOne(doc);
    // 出征扣兵（在途，不在池中）。
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
    );
    await this.scheduleMarch(worldId, mid, arriveAt);
    const view = this.marchView(doc);
    void this.pushMarch(accountId, view);
    // 围攻：出征即向防守方推预警（§5 / §14.5）。attackerName/publicId 暂用 accountId，
    // publicId 解析（meta /internal/profile）待后补——与 S8-1/2 owner 标识 todo 一致。
    if (kind === 'attack' && defenderId) {
      void this.gateway.push(defenderId, {
        kind: 'under_attack',
        tile: toTid,
        attackerName: accountId,
        attackerPublicId: '',
        arriveAt,
        troopsHint: troops,
      });
    }
    return view;
  }

  /**
   * 撤军：把在途的去程行军翻转为返程腿（troops 原路返回出发格再退回兵力池）。
   * 返程耗时 = 已走时长（min(已耗时, 总耗时)）。到达返程后退兵。已到达/已撤 → MARCH_NOT_FOUND。
   */
  async recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    const { cols, now } = this.deps;
    const m = await cols.marches.findOne({ _id: mid, worldId, ownerId: accountId });
    if (!m || m.status !== 'marching' || m.kind === 'return') {
      throw new SlgError('MARCH_NOT_FOUND', '行军不存在或不可撤');
    }
    const t = now();
    const total = m.arriveAt - m.departAt;
    const traveled = Math.max(0, Math.min(t - m.departAt, total));
    const backArrive = t + traveled;
    // 原子认领（防与到点处理竞态）：仍处 marching 的去程才翻转为返程。
    const claimed = await cols.marches.findOneAndUpdate(
      { _id: mid, status: 'marching', kind: { $ne: 'return' } },
      {
        $set: {
          kind: 'return',
          fromTile: m.toTile,
          toTile: m.fromTile,
          departAt: t,
          arriveAt: backArrive,
        },
        $inc: { rev: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw new SlgError('MARCH_NOT_FOUND', '行军已到达或已撤');
    await this.scheduleMarch(worldId, mid, backArrive); // 同 member 改 score
    const view = this.marchView(claimed);
    void this.pushMarch(accountId, view);
    return view;
  }

  /** 玩家当前世界所有在途行军列表（scheduler 到点删档，查到的均为未到达行军）。 */
  async getMarches(worldId: string, accountId: string): Promise<MarchView[]> {
    const docs = await this.deps.cols.marches
      .find({ worldId, ownerId: accountId })
      .sort({ arriveAt: 1 })
      .toArray();
    return docs.map((d) => ({
      marchId: d._id,
      kind: d.kind,
      fromTile: d.fromTile,
      toTile: d.toTile,
      troops: d.troops,
      departAt: d.departAt,
      arriveAt: d.arriveAt,
      status: d.status,
    }));
  }

  /**
   * 到点处理：扫描所有 arriveAt ≤ now 的在途行军，原子认领（findOneAndDelete）后按 kind 落地。
   * 以 Mongo `arriveAt` 索引扫描为权威（跨世界、无 Redis 也正确）；Redis ZSET 仅作精确唤醒提示
   * （scheduleMarch 维护，§14.4）。返回处理条数。worldsvc 单点消费（U12，前期单进程可接受）。
   */
  async processDueArrivals(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    const due = await cols.marches
      .find({ status: 'marching', arriveAt: { $lte: t } })
      .limit(500)
      .toArray();
    let n = 0;
    for (const m of due) {
      // 原子认领 + 移除（到达即消费瞬态文档）；输给撤军/并发处理者则跳过。
      const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
      if (!claimed) continue;
      await this.unscheduleMarch(claimed.worldId, claimed._id);
      await this.applyArrival(claimed, t);
      n++;
    }
    return n;
  }

  /** 落地单个到达的行军（已从 marches 删除）。 */
  private async applyArrival(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
    if (!pw) return; // 玩家状态丢失（不应发生）；兵力随之失，安全退出。

    if (m.kind === 'return') {
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }

    if (m.kind === 'attack') {
      await this.applySiege(m, pw, t);
      return;
    }

    if (m.kind === 'sweep') {
      await this.applySweep(m, pw, t);
      return;
    }

    if (m.kind === 'occupy') {
      const proc = proceduralTile(m.worldId, this.coordX(m.toTile), this.coordY(m.toTile));
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      const blocked =
        proc.type === 'center' ||
        (occ?.ownerId && occ.ownerId !== m.ownerId) ||
        (occ?.ownerId === m.ownerId && occ.type !== 'base'); // 已是己方领地（base 例外不会走到这）
      if (blocked) {
        // 到达时目标已被占/不可占 → 兵力即时退回池（S8-3 可改返程撤退）。
        await this.refundTroops(pw, m.troops, t);
        void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
        return;
      }
      const x = this.coordX(m.toTile);
      const y = this.coordY(m.toTile);
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: 'territory',
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        ownerId: m.ownerId,
        garrison: m.troops,
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
      // 兵力已在出征时扣除 → 不再动 pool，只更产率。
      const resources = this.settle(pw, t);
      const yieldRate = await this.recomputeYield(m.worldId, m.ownerId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
      );
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
      void this.pushTile(m.ownerId, tileDoc);
      // 首府格占领 → 触发立国（S8-6.5）
      const pwMem = await this.deps.cols.familyMembers.findOne({ _id: `${m.worldId}:${m.ownerId}` });
      void this.applyNationChange(m.worldId, x, y, m.ownerId, pwMem?.familyId);
      return;
    }

    // reinforce
    const target = await cols.tiles.findOne({ _id: m.toTile });
    if (!target || target.ownerId !== m.ownerId) {
      // 增援目标已非己方（被夺/放弃）→ 退兵。
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }
    await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) void this.pushTile(m.ownerId, after);
  }

  // ── S8-3：围攻 / 扫荡到点结算（廉价数值，§5.3；关键战斗的引擎复算 S8-3b 接 judge）──

  /**
   * 围攻他人领地/主城（attack 到点）。到达时重校验目标仍为敌方且未受保护，否则退兵。
   * 廉价线性结算 resolveSiege(攻方兵, 守军)：
   *   - attacker_win + territory → 领地易主（survivors 成新驻军）+ 掠夺败方资源 + 双方产率重算；
   *   - attacker_win + base      → 主城不可夺：守军清零 + 给败方上保护罩 + 掠夺 + 攻方生还回师退兵池；
   *   - defender_win             → 攻方committed 兵全灭（出征已扣，不回池）+ 守军减员。
   */
  private async applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const target = await cols.tiles.findOne({ _id: m.toTile });
    // 到达时目标已非敌方（被弃/已转己方/无主）或进入保护期 → 视作扑空，退兵回师。
    if (
      !target?.ownerId ||
      target.ownerId === m.ownerId ||
      (target.protectedUntil && target.protectedUntil > t)
    ) {
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const defenderId = target.ownerId;
    // 国民防御加成（§2.4 / G1）：守军处于「自己占领首府的 Voronoi 区」内 → 有效守军强度抬高。
    const capIdx = nearestCapitalIdx(target.x, target.y, this.capitals);
    const nation = await cols.nations.findOne({ _id: `nation:${m.worldId}:${capIdx}` });
    const inOwnNation = !!nation?.ownerId && nation.ownerId === defenderId;
    const res = resolveSiege(m.troops, nationDefenseStrength(target.garrison ?? 0, inOwnNation));
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defenderId) });
    await this.landSiege(m, pw, target, defenderId, defender, res, t);
  }

  /**
   * 落地一次围攻结算（G3-1 抽取，§16.4）：按 res 写易主/掠夺/驻军/立国/被动迁城（attacker_win）
   * 或守军减员（defender_win）+ 记 SiegeDoc + 推送 march/siege/tile。
   * 当前 `applySiege` 即时调用（廉价结算路径不变）；G3-2 延迟落地后，judge 复算确认 / 超时兜底
   * 两路将共用此唯一落地点。
   */
  private async landSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    target: TileDoc,
    defenderId: string,
    defender: PlayerWorldDoc | null,
    res: SiegeResolution,
    t: number,
  ): Promise<void> {
    const { cols } = this.deps;
    let loot = emptyResources();

    if (res.outcome === 'attacker_win') {
      // 掠夺败方资源（按比例从守方搬到攻方）。
      if (defender) loot = await this.transferLoot(defender, pw, t);

      if (target.type === 'base') {
        // 主城不可永久夺取，但被攻破 → 被动迁城（§3.4/§8.2，所有玩家通用）：
        //   1) 攻方生还回师退兵池；2) 若守方是门主，全宗门成员资源 -50%（§8.2 重大惩罚）；
        //   3) 守方主城随机迁到新空格 + 失去当前占领的所有领地（passiveRelocate）。
        await this.refundTroops(pw, res.attackerSurvivors, t);
        await this.applySectLeaderPenalty(m.worldId, defenderId, t);
        await this.passiveRelocate(m.worldId, defenderId, t);
      } else {
        // 领地易主：survivors 成新驻军（出征已扣兵，不再动攻方池），双方产率重算。
        await cols.tiles.updateOne(
          { _id: m.toTile },
          {
            $set: { type: 'territory', ownerId: m.ownerId, garrison: res.attackerSurvivors },
            $unset: { protectedUntil: '' },
            $inc: { rev: 1 },
          },
        );
        const atkYield = await this.recomputeYield(m.worldId, m.ownerId);
        await cols.playerWorld.updateOne(
          { _id: pw._id },
          { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } },
        );
        const defYield = await this.recomputeYield(m.worldId, defenderId);
        await cols.playerWorld.updateOne(
          { _id: playerWorldId(m.worldId, defenderId) },
          { $set: { yieldRate: defYield }, $inc: { rev: 1 } },
        );
        // 首府格被夺 → 立国易主（S8-6.5）
        const atkMem = await cols.familyMembers.findOne({ _id: `${m.worldId}:${m.ownerId}` });
        void this.applyNationChange(m.worldId, target.x, target.y, m.ownerId, atkMem?.familyId);
      }
    } else {
      // 守方胜：守军减员到 survivors；攻方 committed 兵全灭（出征已扣，无回师）。
      await cols.tiles.updateOne(
        { _id: m.toTile },
        { $set: { garrison: res.defenderSurvivors }, $inc: { rev: 1 } },
      );
    }

    const siege = await this.recordSiege(m, defenderId, res.outcome, t);
    const lootStr = lootSummary(loot);
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    void this.pushSiege(m.ownerId, siege, lootStr);
    void this.pushSiege(defenderId, siege, lootStr);
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) {
      void this.pushTile(m.ownerId, after);
      void this.pushTile(defenderId, after);
    }
  }

  /**
   * 扫荡中立 / 资源格的 NPC 守军（sweep 到点）。不占地：得手缴获资源 + 生还回师退兵池，
   * 失手则攻方兵力损耗（生还回池，可能为 0）。到达时若该格已被某玩家占领 → 退兵（扑空）。
   */
  private async applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      // 已被占领（应走 attack）→ 扑空退兵。
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }
    const proc = proceduralTile(m.worldId, this.coordX(m.toTile), this.coordY(m.toTile));
    const res = resolveSiege(m.troops, npcGarrison(proc.level));
    let loot = emptyResources();
    if (res.outcome === 'attacker_win') {
      const rt: ResourceType = proc.resType ?? 'food';
      loot = emptyResources();
      loot[rt] = SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level);
    }
    // 生还回师（缴获并入攻方资源，封顶）。
    await this.refundTroops(pw, res.attackerSurvivors, t, loot);
    const siege = await this.recordSiege(m, undefined, res.outcome, t);
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    void this.pushSiege(m.ownerId, siege, lootSummary(loot));
  }

  /** 写一条围攻战报（瞬态记录，§14.3 sieges）。replayRef 留空（S8-3b judge 复算后填）。 */
  private async recordSiege(
    m: MarchDoc,
    defenderId: string | undefined,
    outcome: SiegeOutcome,
    t: number,
  ): Promise<SiegeDoc> {
    const doc: SiegeDoc = {
      _id: siegeId(m.worldId, m.ownerId, t, ++this.siegeSeq),
      worldId: m.worldId,
      attackerId: m.ownerId,
      ...(defenderId ? { defenderId } : {}),
      tile: m.toTile,
      outcome,
      recomputed: false,
      ts: t,
    };
    await this.deps.cols.sieges.insertOne(doc);
    return doc;
  }

  /** 从败方搬走 SIEGE_LOOT_RATE 比例的资源到攻方（双方均结算 + 封顶）。返回实际掠得量。 */
  private async transferLoot(
    defender: PlayerWorldDoc,
    attacker: PlayerWorldDoc,
    t: number,
  ): Promise<Record<ResourceType, number>> {
    const defRes = this.settle(defender, t);
    const loot = emptyResources();
    for (const rt of RESOURCE_TYPES) loot[rt] = Math.floor((defRes[rt] ?? 0) * SIEGE_LOOT_RATE);
    const defAfter = emptyResources();
    for (const rt of RESOURCE_TYPES) defAfter[rt] = Math.max(0, (defRes[rt] ?? 0) - loot[rt]);
    await this.deps.cols.playerWorld.updateOne(
      { _id: defender._id },
      { $set: { resources: defAfter, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // 攻方收入掠夺（结算自身产出后并入，封顶）。
    const atkRes = this.settle(attacker, t);
    for (const rt of RESOURCE_TYPES) atkRes[rt] = Math.min(RESOURCE_CAP, (atkRes[rt] ?? 0) + loot[rt]);
    await this.deps.cols.playerWorld.updateOne(
      { _id: attacker._id },
      { $set: { resources: atkRes, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // attacker 内存副本同步，供同一次结算后续不重复 settle 时一致（此处之后不再读 attacker）。
    attacker.resources = atkRes;
    attacker.lastTickAt = t;
    return loot;
  }

  /** 退兵回池（封顶 troopCap）+ 结算资源；可选并入缴获 loot（封顶 RESOURCE_CAP）。 */
  private async refundTroops(
    pw: PlayerWorldDoc,
    troops: number,
    t: number,
    loot?: Record<ResourceType, number>,
  ): Promise<void> {
    const resources = this.settle(pw, t);
    if (loot) {
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + (loot[rt] ?? 0));
      }
    }
    const next = Math.min(pw.troopCap, pw.troops + troops);
    await this.deps.cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, troops: next, lastTickAt: t }, $inc: { rev: 1 } },
    );
  }

  /**
   * 门主主城被攻破惩罚（§8.2）：若 defenderId 是某宗门门主，全宗门成员当前资源 × (1-RATE)。
   * 逐成员结算后扣减（大规模写，U13 标注的原子性风险——前期单进程可接受，规模化再分批/事务）。
   * 非门主 / 无宗门 → no-op。
   */
  private async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.deps;
    const mem = await cols.familyMembers.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!mem) return;
    const fam = await cols.families.findOne({ _id: mem.familyId });
    if (!fam?.sectId) return;
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (!sect || sect.leaderId !== defenderId) return; // 仅门主被破触发

    const memberFamilies = await cols.families.find({ sectId: sect._id }).project<{ _id: string }>({ _id: 1 }).toArray();
    const famIds = memberFamilies.map((f) => f._id);
    if (famIds.length === 0) return;
    const members = await cols.familyMembers.find({ familyId: { $in: famIds } }).toArray();
    const keep = 1 - SECT_LEADER_PENALTY_RATE;
    for (const mm of members) {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, mm.accountId) });
      if (!pw) continue;
      const resources = this.settle(pw, t);
      for (const rt of RESOURCE_TYPES) resources[rt] = Math.floor((resources[rt] ?? 0) * keep);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }
  }

  /**
   * 被动迁城（§3.4/§8.2）：主城被攻破后，守方主城随机迁到新空格，且**失去当前占领的所有领地**。
   * 删掉该玩家全部己方格（旧主城 + 领地）→ 随机选合法空格写新主城（上保护罩）→ 改 mainBaseTile +
   * 重算产率（此时仅剩新主城）。不退还领地驻军（失地即损耗，强惩罚）。
   */
  private async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!pw) return;

    // 失地：删除该玩家全部己方格（旧主城 + 全部领地），回归程序化中立。
    await cols.tiles.deleteMany({ worldId, ownerId: defenderId });

    // 随机落新主城（找一个合法空格）。极端找不到 → 放弃迁城（仅失地，下次仍可主动迁）。
    const spot = await this.pickRandomEmptyTile(worldId);
    if (!spot) {
      const yieldRate = await this.recomputeYield(worldId, defenderId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { yieldRate, lastTickAt: t }, $unset: { mainBaseTile: '' }, $inc: { rev: 1 } },
      );
      return;
    }

    const newTid = tileId(worldId, spot.x, spot.y);
    const tileDoc: TileDoc = {
      _id: newTid,
      worldId,
      x: spot.x,
      y: spot.y,
      type: 'base',
      level: spot.level,
      ...(spot.resType ? { resType: spot.resType } : {}),
      ownerId: defenderId,
      garrison: 0,
      protectedUntil: t + PROTECTION_SEC * 1000, // 迁往安全：上保护罩
      rev: 0,
    };
    await cols.tiles.updateOne({ _id: newTid }, { $set: tileDoc }, { upsert: true });

    const yieldRate = await this.recomputeYield(worldId, defenderId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) void this.pushTile(defenderId, after);
  }

  /**
   * 随机挑一个合法空格（界内、非中心/障碍/关隘、无人占领）。被动迁城落点用。
   * 服务端权威随机（非回放路径，Math.random 安全），最多试若干次，找不到返回 null。
   */
  private async pickRandomEmptyTile(
    worldId: string,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { cols, mapW, mapH } = this.deps;
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(Math.random() * mapW);
      const y = Math.floor(Math.random() * mapH);
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'gate') continue;
      const occ = await cols.tiles.findOne({ _id: tileId(worldId, x, y) });
      if (occ?.ownerId) continue;
      return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
    }
    return null;
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
    // 国民产出加成（§2.4 / G1）：该玩家占领的首府 → 这些首府 Voronoi 区内的己方格享 +NATION_BONUS_PRODUCTION。
    const ownedNations = await this.deps.cols.nations.find({ worldId, ownerId: accountId }).toArray();
    const ownedCapIdx = new Set(ownedNations.map((n) => n.capitalIdx));
    if (ownedCapIdx.size === 0) return this.yieldRecord(owned);
    const acc = emptyResources();
    for (const tl of owned) {
      const inOwnNation = ownedCapIdx.has(nearestCapitalIdx(tl.x, tl.y, this.capitals));
      const mult = inOwnNation ? 1 + NATION_BONUS_PRODUCTION : 1;
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += (y[rt] ?? 0) * mult;
    }
    for (const rt of RESOURCE_TYPES) acc[rt] = Math.floor(acc[rt]);
    return acc;
  }

  private tileDocView(o: TileDoc, accountId: string, ownerProfile?: PlayerProfile): WorldTileView {
    return {
      x: o.x,
      y: o.y,
      type: o.type,
      level: o.level,
      ...(o.resType ? { resType: o.resType } : {}),
      ...(o.ownerId ? { occupied: true } : {}),
      ...(o.ownerId === accountId ? { mine: true } : {}),
      ...(ownerProfile?.publicId ? { ownerPublicId: ownerProfile.publicId } : {}),
      ...(ownerProfile?.displayName ? { ownerName: ownerProfile.displayName } : {}),
      ...(o.familyId ? { familyId: o.familyId } : {}),
      ...(o.garrison ? { garrison: o.garrison } : {}),
      ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
    };
  }

  private proceduralView(worldId: string, x: number, y: number): WorldTileView {
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) };
  }

  // tileId = `{worldId}:{x}:{y}`，解出坐标（worldId 自身不含 ':'，取末两段）。
  private coordX(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 2]);
  }
  private coordY(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 1]);
  }

  private marchView(m: MarchDoc): MarchView {
    return {
      marchId: m._id,
      kind: m.kind,
      fromTile: m.fromTile,
      toTile: m.toTile,
      troops: m.troops,
      departAt: m.departAt,
      arriveAt: m.arriveAt,
      status: m.status,
    };
  }

  // ── Redis 调度（best-effort，§14.4 `world:{worldId}:march` ZSET，score=arriveAt）──
  // 处理以 Mongo arriveAt 扫描为权威，ZSET 仅为未来精确唤醒；缺 Redis 时静默跳过。
  private marchZsetKey(worldId: string): string {
    return `world:${worldId}:march`;
  }
  private async scheduleMarch(worldId: string, mid: string, arriveAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.marchZsetKey(worldId), arriveAt, mid);
    } catch {
      /* best-effort：失败仅丢失精确唤醒，Mongo 扫描仍处理 */
    }
  }
  private async unscheduleMarch(worldId: string, mid: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.marchZsetKey(worldId), mid);
    } catch {
      /* best-effort */
    }
  }

  // ── 实时推送（best-effort，§14.5）──
  private async pushMarch(accountId: string, v: MarchView): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'march_update',
      marchId: v.marchId,
      marchKind: v.kind,
      fromTile: v.fromTile,
      toTile: v.toTile,
      arriveAt: v.arriveAt,
      status: v.status,
    });
  }
  private async pushTile(accountId: string, t: TileDoc): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'tile_update',
      tileId: t._id,
      type: t.type,
      level: t.level,
      ownerId: t.ownerId ?? '',
      familyId: t.familyId ?? '',
      protectedUntil: t.protectedUntil ?? 0,
    });
  }
  private async pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'siege_result',
      siegeId: s._id,
      tile: s.tile,
      outcome: s.outcome,
      lootSummary: lootSummaryStr,
      replayRef: s.replayRef ?? '',
    });
  }

  // ── S8-2：训练队列 ────────────────────────────────────────

  /**
   * 排入训练队列。消耗粮食，按 TROOP_TRAIN_TIME_SEC × qty 排期。
   * 校验：已进入世界 + qty 合法 + 队列槽位未满 + 训练后兵力不超 troopCap + 粮食够。
   */
  async trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    qty = Math.max(1, Math.min(TROOP_TRAIN_BATCH_MAX, Math.floor(qty)));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');

    const queue = pw.trainingQueue ?? [];
    if (queue.length >= TROOP_TRAIN_QUEUE_MAX) throw new SlgError('BAD_REQUEST', '训练队列已满');

    const inTraining = queue.reduce((s, e) => s + e.qty, 0);
    if (pw.troops + inTraining + qty > pw.troopCap) throw new SlgError('TROOP_CAP_REACHED', '训练后兵力超上限');

    const t = now();
    const resources = this.settle(pw, t);
    const foodCost = qty * TROOP_TRAIN_FOOD_COST;
    if ((resources.food ?? 0) < foodCost) throw new SlgError('INSUFFICIENT_RESOURCES', '粮食不足');
    resources.food = (resources.food ?? 0) - foodCost;

    // 训练开始时间紧接上一批结束（队列串联），没有在训批次则立即开始。
    const lastComplete = queue.length > 0 ? queue[queue.length - 1]!.completeAt : t;
    const duration = qty * TROOP_TRAIN_TIME_SEC * 1000;
    const entry: TrainingEntry = {
      qty,
      foodCost,
      startAt: lastComplete,
      completeAt: lastComplete + duration,
    };
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, lastTickAt: t },
        $push: { trainingQueue: entry } as never,
        $inc: { rev: 1 },
      },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * 金币加速训练。coins 换成缩短时长（TROOP_SPEEDUP_SECS_PER_COIN 秒/币），
   * 从队首批次开始缩短，溢出部分移到下一批。到期的批次立即出队加兵。
   * 调 commercial.spend() 扣金币（失败则不加速）。
   */
  async speedupTraining(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
    const queue = pw.trainingQueue ?? [];
    if (queue.length === 0) throw new SlgError('BAD_REQUEST', '当前没有训练中的队列');

    const speedSec = coins * TROOP_SPEEDUP_SECS_PER_COIN;
    const orderId = `slg_speedup:${worldId}:${accountId}:${now()}`;
    await this.commercial.spend(accountId, coins, orderId);

    // 从 Mongo 取最新 doc（spend 调用后可能延迟，保证幂等）
    const fresh = await cols.playerWorld.findOne({ _id: pw._id });
    if (!fresh) return this.getMe(worldId, accountId);

    const t = now();
    const resources = this.settle(fresh, t);
    const newQueue = (fresh.trainingQueue ?? []).slice();
    let remaining = speedSec * 1000;
    let troopsReady = 0;

    for (let i = 0; i < newQueue.length && remaining > 0; ) {
      const e = newQueue[i]!;
      const left = e.completeAt - t;
      if (remaining >= left) {
        remaining -= left;
        troopsReady += e.qty;
        newQueue.splice(i, 1);
      } else {
        newQueue[i] = { ...e, completeAt: e.completeAt - remaining };
        remaining = 0;
        i++;
      }
    }

    // 同步后续批次的 startAt（completeAt 压缩后级联）
    for (let i = 1; i < newQueue.length; i++) {
      const prev = newQueue[i - 1]!;
      const cur = newQueue[i]!;
      const dur = cur.completeAt - cur.startAt;
      newQueue[i] = { ...cur, startAt: prev.completeAt, completeAt: prev.completeAt + dur };
    }

    const newTroops = Math.min(fresh.troopCap, fresh.troops + troopsReady);
    await cols.playerWorld.updateOne(
      { _id: fresh._id },
      { $set: { resources, troops: newTroops, trainingQueue: newQueue, lastTickAt: t }, $inc: { rev: 1 } },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * 处理到期训练批次（由 scheduler 每 2s 调用）。
   * 遍历所有有 trainingQueue 的 playerWorld，取出 completeAt ≤ now 的批次，
   * 原子 $inc troops + $pull 已完成条目。返回处理条数。
   */
  async processCompletedTraining(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    // 找所有队列非空且队首已到期的玩家（队首最早完成）
    const docs = await cols.playerWorld
      .find({ 'trainingQueue.0.completeAt': { $lte: t } })
      .project<{ _id: string; troops: number; troopCap: number; trainingQueue: TrainingEntry[] }>({
        _id: 1, troops: 1, troopCap: 1, trainingQueue: 1,
      })
      .toArray();

    let n = 0;
    for (const doc of docs) {
      const queue = doc.trainingQueue ?? [];
      const done = queue.filter((e) => e.completeAt <= t);
      if (done.length === 0) continue;
      const troopsReady = done.reduce((s, e) => s + e.qty, 0);
      const newTroops = Math.min(doc.troopCap, doc.troops + troopsReady);
      // 原子：$inc troops + 移除已完成批次（按 completeAt 精确匹配）
      for (const e of done) {
        await cols.playerWorld.updateOne(
          { _id: doc._id },
          { $pull: { trainingQueue: { completeAt: e.completeAt } } as never },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: doc._id },
        { $set: { troops: newTroops }, $inc: { rev: 1 } },
      );
      n += done.length;
    }
    return n;
  }

  // ── S8-4 残留：防守 config ────────────────────────────────

  /**
   * 设置领地或主城防守 config（玩家编辑防守关）。
   * tileKey='base' → 写主城 playerWorld.defense；否则写该 tileId 的 tile.defense。
   * 防守 config 内容在此层不校验（P2 延迟校验，§14.9），levelSchema 校验在引擎侧 S8-3b 后补。
   */
  async setDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
    defenseConfig: Record<string, unknown>,
  ): Promise<void> {
    const { cols } = this.deps;
    if (tileKey === 'base') {
      const pwId = playerWorldId(worldId, accountId);
      const pw = await cols.playerWorld.findOne({ _id: pwId });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
      await cols.playerWorld.updateOne(
        { _id: pwId },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    } else {
      const tile = await cols.tiles.findOne({ _id: tileKey });
      if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', '非己方领地');
      await cols.tiles.updateOne(
        { _id: tileKey },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    }
  }

  /**
   * 读取领地或主城当前防守 config（C3 编辑器预填）。
   * tileKey='base' → 主城 playerWorld.defense；否则该 tileId 的 tile.defense。
   * 未设置返回 null；非己方领地抛 TILE_NOT_OWNED。
   */
  async getDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
  ): Promise<Record<string, unknown> | null> {
    const { cols } = this.deps;
    if (tileKey === 'base') {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');
      return (pw.defense as Record<string, unknown> | undefined) ?? null;
    }
    const tile = await cols.tiles.findOne({ _id: tileKey });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', '非己方领地');
    return (tile.defense as Record<string, unknown> | undefined) ?? null;
  }

  // ── S8-3b / C2：围攻防守 config 读取 + 复盘关卡 ────────────

  /** 取一条围攻战报关联的防守 config（领地 tile 优先，否则主城 playerWorld）+ 目标格等级。 */
  private async siegeDefenseConfig(
    worldId: string,
    siege: SiegeDoc,
  ): Promise<{ config: Record<string, unknown> | null; tileLevel: number }> {
    const { cols } = this.deps;
    let config: Record<string, unknown> | null = null;
    let tileLevel = 1;
    const targetTile = await cols.tiles.findOne({ _id: siege.tile });
    if (targetTile) {
      tileLevel = targetTile.level ?? 1;
      if (targetTile.defense) config = targetTile.defense as Record<string, unknown>;
    }
    if (!config && siege.defenderId) {
      const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, siege.defenderId) });
      if (defPw?.defense) config = defPw.defense as Record<string, unknown>;
    }
    return { config, tileLevel };
  }

  /**
   * 取一份「攻方可打」的围攻防守关卡（C2 客户端复盘 + 录像复算同源）。仅进攻方可读。
   * 返回的 level 形态对齐客户端 LevelDefinition；其 seed = siegeSeedFromId(sid)，客户端必须用此
   * seed 在 siege 模式实打，复算（resolveSiegeWithJudge）方能逐字复现。
   */
  async getSiegeDefense(
    worldId: string,
    accountId: string,
    sid: string,
  ): Promise<{ siegeId: string; level: Record<string, unknown> }> {
    const { cols } = this.deps;
    const siege = await cols.sieges.findOne({ _id: sid, worldId });
    if (!siege) throw new SlgError('NOT_FOUND', '战报不存在');
    if (siege.attackerId !== accountId) throw new SlgError('NO_PERMISSION', '只有进攻方可复盘');
    const { config, tileLevel } = await this.siegeDefenseConfig(worldId, siege);
    const seed = siegeSeedFromId(sid);
    return { siegeId: sid, level: buildSiegeLevel(config, tileLevel, seed) };
  }

  // ── S8-3b：judgeRunner 接入（关键围攻录像复算）────────────

  /**
   * 接收客户端提交的围攻录像，调 gateway /gw/judge 复算，更新 SiegeDoc。
   * 流程：
   *   1. 验证 siegeId 属于 accountId + 对应 tile 有防守 config；
   *   2. 调 gateway.judge(replay + defenseJson + pveUpgrades)；
   *   3. 更新 siege.recomputed=true, siege.replayRef；
   *   4. 若复算结果与廉价结算不同 → log（反作弊标记），暂不自动翻转
   *      （S8-3b server-only：翻转逻辑等 client UI 完整后再启用）。
   */
  async resolveSiegeWithJudge(
    worldId: string,
    accountId: string,
    sid: string,
    judgeArgs: Pick<WorldJudgeArgs, 'seed' | 'mode' | 'endFrame' | 'frames' | 'pveUpgrades'>,
  ): Promise<{ recomputed: boolean; judgeOutcome?: string }> {
    const { cols } = this.deps;
    const siege = await cols.sieges.findOne({ _id: sid, worldId });
    if (!siege) throw new SlgError('NOT_FOUND', '战报不存在');
    if (siege.attackerId !== accountId) throw new SlgError('NO_PERMISSION', '只有进攻方可提交录像');
    if (siege.recomputed) return { recomputed: true }; // 已复算过，幂等返回

    // 取防守 config（领地 tile 或主城 playerWorld）→ 规整成可玩围攻关卡（与 getSiegeDefense 同源），
    // 作为 judge 的 defenseJson。seed 用 siegeId 派生的 canonical 值（客户端必须用同 seed 实打）。
    const { config, tileLevel } = await this.siegeDefenseConfig(worldId, siege);
    const seed = siegeSeedFromId(sid);
    const defenseJson = JSON.stringify(buildSiegeLevel(config, tileLevel, seed));

    const result = await this.gateway.judge({
      ...judgeArgs,
      seed,
      exclude: [accountId],
      defenseJson,
    });

    const replayRef = result.judgeAccountId
      ? `judge:${result.judgeAccountId}:${sid}`
      : undefined;

    await cols.sieges.updateOne(
      { _id: sid },
      {
        $set: {
          recomputed: result.ok,
          ...(replayRef ? { replayRef } : {}),
        },
      },
    );

    if (result.ok && result.winnerSide !== undefined) {
      // winnerSide: 0=attacker win, 1=defender win
      const judgeOutcome: SiegeOutcome = result.winnerSide === 0 ? 'attacker_win' : 'defender_win';
      if (judgeOutcome !== siege.outcome) {
        // 廉价结算与引擎复算不一致 → 记录（反作弊，后续决策）
        console.warn('[worldsvc] siege outcome mismatch', {
          sid,
          cheap: siege.outcome,
          judge: judgeOutcome,
          attackerId: accountId,
        });
      }
      return { recomputed: true, judgeOutcome };
    }
    return { recomputed: result.ok };
  }

  // ── S8-6.5：国家系统 ──────────────────────────────────────

  /**
   * 初始化世界的 10 个首府文档（赛季开服时调用，幂等）。
   * 若已存在则跳过（$setOnInsert + _id 唯一防重复）。
   */
  async initNations(worldId: string): Promise<void> {
    const caps = this.capitals;
    for (let i = 0; i < caps.length; i++) {
      const [x, y] = caps[i]!;
      const id = `nation:${worldId}:${i}`;
      const doc: NationDoc = { _id: id, worldId, capitalIdx: i, x, y, rev: 0 };
      await this.deps.cols.nations.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
    }
  }

  /** 获取世界所有国家状态。 */
  async getNations(worldId: string): Promise<NationDoc[]> {
    return this.deps.cols.nations.find({ worldId }).toArray();
  }

  /**
   * 当围攻/占领到达目标格时检查是否是首府格，触发立国或灭国。
   * winnerAccountId = 占领者；若此格原先属于另一国则灭其国。
   * 返回是否触发了国家状态变更。
   */
  private async applyNationChange(
    worldId: string,
    x: number,
    y: number,
    winnerAccountId: string,
    winnerFamilyId?: string,
  ): Promise<boolean> {
    const idx = capitalIdxAt(x, y, this.capitals);
    if (idx < 0) return false; // 不是首府格
    const nationId = `nation:${worldId}:${idx}`;
    await this.deps.cols.nations.updateOne(
      { _id: nationId },
      {
        $set: {
          ownerId: winnerAccountId,
          ...(winnerFamilyId ? { familyId: winnerFamilyId } : {}),
          foundedAt: this.deps.now(),
          rev: 1, // 覆盖，不自增（简化，后续可改 $inc）
        },
        $unset: { nationName: '' }, // 新占领重命名前清空旧国名
      },
    );
    return true;
  }

  /** 设置国家名称（仅首府占领者可命名）。 */
  async setNationName(worldId: string, accountId: string, capitalIdx: number, name: string): Promise<void> {
    if (!name || name.length < 1 || name.length > 10) throw new SlgError('BAD_REQUEST', '国名 1~10 字');
    const nationId = `nation:${worldId}:${capitalIdx}`;
    const nation = await this.deps.cols.nations.findOne({ _id: nationId });
    if (!nation?.ownerId) throw new SlgError('TILE_NOT_OWNED', '该首府尚无国家');
    if (nation.ownerId !== accountId) throw new SlgError('NO_PERMISSION', '只有占领者可命名');
    await this.deps.cols.nations.updateOne({ _id: nationId }, { $set: { nationName: name } });
  }

  /**
   * 查询 (x,y) 对应的国家（Voronoi 分区最近首府）。
   * 若最近首府当前无国家（无主），返回 null。
   */
  async getNationAt(worldId: string, x: number, y: number): Promise<NationDoc | null> {
    const idx = nearestCapitalIdx(x, y, this.capitals);
    const nationId = `nation:${worldId}:${idx}`;
    return this.deps.cols.nations.findOne({ _id: nationId });
  }

  // ── S8-7：赛季管理 ────────────────────────────────────────

  /** 获取世界/赛季信息（GET /world/season）。 */
  async getSeason(worldId: string): Promise<{
    worldId: string;
    season: number;
    shard: number;
    status: string;
    openAt: number;
    resetAt?: number;
    capacity: number;
    population: number;
    mapW: number;
    mapH: number;
  } | null> {
    const w = await this.deps.cols.worlds.findOne({ _id: worldId });
    if (!w) return null;
    return {
      worldId: w._id,
      season: w.season,
      shard: w.shard,
      status: w.status,
      openAt: w.openAt,
      ...(w.resetAt ? { resetAt: w.resetAt } : {}),
      capacity: w.capacity,
      population: w.population,
      mapW: w.mapW,
      mapH: w.mapH,
    };
  }

  /**
   * 开服：创建世界文档（幂等，已存在则更新 status → open）。
   * worldId 必须形如 `s{season}-{shard}`。
   */
  async openSeason(
    worldId: string,
    season: number,
    shard: number,
    capacity: number,
  ): Promise<void> {
    const { cols, now } = this.deps;
    await cols.worlds.updateOne(
      { _id: worldId },
      {
        $setOnInsert: {
          _id: worldId,
          season,
          shard,
          status: 'open' as const,
          mapW: this.deps.mapW,
          mapH: this.deps.mapH,
          openAt: now(),
          capacity,
          population: 0,
          rev: 0,
        },
        $set: { status: 'open' as const },
      },
      { upsert: true },
    );
    // 初始化 10 个首府文档
    await this.initNations(worldId);
  }

  /**
   * 赛季结算（settling）：按宗门占领首府数量排名（§2.1 大比 = 大区内宗门占国数排名）。
   * 聚合优先级：宗门(sect) → 散家族(family) → 个人(owner)，逐级兜底无宗门/无族的占领者。
   * 结算只计算，不清档（清档走 resetSeason）。返回排名列表（按占国数降序）。
   * `scope` 标识聚合维度：'sect' | 'family' | 'solo'。
   */
  async settleSeason(worldId: string): Promise<Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    /** 聚合主体 ID（sectId / familyId / ownerId）。字段名沿用 familyId 兼容既有调用方。 */
    familyId: string;
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
  }>> {
    const { cols } = this.deps;

    // 标记赛季进入结算状态
    await cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'settling' as const } },
    );

    const nations = await cols.nations.find({ worldId, ownerId: { $exists: true } }).toArray();

    // family → sectId 映射（占国者的家族归属哪个宗门）。
    const fams = await cols.families.find({ worldId }).toArray();
    const familySect = new Map<string, string | undefined>();
    const familyName = new Map<string, string>();
    for (const f of fams) {
      familySect.set(f._id, f.sectId);
      familyName.set(f._id, f.name);
    }
    const sectName = new Map<string, string>();
    for (const s of await cols.sects.find({ worldId }).toArray()) sectName.set(s._id, s.name);

    // 按「宗门 → 家族 → 个人」逐级聚合占国数。
    const agg = new Map<string, { scope: 'sect' | 'family' | 'solo'; name?: string; capitalIdxs: number[] }>();
    for (const n of nations) {
      let scope: 'sect' | 'family' | 'solo';
      let key: string;
      let name: string | undefined;
      const sid = n.familyId ? familySect.get(n.familyId) : undefined;
      if (sid) {
        scope = 'sect'; key = sid; name = sectName.get(sid);
      } else if (n.familyId) {
        scope = 'family'; key = n.familyId; name = familyName.get(n.familyId);
      } else {
        scope = 'solo'; key = n.ownerId ?? 'solo';
      }
      const cur = agg.get(key) ?? { scope, name, capitalIdxs: [] };
      cur.capitalIdxs.push(n.capitalIdx);
      agg.set(key, cur);
    }

    return [...agg.entries()]
      .sort((a, b) => b[1].capitalIdxs.length - a[1].capitalIdxs.length)
      .map(([id, v], i) => ({
        rank: i + 1,
        scope: v.scope,
        familyId: id,
        ...(v.name ? { name: v.name } : {}),
        nationCount: v.capitalIdxs.length,
        capitalIdxs: v.capitalIdxs,
      }));
  }

  /**
   * 赛季重置（清地图态、保养成 + 外观 + 段位，§2.3 SLG4）。
   * 清除：tiles / marches / playerWorld / nations（对应 worldId）。
   * 重置后 world.status → 'open'，population → 0，resetAt 更新。
   * ⚠ 大批量删除，生产环境建议分批执行。
   */
  async resetSeason(worldId: string): Promise<{ deleted: Record<string, number> }> {
    const { cols, now } = this.deps;
    const [r1, r2, r3, r4, r5, r6, r7] = await Promise.all([
      cols.tiles.deleteMany({ worldId }),
      cols.marches.deleteMany({ worldId }),
      cols.playerWorld.deleteMany({ worldId }),
      cols.nations.deleteMany({ worldId }),
      cols.sieges.deleteMany({ worldId }),
      // 宗门编制每季重组（§2.3）：删宗门 + 频道。
      cols.sects.deleteMany({ worldId }),
      cols.sectMessages.deleteMany({ worldId }),
    ]);
    // 重置家族繁荣度（赛季归零，但不删除家族成员关系——S8-4 待细化）；清宗门归属。
    await cols.families.updateMany({ worldId }, { $set: { territoryCount: 0 }, $unset: { sectId: '' } });
    await cols.worlds.updateOne(
      { _id: worldId },
      {
        $set: { status: 'open' as const, population: 0, resetAt: now() },
        $inc: { rev: 1 },
      },
    );
    // 重新初始化首府文档
    await this.initNations(worldId);
    return {
      deleted: {
        tiles: r1.deletedCount,
        marches: r2.deletedCount,
        playerWorld: r3.deletedCount,
        nations: r4.deletedCount,
        sieges: r5.deletedCount,
        sects: r6.deletedCount,
        sectMessages: r7.deletedCount,
      },
    };
  }

  /** 关闭世界（赛季结束归档）。 */
  async closeSeason(worldId: string): Promise<void> {
    await this.deps.cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'closed' as const }, $inc: { rev: 1 } },
    );
  }

  // ── S8-8：SLG 商店 ────────────────────────────────────────

  /**
   * SLG 商店购买（商品定义见 SLG_SHOP_ITEMS）。
   * 扣金币 → 立即生效（加速/资源包/保护罩/战令写 playerWorld）。
   */
  async buySlgShopItem(worldId: string, accountId: string, itemId: string): Promise<PlayerWorldView> {
    const item = SLG_SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item) throw new SlgError('NOT_FOUND', '商品不存在');

    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', '未进入世界');

    const orderId = `slg_shop:${worldId}:${accountId}:${itemId}:${now()}`;
    await this.commercial.spend(accountId, item.cost, orderId);

    const t = now();
    const resources = this.settle(pw, t);

    if (item.kind === 'troop_speedup') {
      const secToSpeed = Number(item.effect['duration_sec'] ?? 0);
      // 重用 speedupTraining 逻辑的简化版（已扣款，直接操作 queue）
      const queue = (pw.trainingQueue ?? []).slice();
      let remaining = secToSpeed * 1000;
      let troopsReady = 0;
      for (let i = 0; i < queue.length && remaining > 0; ) {
        const e = queue[i]!;
        const left = e.completeAt - t;
        if (remaining >= left) {
          remaining -= left;
          troopsReady += e.qty;
          queue.splice(i, 1);
        } else {
          queue[i] = { ...e, completeAt: e.completeAt - remaining };
          remaining = 0;
          i++;
        }
      }
      const newTroops = Math.min(pw.troopCap, pw.troops + troopsReady);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, troops: newTroops, trainingQueue: queue, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'resource_pack') {
      const each = Number(item.effect['each'] ?? 0);
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + each);
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'protection') {
      const durSec = Number(item.effect['duration_sec'] ?? 0);
      const baseId = pw.mainBaseTile;
      if (baseId) {
        const existingProtection = await cols.tiles.findOne({ _id: baseId });
        const currentProtectUntil = existingProtection?.protectedUntil ?? t;
        const newProtectUntil = Math.max(currentProtectUntil, t) + durSec * 1000;
        await cols.tiles.updateOne(
          { _id: baseId },
          { $set: { protectedUntil: newProtectUntil }, $inc: { rev: 1 } },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'battle_pass') {
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, hasBattlePass: true, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }

    return this.getMe(worldId, accountId);
  }

  /** SLG 商店商品列表（客户端展示用）。 */
  getSlgShopItems(): typeof SLG_SHOP_ITEMS {
    return SLG_SHOP_ITEMS;
  }
}

/** 掠夺资源人读摘要（仅非零项，如 "food+250,iron+40"；空 = ""）。供 siege_result push 直接展示。 */
function lootSummary(loot: Record<ResourceType, number>): string {
  return RESOURCE_TYPES.filter((rt) => (loot[rt] ?? 0) > 0)
    .map((rt) => `${rt}+${loot[rt]}`)
    .join(',');
}
