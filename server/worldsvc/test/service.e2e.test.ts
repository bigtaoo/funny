// worldsvc WorldService 端到端（S8-1）：真实 Mongo 专属库。Mongo 不可达整套 skip。
//   地图程序化合并 / 进入世界(主城+保护罩+幂等) / 占领(写 TileDoc+扣兵+产率) / 放弃(退兵+重算) /
//   资源惰性结算 / 占领校验(界外/中心/他人领地/保护期/兵力不足) / 容量满员。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  RESOURCE_YIELD_BASE,
  GARRISON_PER_TILE,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_test';
const W = 's1-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** 在 (sx,sy) 周边螺旋找一个满足 predicate 的格（确定性，用于定位资源格）。 */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx = 5,
  sy = 5,
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

describe.skipIf(!mongo)('worldsvc WorldService e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('getMap：程序化默认 + 世界中心唯一', async () => {
    const view = await svc.getMap(W, 'a', CENTER_X, CENTER_Y, 2);
    expect(view.tiles).toHaveLength(25); // 5×5
    const centers = view.tiles.filter((t) => t.type === 'center');
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: CENTER_X, y: CENTER_Y });
  });

  it('未进入：getMe joined=false', async () => {
    expect(await svc.getMe(W, 'a')).toEqual({ joined: false });
  });

  it('进入世界：建主城 + 保护罩 + 满兵力 + 起步产率；幂等', async () => {
    const neutral = findCoord((t) => t.type === 'neutral');
    const me = await svc.joinWorld(W, 'a', neutral.x, neutral.y);
    expect(me).toMatchObject({
      joined: true,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      mainBaseTile: tileId(W, neutral.x, neutral.y),
      territoryCount: 1,
    });
    expect(me.yieldRate?.food).toBe(RESOURCE_YIELD_BASE); // base 起步粮食 trickle

    const tile = await svc.getTile(W, 'a', neutral.x, neutral.y);
    expect(tile).toMatchObject({ type: 'base', mine: true, occupied: true });
    expect(tile.protectedUntil).toBe(nowMs + 8 * 3600 * 1000);

    // 幂等：再次 join（换坐标）不二次落城。
    const me2 = await svc.joinWorld(W, 'a', neutral.x + 3, neutral.y + 3);
    expect(me2.mainBaseTile).toBe(tileId(W, neutral.x, neutral.y));
    expect(me2.territoryCount).toBe(1);
  });

  it('占领资源格：写 territory + 扣兵 + 产率增；放弃退兵 + 重算', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const res = findCoord((t) => t.type === 'resource', 50, 50); // 远离主城 (5,5)，保证不同格
    const procRes = proceduralTile(W, res.x, res.y);
    const rt = procRes.resType as ResourceType;

    const tv = await svc.occupyTile(W, 'a', res.x, res.y);
    expect(tv).toMatchObject({ type: 'territory', mine: true, occupied: true, resType: rt });

    const me = await svc.getMe(W, 'a');
    expect(me.troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE);
    expect(me.territoryCount).toBe(2);
    expect(me.yieldRate?.[rt]).toBe(RESOURCE_YIELD_BASE * procRes.level + (rt === 'food' ? RESOURCE_YIELD_BASE : 0));

    // 占领幂等：重复占领同格不再扣兵。
    await svc.occupyTile(W, 'a', res.x, res.y);
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - GARRISON_PER_TILE);

    // 放弃：退兵 + 领地数回落 + 格回归程序化（DB 不留空壳）。
    const after = await svc.abandonTile(W, 'a', res.x, res.y);
    expect(after.troops).toBe(TROOP_CAP_BASE);
    expect(after.territoryCount).toBe(1);
    expect(await m.collections.tiles.findOne({ _id: tileId(W, res.x, res.y) })).toBeNull();
  });

  it('资源惰性结算：按 yieldRate × dt 补算', async () => {
    await svc.joinWorld(W, 'a', 5, 5); // 仅主城 → food 产率 100/h
    nowMs += 3_600_000; // +1h
    const me = await svc.getMe(W, 'a');
    expect(me.resources?.food).toBe(RESOURCE_YIELD_BASE);
    nowMs += 1_800_000; // 再 +0.5h
    expect((await svc.getMe(W, 'a')).resources?.food).toBe(Math.floor(RESOURCE_YIELD_BASE * 1.5));
  });

  it('占领校验：界外 / 中心 / 兵力不足', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.occupyTile(W, 'a', -1, 0)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    await expect(svc.occupyTile(W, 'a', CENTER_X, CENTER_Y)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // 占满 3 格（base 不耗兵，2000/500=4 队，但留 1 队测 NO_TROOPS：占 4 块后第 5 块拒）。
    const frees: { x: number; y: number }[] = [];
    let scanX = 5;
    while (frees.length < 4) {
      scanX += 1;
      const t = proceduralTile(W, scanX, 5);
      if (t.type !== 'center' && !(scanX === CENTER_X && 5 === CENTER_Y)) frees.push({ x: scanX, y: 5 });
    }
    for (const f of frees) await svc.occupyTile(W, 'a', f.x, f.y);
    expect((await svc.getMe(W, 'a')).troops).toBe(0);
    // 第 5 块：兵力耗尽。
    await expect(svc.occupyTile(W, 'a', scanX + 1, 5)).rejects.toMatchObject({ code: 'NO_TROOPS' });
  });

  it('他人领地：占其主城 → PROTECTED；占其普通领地 → TILE_OCCUPIED', async () => {
    await svc.joinWorld(W, 'b', 200, 200);
    const bTerr = findCoord((t) => t.type === 'resource', 201, 200);
    await svc.occupyTile(W, 'b', bTerr.x, bTerr.y);

    await svc.joinWorld(W, 'a', 5, 5);
    await expect(svc.occupyTile(W, 'a', 200, 200)).rejects.toMatchObject({ code: 'PROTECTED' });
    await expect(svc.occupyTile(W, 'a', bTerr.x, bTerr.y)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
  });

  it('容量守卫：world 文档满员 → WORLD_FULL', async () => {
    await m.collections.worlds.insertOne({
      _id: W,
      season: 1,
      shard: 0,
      status: 'open',
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      openAt: now(),
      capacity: 1,
      population: 0,
      rev: 0,
    });
    await svc.joinWorld(W, 'a', 5, 5);
    expect((await m.collections.worlds.findOne({ _id: W }))?.population).toBe(1);
    await expect(svc.joinWorld(W, 'b', 200, 200)).rejects.toMatchObject({ code: 'WORLD_FULL' });
    // 占用者不存在的 playerWorld 不被创建。
    expect(await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'b') })).toBeNull();
  });
});
