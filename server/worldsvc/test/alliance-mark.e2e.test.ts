// worldsvc 联盟领地标记 端到端（G5 余项，§8.2 / §18.1 V5）：真实 Mongo。Mongo 不可达整套 skip。
//   联盟宗门（sect.allySectIds）成员的领地：**不共享视野**，仅在视野内时标 allySect=true（客户端黄描边）。
//   链路：accountId → familyMembers → family.sectId → sect.allySectIds → 联盟宗门成员家族 → 成员。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_allymark_test';
const W = 's1-allymark';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.alliance-mark.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('worldsvc 联盟领地标记 e2e (G5 / §8.2 V5)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  // 宗门/家族 id（建链：a∈famA∈sectA，sectA 联盟 sectB；ally1/ally2∈famB∈sectB；enemy∈famE∈sectC 无联盟）。
  const sectA = `s:${W}:AAA`;
  const sectB = `s:${W}:BBB`;
  const sectC = `s:${W}:CCC`;
  const famA = `f:${W}:A`;
  const famB = `f:${W}:B`;
  const famE = `f:${W}:E`;

  async function setupAlliance(): Promise<void> {
    await m.collections.families.insertMany([
      { _id: famA, worldId: W, name: 'A', tag: 'A', leaderId: 'a', memberCount: 1, territoryCount: 0, sectId: sectA, rev: 1 },
      { _id: famB, worldId: W, name: 'B', tag: 'B', leaderId: 'ally1', memberCount: 2, territoryCount: 0, sectId: sectB, rev: 1 },
      { _id: famE, worldId: W, name: 'E', tag: 'E', leaderId: 'enemy', memberCount: 1, territoryCount: 0, sectId: sectC, rev: 1 },
    ]);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 1, allySectIds: [sectB], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'ally1', memberFamilyCount: 1, allySectIds: [sectA], prosperity: 0, rev: 1 },
      { _id: sectC, worldId: W, name: 'C', tag: 'CCC', leaderFamilyId: famE, leaderId: 'enemy', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
    ]);
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:a`, worldId: W, accountId: 'a', familyId: famA, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:ally1`, worldId: W, accountId: 'ally1', familyId: famB, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:ally2`, worldId: W, accountId: 'ally2', familyId: famB, role: 'member', joinedAt: nowMs },
      { _id: `${W}:enemy`, worldId: W, accountId: 'enemy', familyId: famE, role: 'leader', joinedAt: nowMs },
    ]);
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({ cols: m.collections, redis: null, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('视野内的联盟宗门领地标 allySect（非 ally / 非 mine），敌方/家族不标', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally1', 9, 9);  // 联盟宗门成员，在 a 基地视野半径内（Chebyshev 4）
    await svc.joinWorld(W, 'enemy', 8, 8);  // 非联盟，也在视野内
    await setupAlliance();

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const allyTile = view.tiles.find((t) => t.x === 9 && t.y === 9)!;
    expect(allyTile).toMatchObject({ type: 'base', occupied: true, visible: true, allySect: true });
    expect(allyTile.mine).toBeUndefined();
    expect(allyTile.ally).toBeUndefined(); // 跨宗门联盟，非同家族

    const enemyTile = view.tiles.find((t) => t.x === 8 && t.y === 8)!;
    expect(enemyTile).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(enemyTile.allySect).toBeUndefined(); // 非联盟宗门 → 不标记
    expect(enemyTile.ally).toBeUndefined();
  });

  it('联盟不共享视野：远处联盟领地仍是迷雾（visible:false，不标 allySect）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally2', 250, 250); // 联盟成员但远超 a 视野
    await setupAlliance();

    const view = await svc.getMap(W, 'a', 250, 250, 2);
    const far = view.tiles.find((t) => t.x === 250 && t.y === 250)!;
    expect(far.visible).toBe(false);          // 联盟不共享视野 → 看不见
    expect(far.allySect).toBeUndefined();     // 视野外不泄露任何动态层（含联盟标记）
    expect(far.occupied).toBeUndefined();
  });

  it('无宗门 / 宗门无联盟：视野内他人领地不标 allySect', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'ally1', 9, 9);
    await setupAlliance();
    // 解除 a 所在宗门的联盟 → ally1 领地虽可见，也不再标记。
    await m.collections.sects.updateOne({ _id: sectA }, { $set: { allySectIds: [] } });

    const view = await svc.getMap(W, 'a', 6, 6, 5);
    const tile = view.tiles.find((t) => t.x === 9 && t.y === 9)!;
    expect(tile.visible).toBe(true);
    expect(tile.occupied).toBe(true);
    expect(tile.allySect).toBeUndefined();
  });
});
