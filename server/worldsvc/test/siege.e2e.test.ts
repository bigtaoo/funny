// worldsvc 围攻 / 扫荡端到端（S8-3 + G3-2b 引擎权威）：真实 Mongo + 假时钟 + 捕获 push。
//   关键围攻（攻领地 / 攻主城）= worldsvc import `@nw/engine` headless 跑「双方预布兵确定性
//   自动战斗」拿权威胜负 + 真实残存血量（§16）；扫荡 NPC = 廉价 resolveSiege（§5.3 非关键）。
//   出征即推 under_attack 预警 / 到点结算：
//   ① 攻领地 attacker_win → 领地易主（残存折回成新驻军）+ 掠夺资源 + 双方产率重算 + sieges + siege_result；
//   ② 攻领地 defender_win → 守军减员（攻方更弱 → 全灭无回师）；
//   ③ 攻主城 attacker_win → 不可夺：守军清零 + 保护罩 + 掠夺 + 攻方残存回师退兵；
//   ④ 扫荡 NPC attacker_win → 缴获 + 回师退兵；defender_win → 兵损耗无缴获；
//   ⑤ 校验：攻无主格 / 攻己方 / 扫已占 / 攻保护期。
// 注：兵力数 → 引擎布阵走 synthesizeArmy 合成（G3-2c 编辑器前的 v1 桥），故残存兵力由引擎战斗
//   决定（非线性公式），断言只校验「方向 + 结构效应」（易主 / 残存>0 / 减员），不锁定具体残存数。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  npcGarrison,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  SLG_MAP_W,
  SLG_MAP_H,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_siege_test';
const W = 's1-siege';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.siege.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

/** 程序化地形上「可被行军到达」的格：排除障碍/关隘/中心（findMarchPath 把这些当永久阻挡，
 *  且 startMarch 对 obstacle 目标直接拒绝）。setupDefender 会在 DB 覆盖类型，但寻路只看程序化层。 */
const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center';

describe.skipIf(!mongo)('worldsvc siege e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  /** 直接落一个防守方（playerWorld + 一块防守格），绕过保护期/直占约束，全控 garrison/资源。 */
  async function setupDefender(
    accountId: string,
    x: number,
    y: number,
    opts: { type: TileDoc['type']; garrison: number; food?: number; protectedUntil?: number },
  ): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: opts.type,
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison: opts.garrison,
      ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId),
      worldId: W,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { food: opts.food ?? 0, iron: 0, wood: 0 },
      yieldRate: { food: 0, iron: 0, wood: 0 },
      lastTickAt: nowMs,
      mainBaseTile: tileId(W, x, y),
      rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: pw._id }, { $set: pw }, { upsert: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('攻领地胜：易主 + 掠夺 + 双方产率重算 + under_attack/siege_result 推送', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 500, food: 1000 });

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching', troops: 800 });
    // 出征即向防守方 b 推 under_attack。
    const ua = pushes.find((p) => p.msg.kind === 'under_attack');
    expect(ua?.accountId).toBe('b');
    expect(ua?.msg).toMatchObject({ tile: tileId(W, tgt.x, tgt.y), troopsHint: 800 });

    // 推进至 A* 行军到点（用 service 算出的 arriveAt，避免欧氏距离低估路径长度）。
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 领地易主：现归 a，garrison = 引擎残存折回（>0，攻方 800 兵力优势胜 500 守军）。
    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(2);
    // 掠夺 25%：a +250 food，b -250 → 750。
    expect(me.resources?.food).toBe(Math.floor(1000 * SIEGE_LOOT_RATE));
    const bRes = (await svc.getMe(W, 'b')).resources;
    expect(bRes?.food).toBe(1000 - Math.floor(1000 * SIEGE_LOOT_RATE));

    // sieges 记录 + siege_result 推双方。
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', defenderId: 'b', tile: tileId(W, tgt.x, tgt.y) });
    const sr = pushes.filter((p) => p.msg.kind === 'siege_result');
    expect(sr.map((p) => p.accountId).sort()).toEqual(['a', 'b']);
    expect((sr[0]!.msg as { outcome: string }).outcome).toBe('attacker_win');
    void mv;
  });

  it('攻领地败：攻方committed 全灭 + 守军减员（不易主）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, { type: 'territory', garrison: 800 });

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 600);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - 600); // 出征扣兵
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 守方胜（攻方 600 < 守军 800 兵力劣势 → 全灭无回师）：攻方 committed 不回池，守军减员但 >0，格仍归 b。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - 600);
    const tile = await svc.getTile(W, 'b', tgt.x, tgt.y);
    expect(tile.mine).toBe(true);
    expect(tile.garrison).toBeGreaterThan(0);
    expect(tile.garrison).toBeLessThan(800);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('攻主城胜：被动迁城（旧址回归中立 + 随机新址上保护罩 + 失地）+ 掠夺 + 攻方生还回师退兵', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    // b 主城 + 一块领地：被动迁城应让 b 失去这块领地。
    await setupDefender('b', tgt.x, tgt.y, { type: 'base', garrison: 500, food: 1000 });
    const terr = findCoord(NON_BLOCKING, 12, 5);
    await m.collections.tiles.updateOne(
      { _id: tileId(W, terr.x, terr.y) },
      { $set: { _id: tileId(W, terr.x, terr.y), worldId: W, x: terr.x, y: terr.y, type: 'territory', level: 1, ownerId: 'b', garrison: 300, rev: 0 } },
      { upsert: true },
    );

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 旧主城格回归中立（被删，无 ownerId）。
    const oldTile = await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(oldTile?.ownerId).toBeUndefined();
    // 旧领地格也被清（失地）。
    const oldTerr = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(oldTerr?.ownerId).toBeUndefined();
    // b 主城迁到随机新址（≠ 旧址），新址 type=base + 上保护罩 + 守军 0。
    const meB = await svc.getMe(W, 'b');
    expect(meB.mainBaseTile).toBeDefined();
    expect(meB.mainBaseTile).not.toBe(tileId(W, tgt.x, tgt.y));
    expect(meB.territoryCount).toBe(1); // 仅剩新主城
    const newBase = await m.collections.tiles.findOne({ _id: meB.mainBaseTile! });
    expect(newBase?.ownerId).toBe('b');
    expect(newBase?.type).toBe('base');
    expect(newBase?.garrison).toBe(0);
    expect(newBase?.protectedUntil).toBeGreaterThan(nowMs);
    // 攻方残存回师退兵池：2000 - 800(出征) + 引擎残存(>0) > 1200。
    expect((await svc.getMe(W, 'a')).troops).toBeGreaterThan(TROOP_CAP_BASE - 800);
    // 掠夺 250。
    expect((await svc.getMe(W, 'a')).resources?.food).toBe(Math.floor(1000 * SIEGE_LOOT_RATE));
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
  });

  it('扫荡 NPC 胜：缴获资源 + 生还回师退兵（不占地）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 找一个低级、resType≠food 的资源格，隔离缴获断言（不被 a 主城 food 产出污染）。
    const tgt = findCoord((t) => t.type === 'resource' && t.level <= 3 && t.resType !== 'food', 30, 30);
    const proc = proceduralTile(W, tgt.x, tgt.y);
    const npc = npcGarrison(proc.level);
    const troops = npc + 600;

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'sweep', troops);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const me = await svc.getMe(W, 'a');
    // 生还 600 回师：2000 - troops + 600 = 2000 - npc。
    expect(me.troops).toBe(TROOP_CAP_BASE - npc);
    // 缴获 = SWEEP_LOOT_PER_LEVEL × level（resType≠food，无产出污染）。
    const rt = proc.resType as ResourceType;
    expect(me.resources?.[rt]).toBe(SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level));
    // 不占地：该格仍中立。
    expect((await svc.getTile(W, 'a', tgt.x, tgt.y)).mine).toBeUndefined();
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win' });
    expect(siege?.defenderId).toBeUndefined();
  });

  it('扫荡 NPC 败：兵力损耗、无缴获、不占地', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord((t) => t.type === 'resource' && t.resType !== 'food', 30, 30);
    const proc = proceduralTile(W, tgt.x, tgt.y);
    const troops = 10; // < npcGarrison

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'sweep', troops);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // committed 全灭：2000 - 10。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - troops);
    const rt = proc.resType as ResourceType;
    expect((await svc.getMe(W, 'a')).resources?.[rt] ?? 0).toBe(0);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('校验：攻无主格 / 攻己方 / 扫已占 / 攻保护期', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const free = findCoord((t) => t.type === 'neutral', 30, 30);
    // 攻无主格 → TILE_NOT_OWNED。
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // 攻己方领地 → TILE_OCCUPIED。
    const mine = findCoord((t) => t.type === 'resource', 6, 6);
    await svc.occupyTile(W, 'a', mine.x, mine.y);
    await expect(svc.startMarch(W, 'a', 5, 5, mine.x, mine.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // 扫已占（他人领地）→ TILE_OCCUPIED。
    const occ = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', occ.x, occ.y, { type: 'territory', garrison: 500 });
    await expect(svc.startMarch(W, 'a', 5, 5, occ.x, occ.y, 'sweep', 100)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // 攻保护期目标 → PROTECTED。
    const prot = findCoord(NON_BLOCKING, occ.x + 2, occ.y);
    await setupDefender('c', prot.x, prot.y, { type: 'territory', garrison: 500, protectedUntil: nowMs + 100000 });
    await expect(svc.startMarch(W, 'a', 5, 5, prot.x, prot.y, 'attack', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'PROTECTED',
    });
  });
});
