// worldsvc 自动落城（§3.4，2026-06-24）端到端：真实 Mongo 专属库。Mongo 不可达整套 skip。
//   首次进入不传坐标 → 系统自动落城：① 无家族 → 落外环新手区（dr > 0.6）② 有家族 → 落同家族
//   成员主城附近（切比雪夫 ≤ SPAWN_NEAR_FAMILY_RADIUS）③ 落点恒为合法 base 格、避开已占格。
//   手动坐标路径（内部/测试）仍可用（既有 service.e2e 覆盖）。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proceduralTile, tileId, SLG_MAP_W, SLG_MAP_H } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_autospawn_test';
const W = 's1-autospawn';

// 与 service.ts 私有常量保持一致（改那边记得改这里）。
const SPAWN_NEAR_FAMILY_RADIUS = 6;
const SPAWN_OUTER_MIN_DR = 0.6;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.autospawn.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const MAX_DIST = Math.sqrt((SLG_MAP_W / 2) ** 2 + (SLG_MAP_H / 2) ** 2);

/** 到中心的归一化距离（0 中心 .. 1 角落），与 proceduralTile 内 dr 同口径。 */
function dr(x: number, y: number): number {
  const dx = x - SLG_MAP_W / 2;
  const dy = y - SLG_MAP_H / 2;
  return Math.sqrt(dx * dx + dy * dy) / MAX_DIST;
}

function parseTile(mainBaseTile: string): { x: number; y: number } {
  const parts = mainBaseTile.split(':');
  return { x: Number(parts[parts.length - 2]), y: Number(parts[parts.length - 1]) };
}

/** 在 (sx,sy) 周边螺旋找一个可落城的合法格（neutral/resource），用于放置家族成员主城。 */
function findPlaceable(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y).type;
        if (t === 'neutral' || t === 'resource') return { x, y };
      }
    }
  }
  throw new Error('no placeable tile');
}

describe.skipIf(!mongo)('worldsvc 自动落城 e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
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
      now: () => nowMs,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('无家族首次进入：不传坐标 → 自动落城外环新手区（合法 base 格，dr > 阈值）', async () => {
    const me = await svc.joinWorld(W, 'solo'); // 不传坐标
    expect(me.joined).toBe(true);
    expect(me.mainBaseTile).toBeTruthy();

    const { x, y } = parseTile(me.mainBaseTile!);
    // 落点合法：非中心、非障碍/关隘/险地。
    expect(x === CENTER_X && y === CENTER_Y).toBe(false);
    expect(['center', 'obstacle', 'gate', 'stronghold']).not.toContain(proceduralTile(W, x, y).type);
    // 落在外环新手区（远离中心争夺区）。
    expect(dr(x, y)).toBeGreaterThan(SPAWN_OUTER_MIN_DR);

    // 落地确实写成 base 且归己。
    const tile = await svc.getTile(W, 'solo', x, y);
    expect(tile).toMatchObject({ type: 'base', mine: true });
  });

  it('有家族首次进入：自动落城在同家族成员主城附近（切比雪夫 ≤ 半径），且不与其重叠', async () => {
    // 先安排一名同家族成员主城（用显式坐标手动落点，模拟既有成员）。
    const mateSpot = findPlaceable(1100, 1100);
    await svc.joinWorld(W, 'mate', mateSpot.x, mateSpot.y);

    // 两人同家族（直接写 familyMembers，绕过 family 业务流，只测落点逻辑）。
    const familyId = `f:${W}:FAM`;
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:mate`, worldId: W, accountId: 'mate', familyId, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:newbie`, worldId: W, accountId: 'newbie', familyId, role: 'member', joinedAt: nowMs },
    ]);

    const me = await svc.joinWorld(W, 'newbie'); // 不传坐标
    expect(me.joined).toBe(true);
    const { x, y } = parseTile(me.mainBaseTile!);

    // 落在成员主城周围 SPAWN_NEAR_FAMILY_RADIUS 切比雪夫环内。
    const cheb = Math.max(Math.abs(x - mateSpot.x), Math.abs(y - mateSpot.y));
    expect(cheb).toBeGreaterThanOrEqual(1); // 不与成员主城重叠
    expect(cheb).toBeLessThanOrEqual(SPAWN_NEAR_FAMILY_RADIUS);

    // 两人主城是不同格。
    expect(tileId(W, x, y)).not.toBe(tileId(W, mateSpot.x, mateSpot.y));
  });

  it('自动落城避开已占格：成员主城那一格不会被新人覆盖', async () => {
    const mateSpot = findPlaceable(1200, 1200);
    await svc.joinWorld(W, 'mate', mateSpot.x, mateSpot.y);
    const familyId = `f:${W}:FAM2`;
    await m.collections.familyMembers.insertMany([
      { _id: `${W}:mate`, worldId: W, accountId: 'mate', familyId, role: 'leader', joinedAt: nowMs },
      { _id: `${W}:newbie`, worldId: W, accountId: 'newbie', familyId, role: 'member', joinedAt: nowMs },
    ]);

    const me = await svc.joinWorld(W, 'newbie');
    const { x, y } = parseTile(me.mainBaseTile!);
    // 新人主城与成员主城分属不同 owner、不同格。
    const mateTile = await m.collections.tiles.findOne({ _id: tileId(W, mateSpot.x, mateSpot.y) });
    expect(mateTile?.ownerId).toBe('mate');
    const newbieTile = await m.collections.tiles.findOne({ _id: tileId(W, x, y) });
    expect(newbieTile?.ownerId).toBe('newbie');
  });

  it('幂等：已落城再次不传坐标 join 不二次落城', async () => {
    const first = await svc.joinWorld(W, 'solo');
    const base1 = first.mainBaseTile;
    const second = await svc.joinWorld(W, 'solo');
    expect(second.mainBaseTile).toBe(base1);
    expect(second.territoryCount).toBe(1);
  });
});
