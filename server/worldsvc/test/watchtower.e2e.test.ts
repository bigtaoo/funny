// worldsvc 瞭望塔 端到端（§18 G5 V2 余项「固定半径持久视野源」）：真实 Mongo。Mongo 不可达整套 skip。
//   瞭望塔 = 在己方领地花 WATCHTOWER_COST 资源建大半径（VISION_WATCHTOWER_RADIUS=8）持久视野源；
//   落库随 TileDoc（丢地即失）。校验：己方领地 / 非主城 / 资源充足；幂等不重复扣费。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_WATCHTOWER_RADIUS,
  VISION_TERRITORY_RADIUS,
  WATCHTOWER_COST,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_watchtower_test';
const W = 's1-watchtower';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.watchtower.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** 在 (sx,sy) 周边螺旋找一个满足 predicate 的格（确定性）。 */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
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
const NEUTRAL = (t: ReturnType<typeof proceduralTile>) => t.type === 'neutral';

describe.skipIf(!mongo)('worldsvc watchtower e2e (§18 G5 V2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

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

  /** 占领一块远离基地的领地并塞够资源，返回该领地坐标。 */
  async function setupTerritoryWithResources(acct: string): Promise<{ x: number; y: number }> {
    await svc.joinWorld(W, acct, 5, 5);
    const terr = findCoord(NEUTRAL, 5, 60); // 远离基地（脱离基地视野半径），便于验证瞭望塔扩视野
    await svc.occupyTile(W, acct, terr.x, terr.y);
    // 起始资源为 0（join 给 emptyResources）→ 直接塞够建塔资源（不靠产出累积）。
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, acct) },
      { $set: { resources: { food: 1000, iron: 5000, wood: 5000 }, lastTickAt: nowMs } },
    );
    return terr;
  }

  it('在己方领地建塔：扣资源 + 置 watchtower 标记 + 视图透出', async () => {
    const terr = await setupTerritoryWithResources('a');
    const view = await svc.buildWatchtower(W, 'a', terr.x, terr.y);
    expect(view).toMatchObject({ x: terr.x, y: terr.y, mine: true, watchtower: true });

    // 落库：TileDoc.watchtower=true。
    const doc = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(doc?.watchtower).toBe(true);

    // 资源按 WATCHTOWER_COST 扣减（iron 5000-2000、wood 5000-3000）。
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw?.resources.iron).toBe(5000 - WATCHTOWER_COST.iron);
    expect(pw?.resources.wood).toBe(5000 - WATCHTOWER_COST.wood);
  });

  it('扩视野：原迷雾的远格建塔后可见，超半径仍迷雾', async () => {
    const terr = await setupTerritoryWithResources('a');
    // F 在领地 chebyshev 距离 6：> VISION_TERRITORY_RADIUS(2)、< VISION_WATCHTOWER_RADIUS(8)。
    const dist = 6;
    expect(dist).toBeGreaterThan(VISION_TERRITORY_RADIUS);
    expect(dist).toBeLessThan(VISION_WATCHTOWER_RADIUS);
    const fx = terr.x;
    const fy = terr.y + dist;

    // 建塔前：F 在迷雾中（领地视野半径只有 2，够不着）。
    const before = await svc.getMap(W, 'a', fx, fy, 0);
    expect(before.tiles.find((t) => t.x === fx && t.y === fy)!.visible).toBe(false);

    await svc.buildWatchtower(W, 'a', terr.x, terr.y);

    // 建塔后：F 进入瞭望塔视野（半径 8）→ visible。
    const after = await svc.getMap(W, 'a', fx, fy, 0);
    expect(after.tiles.find((t) => t.x === fx && t.y === fy)!.visible).toBe(true);

    // 对照：超出瞭望塔半径（距离 10 > 8）仍迷雾。
    const farY = terr.y + 10;
    const far = await svc.getMap(W, 'a', fx, farY, 0);
    expect(far.tiles.find((t) => t.x === fx && t.y === farY)!.visible).toBe(false);
  });

  it('守卫：非己方/未占领格拒绝（TILE_NOT_OWNED）', async () => {
    await setupTerritoryWithResources('a');
    const empty = findCoord(NEUTRAL, 5, 80); // 未占领
    await expect(svc.buildWatchtower(W, 'a', empty.x, empty.y)).rejects.toMatchObject({ code: 'TILE_NOT_OWNED' });
  });

  it('守卫：主城不可建塔（BAD_REQUEST，主城自带视野）', async () => {
    await setupTerritoryWithResources('a');
    await expect(svc.buildWatchtower(W, 'a', 5, 5)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('守卫：资源不足拒绝（INSUFFICIENT_RESOURCES），不动地图', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const terr = findCoord(NEUTRAL, 5, 60);
    await svc.occupyTile(W, 'a', terr.x, terr.y);
    // 资源不足（默认 0）→ 拒绝。
    await expect(svc.buildWatchtower(W, 'a', terr.x, terr.y)).rejects.toMatchObject({ code: 'INSUFFICIENT_RESOURCES' });
    const doc = await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) });
    expect(doc?.watchtower).toBeUndefined(); // 未建塔
  });

  it('幂等：重复建塔返回 watchtower:true，不重复扣费', async () => {
    const terr = await setupTerritoryWithResources('a');
    await svc.buildWatchtower(W, 'a', terr.x, terr.y);
    const pw1 = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    const view2 = await svc.buildWatchtower(W, 'a', terr.x, terr.y); // 幂等
    expect(view2.watchtower).toBe(true);
    const pw2 = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'a') });
    expect(pw2?.resources.iron).toBe(pw1?.resources.iron); // 未二次扣费
    expect(pw2?.resources.wood).toBe(pw1?.resources.wood);
  });
});
