// worldsvc 反向视野推送 端到端（G5-2，§18.1 V4）：真实 Mongo。Mongo 不可达整套 skip。
//   行军发起 / 格易主时，把事件推给「视野覆盖到它」的观察者（敌方行军进我视野即推），
//   视野够不着的玩家收不到。只在低频事件点做一次反向查询（非逐 tick）。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_vpush_test';
const W = 's1-vpush';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.vision-push.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
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

describe.skipIf(!mongo)('worldsvc reverse-vision push e2e (G5-2)', () => {
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

  const marchUpdatesTo = (acct: string) =>
    pushes.filter((p) => p.accountId === acct && p.msg.kind === 'march_update');
  const tileUpdatesTo = (acct: string) =>
    pushes.filter((p) => p.accountId === acct && p.msg.kind === 'tile_update');

  it('行军发起：路径进入观察者视野 → 推 march_update；视野够不着的玩家不推', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // obs 主城 (5,20)：基地视野半径罩住 a 从 (5,5)→(5,40) 的路径中段。
    await svc.joinWorld(W, 'obs', 5, 20);
    // far 远在 (250,250)，视野够不着。
    await svc.joinWorld(W, 'far', 250, 250);

    const dst = findCoord(NEUTRAL, 5, 40);
    await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', OCCUPY_MIN_TROOPS);

    // 行军主自己收到。
    expect(marchUpdatesTo('a').length).toBeGreaterThan(0);
    // 观察者（视野覆盖路径）收到。
    expect(marchUpdatesTo('obs').length).toBeGreaterThan(0);
    // 视野够不着的玩家收不到。
    expect(marchUpdatesTo('far')).toHaveLength(0);
  });

  it('直占新领地：落在观察者视野内 → 推 tile_update（占领者本人不重复推、远端不推）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'obs', 10, 10); // 基地视野半径 5 罩住 (12,11)
    await svc.joinWorld(W, 'far', 250, 250);
    pushes = []; // 清掉 join 自身的推送

    // a 直占 (12,11)（落在 obs 视野内）。
    await svc.occupyTile(W, 'a', 12, 11);

    // obs 看得见这块新领地 → 收 tile_update。
    const obsTu = tileUpdatesTo('obs');
    expect(obsTu.length).toBeGreaterThan(0);
    expect((obsTu[0]!.msg as { ownerId: string }).ownerId).toBe('a');
    // 占领者 a 不经反向推送（占领走 REST 回包，pushTileToObservers 排除本人）。
    expect(tileUpdatesTo('a')).toHaveLength(0);
    // 远端 far 看不见 → 不推。
    expect(tileUpdatesTo('far')).toHaveLength(0);
  });

  it('围攻易主：新归属对视野内第三方观察者可见（攻守双方各自单独收，不计入观察者）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // 防守方 def 的领地 (8,8)；第三方 obs 主城 (10,10) 视野罩住 (8,8)。
    await svc.joinWorld(W, 'def', 40, 40);
    await svc.joinWorld(W, 'obs', 10, 10);
    // def 在 (8,8) 建一块可被攻的领地（直接写 TileDoc，弱守军，无保护罩）。
    const tgt = findCoord((t) => t.type !== 'obstacle' && t.type !== 'center', 8, 8);
    await m.collections.tiles.updateOne(
      { _id: `${W}:${tgt.x}:${tgt.y}` },
      { $set: { _id: `${W}:${tgt.x}:${tgt.y}`, worldId: W, x: tgt.x, y: tgt.y, type: 'territory', level: 1, ownerId: 'def', garrison: 1, rev: 0 } },
      { upsert: true },
    );
    pushes = [];

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 800);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 易主后，第三方观察者 obs（视野罩住该格）收 tile_update，新 owner=a。
    const obsTu = tileUpdatesTo('obs').filter((p) => (p.msg as { ownerId: string }).ownerId === 'a');
    expect(obsTu.length).toBeGreaterThan(0);
  });

  it('getMarches：己方行军 mine:true + 视野内敌方行军 mine:false + 视野外敌方不返回', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 8, 8);        // 落在 a 基地视野内（chebyshev 3 ≤ 5）
    await svc.joinWorld(W, 'far', 250, 250);  // 视野外

    // a 自己的占领行军。
    const aDst = findCoord(NEUTRAL, 5, 9);
    await svc.startMarch(W, 'a', 5, 5, aDst.x, aDst.y, 'occupy', OCCUPY_MIN_TROOPS);
    // e 的行军：出发点 (8,8) 在 a 视野内 → 出征瞬间 interp≈(8,8) 可见。
    const eDst = findCoord(NEUTRAL, 8, 12);
    await svc.startMarch(W, 'e', 8, 8, eDst.x, eDst.y, 'occupy', OCCUPY_MIN_TROOPS);
    // far 的行军：远端，a 视野够不着。
    const fDst = findCoord(NEUTRAL, 250, 255);
    await svc.startMarch(W, 'far', 250, 250, fDst.x, fDst.y, 'occupy', OCCUPY_MIN_TROOPS);

    const marches = await svc.getMarches(W, 'a');
    const own = marches.filter((m) => m.mine);
    const enemy = marches.filter((m) => m.mine === false);
    expect(own.length).toBe(1);
    expect(own[0]!.fromTile).toBe(`${W}:5:5`);
    // 视野内的敌方行军 e 返回（mine:false）；视野外的 far 不返回。
    expect(enemy.length).toBe(1);
    expect(enemy[0]!.fromTile).toBe(`${W}:8:8`);
  });
});
