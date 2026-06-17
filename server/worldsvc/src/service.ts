// worldsvc 业务层（S8-0 骨架 + S8-1 占领）。
// S8-0：地图读取（程序化默认 + 稀疏 DB 覆盖合并）+ 玩家状态（资源惰性结算）。
// S8-1：进入世界（建主城 + 保护罩）、占领格子（写 TileDoc + 更新 yieldRate + 驻军扣兵）、
//        放弃格子（退还驻军 + 重算产率）。行军（旅行耗时）/ 围攻为 S8-2/S8-3，此处直占即生效。
import {
  proceduralTile,
  tileId,
  marchId,
  siegeId,
  marchDurationSec,
  playerWorldId,
  tileYield,
  resolveSiege,
  npcGarrison,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  TROOP_CAP_BASE,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  PROTECTION_SEC,
  SlgError,
  type TileType,
  type ResourceType,
  type MarchKind,
  type SiegeOutcome,
} from '@nw/shared';
import type { WorldCollections, TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc } from './db';
import type { WorldRedis } from './redis';
import { nullWorldGatewayClient, type WorldGatewayClient } from './gatewayClient';
import { nullWorldMetaClient, type WorldMetaClient, type PlayerProfile } from './metaClient';

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
}

const emptyResources = (): Record<ResourceType, number> => ({ food: 0, iron: 0, wood: 0 });

/** 出征许可的玩家面 kind（return 仅内部撤军腿，禁止外部直接发起）。 */
const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep']);

export class WorldService {
  private readonly gateway: WorldGatewayClient;
  private readonly meta: WorldMetaClient;
  /** 进程内单调序号，保证同毫秒多次出征 marchId 不撞键。 */
  private marchSeq = 0;
  /** 进程内单调序号，保证同毫秒多次围攻 siegeId 不撞键。 */
  private siegeSeq = 0;

  constructor(private readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
  }

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

    const departAt = t;
    const arriveAt = departAt + marchDurationSec(fromX, fromY, toX, toY) * 1000;
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
    const res = resolveSiege(m.troops, target.garrison ?? 0);
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defenderId) });
    let loot = emptyResources();

    if (res.outcome === 'attacker_win') {
      // 掠夺败方资源（按比例从守方搬到攻方）。
      if (defender) loot = await this.transferLoot(defender, pw, t);

      if (target.type === 'base') {
        // 主城不可永久夺取：守军清零 + 上保护罩；攻方生还回师退兵池。
        await cols.tiles.updateOne(
          { _id: m.toTile },
          { $set: { garrison: 0, protectedUntil: t + PROTECTION_SEC * 1000 }, $inc: { rev: 1 } },
        );
        await this.refundTroops(pw, res.attackerSurvivors, t);
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
}

/** 掠夺资源人读摘要（仅非零项，如 "food+250,iron+40"；空 = ""）。供 siege_result push 直接展示。 */
function lootSummary(loot: Record<ResourceType, number>): string {
  return RESOURCE_TYPES.filter((rt) => (loot[rt] ?? 0) > 0)
    .map((rt) => `${rt}+${loot[rt]}`)
    .join(',');
}
