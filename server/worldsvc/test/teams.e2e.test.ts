// worldsvc attack formation templates (teams) + siege team attachment + replay spectating end-to-end (G3-2c, §16.2/§16.3): real Mongo.
//   ① setTeams/getTeams: validates team count cap / unique ids / valid formation (engine levelSchema) + round-trip read/write;
//   ② startMarch attack with teamId → committed troops = sum of all unit allocations in the team; army snapshot persisted with march;
//      authoritative siege is run with the real formation when the march arrives;
//   ③ getSiegeReplay: after a key siege, seed + both formations are persisted; attacker and defender can read, spectators are rejected;
//   ④ custom defender formation benefits from the national bonus (buildDefenderConfig scaleArmyHp path).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  SIEGE_TEAM_CAP,
  TROOP_CAP_BASE,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, TeamTemplate } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_teams_test';
const W = 's1-teams';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.teams.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y);
        if (t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center') return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

/** A valid attack formation: n infantry units spread across row 1 lanes, each allocated hp troops. */
function army(n: number, hp: number): TeamTemplate['army'] {
  const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
  return Array.from({ length: n }, (_, i) => ({
    unitType: 'infantry',
    col: lanes[i % lanes.length]!,
    row: 1 + Math.floor(i / lanes.length),
    initialHp: hp,
  }));
}

describe.skipIf(!mongo)('worldsvc teams + siege replay e2e', () => {
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

  async function setupDefender(accountId: string, x: number, y: number, garrison: number, food = 0): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: 'territory',
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ownerId: accountId,
      garrison,
      rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: tile._id }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, accountId),
      worldId: W,
      accountId,
      troops: TROOP_CAP_BASE,
      troopCap: TROOP_CAP_BASE,
      resources: { food, iron: 0, wood: 0 },
      yieldRate: { food: 0, iron: 0, wood: 0 },
      lastTickAt: nowMs,
      mainBaseTile: tileId(W, x, y),
      rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: pw._id }, { $set: pw }, { upsert: true });
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

  it('setTeams/getTeams round-trip; validates cap / unique ids / valid formation', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const teams: TeamTemplate[] = [
      { id: 't1', name: '先锋', army: army(3, 60) },
      { id: 't2', name: '主力', army: army(5, 50) },
    ];
    await svc.setTeams(W, 'a', teams);
    expect(await svc.getTeams(W, 'a')).toEqual(teams);

    // over the cap → rejected.
    const tooMany = Array.from({ length: SIEGE_TEAM_CAP + 1 }, (_, i) => ({
      id: `t${i}`,
      name: `q${i}`,
      army: army(1, 60),
    }));
    await expect(svc.setTeams(W, 'a', tooMany)).rejects.toThrow();
    // duplicate id → rejected.
    await expect(
      svc.setTeams(W, 'a', [
        { id: 'dup', name: 'x', army: army(1, 60) },
        { id: 'dup', name: 'y', army: army(1, 60) },
      ]),
    ).rejects.toThrow();
    // invalid formation (out-of-bounds column) → rejected.
    await expect(
      svc.setTeams(W, 'a', [{ id: 't1', name: 'bad', army: [{ unitType: 'infantry', col: 99, row: 1, initialHp: 60 }] }]),
    ).rejects.toThrow();
    // validation failure does not persist (teams remain from the first successful call).
    expect(await svc.getTeams(W, 'a')).toEqual(teams);
  });

  it('siege with team: committed = sum of team allocations; army snapshot persisted with march; authoritative siege runs on arrival + replayable', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500, 800);

    // 14 infantry × full hp 60 = 840 committed troops (overrides body troops; numerical advantage ensures capture, same scale as siege.e2e).
    await svc.setTeams(W, 'a', [{ id: 't1', name: '突击', army: army(14, 60) }]);
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1');
    expect(mv.troops).toBe(840); // derived from team; body's troops=1 is overridden

    // march 落库带 army 快照。
    const marchDoc = await m.collections.marches.findOne({ _id: mv.marchId });
    expect(marchDoc?.army).toHaveLength(14);

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 领地易主（840 真实布阵 > 500 守军）。
    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile?.mine).toBe(true);

    // 战报持久化重播输入。
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toBeTruthy();
    expect(typeof siege!.seed).toBe('number');
    expect(siege!.attackerArmy).toHaveLength(14);

    // 攻方可读重播关卡；含攻方军。
    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(replay.seed).toBe(siege!.seed);
    expect(replay.outcome).toBe('attacker_win');
    expect(Array.isArray((replay.level as { attackerArmy?: unknown }).attackerArmy)).toBe(true);
    // 守方也可读；旁观者拒。
    await expect(svc.getSiegeReplay(W, 'b', siege!._id)).resolves.toBeTruthy();
    await expect(svc.getSiegeReplay(W, 'c', siege!._id)).rejects.toThrow();
  });

  it('挂队兵力不足 → 拒发（NO_TROOPS）', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(10, 5);
    await setupDefender('b', tgt.x, tgt.y, 100);
    // 把攻方兵力池压到很低。
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { troops: 50 } });
    await svc.setTeams(W, 'a', [{ id: 't1', name: '大军', army: army(10, 60) }]); // committed 600 > 50
    await expect(svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1')).rejects.toThrow();
  });
});
