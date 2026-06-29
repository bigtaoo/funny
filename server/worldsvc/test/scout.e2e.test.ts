// worldsvc scout march end-to-end (G5 V2 remaining items, §18.1 V2 / §18.2): real Mongo. Entire suite skipped if Mongo is unreachable.
//   scout = a non-combat, non-occupying march: dispatch a small number of troops to any non-obstacle tile (including enemy/neutral),
//   illuminating a larger vision radius along the path and at the destination (VISION_SCOUT_RADIUS=4 > normal march 2);
//   automatically flips to a return leg on arrival and refunds troops to pool.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_SCOUT_RADIUS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_scout_test';
const W = 's1-scout';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.scout.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

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

describe.skipIf(!mongo)('worldsvc scout march e2e (G5 V2)', () => {
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
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('侦察发往敌方格：不打不占、不发 under_attack 预警，目标归属不变', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'def', 40, 40); // def 主城（敌方格、有保护期/驻军）
    pushes = [];

    // a 侦察 def 主城（被占领格）——startMarch 不抛、kind=scout。
    const mv = await svc.startMarch(W, 'a', 5, 5, 40, 40, 'scout', 1);
    expect(mv.kind).toBe('scout');
    // 侦察不是进攻：def 不应收到 under_attack 预警。
    expect(pushes.filter((p) => p.accountId === 'def' && p.msg.kind === 'under_attack')).toHaveLength(0);

    // 到点落地：不占领——def 仍是该格主人（owner 经 mine/occupied 信号，无裸 ownerId）。
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const tile = await svc.getTile(W, 'def', 40, 40);
    expect(tile.mine).toBe(true);
    expect(tile.occupied).toBe(true);
  });

  it('侦察视野更深：抵达点照亮 chebyshev≤4 的格，>4 仍迷雾（半径 = VISION_SCOUT_RADIUS）', async () => {
    expect(VISION_SCOUT_RADIUS).toBe(4); // 守住「比普通行军 2 更深」的契约
    await svc.joinWorld(W, 'a', 5, 5);
    // 远在基地视野（半径 5）之外的中立目标。
    const dst = findCoord(NEUTRAL, 5, 30);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'scout', 1);

    // now=arriveAt：插值位置 = dst（行军文档仍在，getMap 不消费到达）。空格的 visible 标记仅 getMap 给出。
    nowMs = mv.arriveAt;
    const map = await svc.getMap(W, 'a', dst.x, dst.y, 6);
    const at = (x: number, y: number) => map.tiles.find((tt) => tt.x === x && tt.y === y);
    // chebyshev 4 = 视野边缘 → 可见（普通行军半径 2 探不到这么深）。
    expect(at(dst.x + 4, dst.y)?.visible).toBe(true);
    // chebyshev 5 → 越界，且无其他视野源 → 迷雾。
    expect(at(dst.x + 5, dst.y)?.visible).toBe(false);
  });

  it('侦察自动回师：到点翻转为 return 腿，原兵力原路返回后退回兵池', async () => {
    const me0 = await svc.joinWorld(W, 'a', 5, 5);
    const troops0 = me0.troops ?? 0;
    expect(troops0).toBeGreaterThan(0);

    const dst = findCoord(NEUTRAL, 5, 30);
    const out = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'scout', 1);
    expect((await svc.getMe(W, 'a')).troops).toBe(troops0 - 1); // 出征扣兵（在途）

    // 去程到点 → 自动生成返程腿（不退兵）。
    nowMs = out.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const afterArrive = await svc.getMarches(W, 'a');
    const back = afterArrive.find((mm) => mm.kind === 'return' && mm.mine);
    expect(back).toBeTruthy();
    expect(back!.fromTile).toBe(`${W}:${dst.x}:${dst.y}`); // 从目标返回
    expect(back!.toTile).toBe(`${W}:5:5`);                 // 回出发格
    expect((await svc.getMe(W, 'a')).troops).toBe(troops0 - 1); // 返程在途，仍未退

    // 返程到点 → 兵力归池。
    nowMs = back!.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const meEnd = await svc.getMe(W, 'a');
    expect(meEnd.troops).toBe(troops0);
    // 侦察全程不占地：领地数仍为 1（仅主城），dst 没被写成新领地。
    expect(meEnd.territoryCount).toBe(1);
    expect(await m.collections.tiles.findOne({ _id: `${W}:${dst.x}:${dst.y}` })).toBeNull();
  });
});
