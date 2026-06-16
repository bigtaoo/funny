// worldsvc 行军端到端（S8-2）：真实 Mongo 专属库 + 假时钟 + 捕获 push。
//   出征扣兵 / 旅行耗时 / 到点占领(写 territory + 产率) / 到点增援(加 garrison) /
//   撤军返程退兵 / 占领校验(非己方格出征/中心/已占) / 到达时目标被占→退兵 / march_update+tile_update 推送。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  marchDurationSec,
  SLG_MAP_W,
  SLG_MAP_H,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  TROOP_CAP_BASE,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_march_test';
const W = 's1-march';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.march.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** 螺旋找满足 predicate 的格（确定性）。 */
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

describe.skipIf(!mongo)('worldsvc march e2e', () => {
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
  };

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

  it('占领行军：出征扣兵 + 旅行耗时 + 到点写 territory + 产率增 + 推送', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'resource', 30, 30);
    const procT = proceduralTile(W, target.x, target.y);
    const dur = marchDurationSec(5, 5, target.x, target.y);

    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);
    expect(mv).toMatchObject({ kind: 'occupy', status: 'marching', troops: OCCUPY_MIN_TROOPS });
    expect(mv.arriveAt).toBe(nowMs + dur * 1000);
    expect(mv.fromTile).toBe(tileId(W, 5, 5));
    expect(mv.toTile).toBe(tileId(W, target.x, target.y));

    // 出征即扣兵（在途）。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - OCCUPY_MIN_TROOPS);
    // 出征即推 march_update。
    expect(pushes.some((p) => p.msg.kind === 'march_update' && p.msg.status === 'marching')).toBe(true);

    // 未到点：处理无果，目标仍中立。
    nowMs += (dur - 1) * 1000;
    expect(await svc.processDueArrivals()).toBe(0);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();

    // 到点：占领落地。
    nowMs += 1000;
    expect(await svc.processDueArrivals()).toBe(1);
    const tile = await svc.getTile(W, 'a', target.x, target.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true, occupied: true, garrison: OCCUPY_MIN_TROOPS });

    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(2);
    // 兵已转为 garrison，池不变（仍扣着）。
    expect(me.troops).toBe(TROOP_CAP_BASE - OCCUPY_MIN_TROOPS);
    const rt = procT.resType!;
    expect(me.yieldRate?.[rt]).toBeGreaterThan(0);

    // 到点推 march_update(arrived) + tile_update。
    expect(pushes.some((p) => p.msg.kind === 'march_update' && p.msg.status === 'arrived')).toBe(true);
    expect(pushes.some((p) => p.msg.kind === 'tile_update')).toBe(true);
    // 行军瞬态文档已删。
    expect(await m.collections.marches.findOne({ _id: mv.marchId })).toBeNull();
  });

  it('增援行军：到点给己方格加 garrison（不还池）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const terr = findCoord((t) => t.type === 'resource', 30, 30);
    await svc.occupyTile(W, 'a', terr.x, terr.y); // 直占建一块己方领地（garrison=500）
    const before = (await svc.getMe(W, 'a')).troops;

    const mv = await svc.startMarch(W, 'a', 5, 5, terr.x, terr.y, 'reinforce', 300);
    expect((await svc.getMe(W, 'a')).troops).toBe(before - 300); // 出征扣兵

    nowMs += marchDurationSec(5, 5, terr.x, terr.y) * 1000;
    expect(await svc.processDueArrivals()).toBe(1);

    const tile = await svc.getTile(W, 'a', terr.x, terr.y);
    expect(tile.garrison).toBe(GARRISON_PER_TILE + 300); // 加到 garrison
    expect((await svc.getMe(W, 'a')).troops).toBe(before - 300); // 兵不回池
    void mv;
  });

  it('撤军：返程腿 + 到点退兵回池', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'neutral', 40, 40);
    const dur = marchDurationSec(5, 5, target.x, target.y);
    const mv = await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    nowMs += Math.floor((dur * 1000) / 2); // 走到一半撤军
    const back = await svc.recallMarch(W, 'a', mv.marchId);
    expect(back.kind).toBe('return');
    expect(back.fromTile).toBe(mv.toTile);
    expect(back.toTile).toBe(mv.fromTile);

    // 返程未到：兵仍在途。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE - OCCUPY_MIN_TROOPS);
    nowMs = back.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    // 退兵回池，目标未被占。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();
  });

  it('校验：非己方格出征 / 中心 / 已是己方领地 / 兵力不足 / 围攻类型未实现', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 从非己方格出征。
    await expect(svc.startMarch(W, 'a', 50, 50, 51, 51, 'occupy', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
    // 占世界中心。
    await expect(svc.startMarch(W, 'a', 5, 5, CENTER_X, CENTER_Y, 'occupy', OCCUPY_MIN_TROOPS)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    // 占领带兵不足 OCCUPY_MIN_TROOPS。
    const free = findCoord((t) => t.type === 'neutral', 30, 30);
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'occupy', 10)).rejects.toMatchObject({
      code: 'NO_TROOPS',
    });
    // 围攻/扫荡未实现。
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'attack', 100)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
    // 增援非己方格。
    await expect(svc.startMarch(W, 'a', 5, 5, free.x, free.y, 'reinforce', 100)).rejects.toMatchObject({
      code: 'TILE_NOT_OWNED',
    });
  });

  it('到达时目标已被他人占领 → 退兵回池（不夺地，S8-3）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const target = findCoord((t) => t.type === 'neutral', 40, 40);
    await svc.startMarch(W, 'a', 5, 5, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    // 行军在途时，b 直占了该格（保护期已过的模拟：直接写他人 territory）。
    await m.collections.tiles.insertOne({
      _id: tileId(W, target.x, target.y),
      worldId: W,
      x: target.x,
      y: target.y,
      type: 'territory',
      level: 1,
      ownerId: 'b',
      garrison: GARRISON_PER_TILE,
      rev: 0,
    });

    nowMs += marchDurationSec(5, 5, target.x, target.y) * 1000;
    expect(await svc.processDueArrivals()).toBe(1);
    // a 没夺到，兵退回池；该格仍归 b。
    expect((await svc.getMe(W, 'a')).troops).toBe(TROOP_CAP_BASE);
    expect((await svc.getTile(W, 'a', target.x, target.y)).mine).toBeUndefined();
  });
});
