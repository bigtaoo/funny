// worldsvc 险地（stronghold，G8 §3.1）端到端：真实 Mongo + 假时钟 + 捕获 push。
//   险地 = 程序化生成的高战略价值 PvE 格，系统超强 NPC 驻守，不可直占/扫荡，只能围攻 attack 攻克。
//   ① 攻克胜（大军压境）→ 占为 territory 领地（残存折回成驻军）+ 一次性丰厚资源奖励 + sieges
//      attacker_win + siege_result/tile_update 推送 + territoryCount +1；
//   ② 攻克败（兵力不足）→ 不占领（仍是无主程序化险地）+ 残兵撤退回师 + sieges defender_win + 无奖励；
//   ③ 校验：直占险地 / 扫荡险地 → 抛错（须围攻）；落城险地 → 抛错。
// 注：兵力数 → 引擎布阵走 synthesizeArmy 合成，残存由引擎/兜底决定，断言只校验「方向 + 结构效应」。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_stronghold_test';
const W = 's1-stronghold';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.stronghold.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** 全图扫描出第一块险地（程序化、确定性）。 */
function findStronghold(): { x: number; y: number; level: number } {
  for (let y = 0; y < SLG_MAP_H; y++) {
    for (let x = 0; x < SLG_MAP_W; x++) {
      const t = proceduralTile(W, x, y);
      if (t.type === 'stronghold') return { x, y, level: t.level };
    }
  }
  throw new Error('no stronghold tile in world (调参检查 SLG_GEN.stronghold*)');
}

/** 险地附近最近的可落城/可达格（非障碍/关隘/中心/险地），作攻方主城落点。 */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 1; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y);
        if (t.type === 'obstacle' || t.type === 'gate' || t.type === 'center' || t.type === 'stronghold') continue;
        return { x, y };
      }
    }
  }
  throw new Error('no base tile near stronghold');
}

describe.skipIf(!mongo)('worldsvc stronghold e2e (G8)', () => {
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

  const sh = findStronghold();
  const base = findNearbyBase(sh.x, sh.y);

  /** 直接把攻方兵力池设到指定值（绕过训练，模拟养成强军）。 */
  async function setTroops(accountId: string, troops: number): Promise<void> {
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, accountId) },
      { $set: { troops, troopCap: Math.max(troops, TROOP_CAP_BASE) } },
    );
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

  it('险地生成：满级 + 带资源种类 + 守军远超普通格', () => {
    expect(sh.level).toBeGreaterThanOrEqual(1);
    const proc = proceduralTile(W, sh.x, sh.y);
    expect(proc.type).toBe('stronghold');
    expect(proc.resType).toBeDefined();
    expect(strongholdGarrison(sh.level)).toBeGreaterThan(500); // 远超 GARRISON_PER_TILE
  });

  it('直占险地 / 扫荡险地 → 抛错（须围攻 attack）', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await expect(svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'occupy', 600)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
    await expect(svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'sweep', 600)).rejects.toMatchObject({
      code: 'TILE_OCCUPIED',
    });
  });

  it('落城险地 → 抛错（险地不可作主城落点）', async () => {
    await expect(svc.joinWorld(W, 'z', sh.x, sh.y)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('攻克胜（大军）：占为领地 mine + 残存驻军 + 丰厚奖励 + sieges attacker_win + 推送', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 6000); // 养成强军，远超险地守军 → 必胜
    const before = (await svc.getMe(W, 'a')).resources!;

    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 6000);
    expect(mv).toMatchObject({ kind: 'attack', status: 'marching' });
    // 险地 PvE：防守方为 NPC，不推 under_attack。
    expect(pushes.find((p) => p.msg.kind === 'under_attack')).toBeUndefined();

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 攻克 → 占为 territory 领地。
    const tile = await svc.getTile(W, 'a', sh.x, sh.y);
    expect(tile).toMatchObject({ type: 'territory', mine: true });
    expect(tile.garrison).toBeGreaterThan(0);
    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(2); // 主城 + 攻克的险地

    // 一次性丰厚奖励到账（按格等级 × 资源种类）。
    const proc = proceduralTile(W, sh.x, sh.y);
    const rt = proc.resType ?? 'food';
    expect((me.resources?.[rt] ?? 0) - (before[rt] ?? 0)).toBeGreaterThanOrEqual(
      STRONGHOLD_LOOT_PER_LEVEL * sh.level,
    );

    // sieges attacker_win（NPC 防守 → 无 defenderId）+ siege_result 推攻方 + tile_update。
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toMatchObject({ outcome: 'attacker_win', tile: tileId(W, sh.x, sh.y) });
    expect(siege?.defenderId).toBeUndefined();
    expect(pushes.some((p) => p.msg.kind === 'siege_result' && p.accountId === 'a')).toBe(true);
    expect(pushes.some((p) => p.msg.kind === 'tile_update' && p.accountId === 'a')).toBe(true);
  });

  it('攻克败（兵力不足）：不占领 + 残兵撤退回师 + sieges defender_win + 无奖励', async () => {
    await svc.joinWorld(W, 'a', base.x, base.y);
    await setTroops('a', 600); // 远不及险地守军 → 必败
    const before = (await svc.getMe(W, 'a')).resources!;

    const mv = await svc.startMarch(W, 'a', base.x, base.y, sh.x, sh.y, 'attack', 600);
    expect((await svc.getMe(W, 'a')).troops).toBe(0); // 出征扣兵（600 全出征）

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 不占领：险地仍无主（程序化层不落库）。
    const proc = proceduralTile(W, sh.x, sh.y);
    expect(proc.type).toBe('stronghold');
    const raw = await m.collections.tiles.findOne({ _id: tileId(W, sh.x, sh.y) });
    expect(raw?.ownerId).toBeUndefined();

    const me = await svc.getMe(W, 'a');
    expect(me.territoryCount).toBe(1); // 仅主城
    // 无奖励（资源仅自身产出结算，不含掠夺）。
    const proc2 = proceduralTile(W, sh.x, sh.y);
    const rt = proc2.resType ?? 'food';
    expect((me.resources?.[rt] ?? 0)).toBeLessThan((before[rt] ?? 0) + STRONGHOLD_LOOT_PER_LEVEL);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });
});
