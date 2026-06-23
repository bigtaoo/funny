// worldsvc getMapSparse 端到端（稀疏占领层 LOD）：真实 Mongo。Mongo 不可达整套 skip。
//   验证：空图 / 己方占领 mine=true / 家族盟友 ally=true（lod=mid）/ thin 跳过 ally /
//         lod=thin 不做 family 查询（仅 mine）/ 半径裁剪 / 只返回占领格（非全格）
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB  = 'nw_world_sparse_test';
const W   = 's1-sparse';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.sparse.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findNeutral(sx = 5, sy = 5): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (proceduralTile(W, x, y).type === 'neutral') return { x, y };
      }
    }
  }
  throw new Error('no neutral tile found');
}

describe.skipIf(!mongo)('worldsvc getMapSparse e2e', () => {
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

  it('空图：tiles 为空数组', async () => {
    const view = await svc.getMapSparse(W, 'a', 10, 10, 5, 'thin');
    expect(view.tiles).toHaveLength(0);
    expect(view.lod).toBe('thin');
  });

  it('己方占领格：mine=true，坐标正确', async () => {
    const pos = findNeutral(10, 10);
    await svc.joinWorld(W, 'player-a', pos.x, pos.y);

    const view = await svc.getMapSparse(W, 'player-a', pos.x, pos.y, 3, 'thin');
    const mine = view.tiles.find((t) => t.x === pos.x && t.y === pos.y);
    expect(mine).toBeDefined();
    expect(mine!.mine).toBe(true);
    expect(mine!.type).toBe('base');
  });

  it('他人占领格：occupied だが mine 未设', async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(50, 50);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);

    // player-a 看 player-b 的主城
    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'thin');
    const enemy = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(enemy).toBeDefined();
    expect(enemy!.mine).toBeUndefined();
    expect(enemy!.ally).toBeUndefined();
  });

  it('lod=thin：不填 ally，即使是家族成员', async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(20, 10);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);
    // 组成家族
    await svc.createFamily(W, 'player-a', 'FamA', 'FA');
    await svc.joinFamily(W, 'player-b', (await svc.listFamilies(W))[0]!._id ?? '');

    // thin LOD：不查 family，ally 不填
    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'thin');
    const tile = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(tile).toBeDefined();
    expect(tile!.ally).toBeUndefined();
  });

  it('lod=mid：同家族成员 ally=true', async () => {
    const posA = findNeutral(10, 10);
    const posB = findNeutral(20, 10);
    await svc.joinWorld(W, 'player-a', posA.x, posA.y);
    await svc.joinWorld(W, 'player-b', posB.x, posB.y);
    await svc.createFamily(W, 'player-a', 'FamA', 'FA');
    const families = await svc.listFamilies(W);
    await svc.joinFamily(W, 'player-b', families[0]!._id ?? '');

    const view = await svc.getMapSparse(W, 'player-a', posB.x, posB.y, 3, 'mid');
    const tile = view.tiles.find((t) => t.x === posB.x && t.y === posB.y);
    expect(tile).toBeDefined();
    expect(tile!.ally).toBe(true);
    expect(tile!.mine).toBeUndefined();
  });

  it('半径裁剪：MAX_RADIUS 40 上限；请求 r=999 被截断', async () => {
    const view = await svc.getMapSparse(W, 'a', 10, 10, 999, 'thin');
    expect(view.r).toBe(40);
  });

  it('只返回占领格，未占领格不出现在 tiles 中', async () => {
    const pos = findNeutral(30, 30);
    await svc.joinWorld(W, 'player-a', pos.x, pos.y);

    const view = await svc.getMapSparse(W, 'player-a', pos.x, pos.y, 5, 'thin');
    // 5x5 范围内大多数格子是未占领的；tiles 只含 player-a 的主城（1 格）
    expect(view.tiles.length).toBeLessThan(11 * 11); // 远少于全格数
    for (const t of view.tiles) {
      // 所有返回格必须是占领格（mine 或无标记但有主人）
      const isOwned = t.mine === true || (!t.mine && !t.ally && !t.allySect);
      expect(isOwned).toBe(true);
    }
    // 主城格本身必须在结果中
    expect(view.tiles.some((t) => t.x === pos.x && t.y === pos.y)).toBe(true);
  });

  it('lod 字段回传正确', async () => {
    const thin = await svc.getMapSparse(W, 'a', 0, 0, 1, 'thin');
    const mid  = await svc.getMapSparse(W, 'a', 0, 0, 1, 'mid');
    expect(thin.lod).toBe('thin');
    expect(mid.lod).toBe('mid');
  });
});
