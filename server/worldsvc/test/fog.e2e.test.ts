// worldsvc 视野/迷雾 端到端（G5-1，§8.2 / §15.2 G5）：真实 Mongo。Mongo 不可达整套 skip。
//   迷雾模型 2a：地形层全图可见，动态层（归属/驻军/保护罩）仅当前视野内可见，视野外退回程序化地形。
//   视野源 = 己方领地/主城 + 同家族成员领地（共享）+ 在途行军。getMap / getTile 同口径门控。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_BASE_RADIUS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_fog_test';
const W = 's1-fog';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.fog.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
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

describe.skipIf(!mongo)('worldsvc fog/vision e2e (G5)', () => {
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

  it('视野内：己方主城及周边动态层可见（visible:true + mine + type:base）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const view = await svc.getMap(W, 'a', 5, 5, 2);
    const base = view.tiles.find((t) => t.x === 5 && t.y === 5)!;
    expect(base).toMatchObject({ type: 'base', mine: true, occupied: true, visible: true });
    // 周边格（基地视野半径内）也 visible:true。
    expect(view.tiles.every((t) => t.visible === true)).toBe(true);
  });

  it('视野外：远处敌方领地完全隐去（visible:false + 退回程序化地形，无 owner/occupied）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 敌方 e 在远处 (200,200) 落城（远超 a 的基地视野半径）。
    await svc.joinWorld(W, 'e', 200, 200);

    const view = await svc.getMap(W, 'a', 200, 200, 2);
    const enemyBase = view.tiles.find((t) => t.x === 200 && t.y === 200)!;
    // 关键：敌方主城在视野外 → 不暴露「已占领」，type 退回程序化底层（非 'base'/'territory'）。
    const proc = proceduralTile(W, 200, 200);
    expect(enemyBase.visible).toBe(false);
    expect(enemyBase.type).toBe(proc.type);
    expect(enemyBase.occupied).toBeUndefined();
    expect(enemyBase.mine).toBeUndefined();
    expect(enemyBase.ownerPublicId).toBeUndefined();
    expect(enemyBase.garrison).toBeUndefined();
    // 但地形层（type/level）仍如实给出（2a：地形不是秘密）。
    expect(enemyBase.level).toBe(proc.level);
  });

  it('getTile 同口径：视野外敌方格也只给程序化地形（防绕过 getMap）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 200, 200);
    const tile = await svc.getTile(W, 'a', 200, 200);
    expect(tile.visible).toBe(false);
    expect(tile.mine).toBeUndefined();
    expect(tile.occupied).toBeUndefined();
    expect(tile.type).toBe(proceduralTile(W, 200, 200).type);
  });

  it('家族共享视野：同家族成员的远处领地对我可见（occupied 但非 mine）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'mate', 250, 250); // 远处，a 基地视野够不着
    // 直接写 familyMembers：a 与 mate 同家族（computeVisionSources 据此反查成员）。
    const fam = 'fam-1';
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:a`, worldId: W, accountId: 'a', familyId: fam, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:mate`, worldId: W, accountId: 'mate', familyId: fam, role: 'member', joinedAt: nowMs },
    ]);

    const view = await svc.getMap(W, 'a', 250, 250, 2);
    const mateBase = view.tiles.find((t) => t.x === 250 && t.y === 250)!;
    expect(mateBase).toMatchObject({ type: 'base', occupied: true, visible: true, ally: true });
    expect(mateBase.mine).toBeUndefined(); // 是盟友的、非我的（ally=true 让客户端用友方色而非敌色）

    // 对照：非家族的 e（远处）仍是迷雾。
    await svc.joinWorld(W, 'e', 280, 280);
    const v2 = await svc.getMap(W, 'e', 250, 250, 2); // e 视角看 mate 的城 → 迷雾
    expect(v2.tiles.find((t) => t.x === 250 && t.y === 250)!.visible).toBe(false);
  });

  it('在途行军照亮路径：行军中途位置周边脱离基地视野却仍可见', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 向南行军到远处中立格（脱离基地视野半径）。
    const dst = findCoord(NEUTRAL, 5, 40);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', 500);

    // 推进到行军中点：插值位置远离基地（y 远大于 5+VISION_BASE_RADIUS）。
    nowMs = Math.floor((mv.departAt + mv.arriveAt) / 2);
    const midY = Math.round(5 + (dst.y - 5) * 0.5);
    expect(midY).toBeGreaterThan(5 + VISION_BASE_RADIUS); // 确认确实脱离基地视野

    const view = await svc.getMap(W, 'a', dst.x, midY, 1);
    const here = view.tiles.find((t) => t.x === dst.x && t.y === midY)!;
    expect(here.visible).toBe(true); // 行军视野照亮

    // 对照：行军视野半径外、基地视野外的格仍是迷雾。
    const far = await svc.getMap(W, 'a', dst.x, midY + 20, 1);
    expect(far.tiles.find((t) => t.x === dst.x && t.y === midY + 20)!.visible).toBe(false);
    void (mv as { marchId: string });
  });
});
