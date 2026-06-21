// worldsvc 国民加成端到端（S8-6.5 / G1，§2.4）：真实 Mongo + 假时钟。
//   归属判定 v1：瓦片落在「由瓦片主人自己占领的首府」的 Voronoi 区内 → 享加成。
//   ① 生产加成：己方首府区内格产率 ×(1+NATION_BONUS_PRODUCTION)；无国家归属则原值（对照）。
//   ② 防御加成：守军处己方首府区 → 有效守军 ×(1+NATION_BONUS_DEFENSE)，破城门槛抬高（同等攻击守方反胜）；
//      无国家归属 → 同等攻击破城（对照，确认加成确实来自国籍）。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  capitalPositions,
  nearestCapitalIdx,
  tileYield,
  RESOURCE_YIELD_BASE,
  NATION_BONUS_PRODUCTION,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, NationDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_nation_test';
const W = 's1-nation';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.nation.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const CAPS = capitalPositions(SLG_MAP_W, SLG_MAP_H);

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

const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center';

describe.skipIf(!mongo)('worldsvc nation-bonus e2e', () => {
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

  /** 让某账号占领某首府（直接落 NationDoc，绕过围攻立国流程）。 */
  async function ownNation(capitalIdx: number, accountId: string): Promise<void> {
    const [cx, cy] = CAPS[capitalIdx]!;
    const doc: NationDoc = {
      _id: `nation:${W}:${capitalIdx}`,
      worldId: W,
      capitalIdx,
      x: cx,
      y: cy,
      ownerId: accountId,
      rev: 0,
    };
    await m.collections.nations.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
  }

  /** 直接落一个防守方（playerWorld + 一块领地），全控 garrison（对齐 siege.e2e）。 */
  async function setupDefender(accountId: string, x: number, y: number, garrison: number): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: 'territory',
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison,
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId),
      worldId: W,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { food: 0, iron: 0, wood: 0 },
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

  // ── 生产加成 ──

  it('生产加成：占领自己首府 Voronoi 区内格 → 产率 ×(1+NATION_BONUS_PRODUCTION)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource', 6, 6);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    // a 占领 (5,5) 主城与 (r) 所在首府区。
    const baseCap = nearestCapitalIdx(5, 5, CAPS);
    const rCap = nearestCapitalIdx(r.x, r.y, CAPS);
    await ownNation(baseCap, 'a');
    if (rCap !== baseCap) await ownNation(rCap, 'a');
    await svc.occupyTile(W, 'a', r.x, r.y);

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    // 资源格产率享加成：floor(base*level * 1.1)。
    const rawResource = RESOURCE_YIELD_BASE * Math.max(1, proc.level);
    const expectedResource = Math.floor(rawResource * (1 + NATION_BONUS_PRODUCTION));
    // 该资源型产率仅来自这块格（主城产 food，不污染非 food 资源）。当 rt==='food' 时叠加主城。
    if (rt !== 'food') {
      expect(rate[rt]).toBe(expectedResource);
      expect(rate[rt]).toBeGreaterThan(rawResource); // 确有加成
    } else {
      expect(rate.food).toBeGreaterThan(rawResource); // 至少被放大
    }
  });

  it('对照——无国家归属：占同格产率为原值（无加成）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource' && t.resType !== 'food', 6, 6);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    await svc.occupyTile(W, 'a', r.x, r.y); // 不占任何首府

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    expect(rate[rt]).toBe(tileYield('resource', proc.level, rt)[rt]); // 原值，无放大
  });

  // ── 防御加成 ──

  it('防御加成：守军处己方首府区 → 破城门槛抬高，同等攻击守方反胜', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500);
    await ownNation(nearestCapitalIdx(tgt.x, tgt.y, CAPS), 'b');

    // 引擎权威（G3-2b，§16）：820 兵力可破 500 守军（见下方对照用例），但破不了国民加成后的
    // floor(500*1.15)=575 守军 → 守方反胜（同 march seed，唯一变量 = 国籍带来的 +75 有效守军）。
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 820);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect((await svc.getTile(W, 'b', tgt.x, tgt.y)).mine).toBe(true); // 未易主
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('对照——守军无国家归属：同等攻击破城（确认加成来自国籍）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500); // 不给 b 任何首府

    // 同 820 兵力、同 march seed，但守军无国籍加成（500）→ 破城易主，反证上例的反胜确来自国籍。
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 820);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect((await svc.getTile(W, 'a', tgt.x, tgt.y)).mine).toBe(true); // 易主
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
  });
});
