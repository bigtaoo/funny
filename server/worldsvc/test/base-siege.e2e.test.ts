// ADR-026 main-base siege end-to-end: building HP + wave defenders (t1..t5) + delayed siege-value settlement.
//   ① no defenders → attacker auto-clears → delayed HP hit; HP survives a partial hit (survivors refunded, no capture);
//   ② enough cumulative siege value → HP depleted → forced relocation (old base gone, territory lost, new base + shield);
//   ③ wave battle: defeated defender team → injured SLG_TEAM_INJURY_MS; all teams cleared → HP hit scheduled;
//   ④ attacker wiped by a strong wave → defender_win, no HP hit scheduled, base HP untouched;
//   ⑤ out-team (on an active march) + injured team are skipped as defenders.
// Card armies bypass startMarch's flat-troop derivation (a pre-CC-3-integration nuance), so these tests insert the
// arriving MarchDoc directly and drive processDueArrivals/processDueSiegeDamage, isolating the siege mechanic.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  buildingMaxHp,
  teamSiegeValue,
  cardSiegeValue,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  type CardInstance,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, MarchDoc, TeamTemplate, CardSLGState } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient, SaveFields, PlayerProfile } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_base_siege_test';
const W = 's1-basesiege';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.base-siege.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

/** Builds a card team: cardInv entries (for the fake meta), army entries (referencing them), and cardState troops. */
function mkCards(prefix: string, n: number, troops = 60, defId = 'lichuang'): {
  inv: Record<string, CardInstance>;
  army: TeamTemplate['army'];
  state: Record<string, CardSLGState>;
} {
  const inv: Record<string, CardInstance> = {};
  const army: TeamTemplate['army'] = [];
  const state: Record<string, CardSLGState> = {};
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    inv[id] = { id, defId, level: 1, xp: 0, gear: {}, locked: false };
    army.push({ cardInstanceId: id, col: LANES[i % LANES.length]!, row: 1 + Math.floor(i / LANES.length) });
    state[id] = { currentTroops: troops };
  }
  return { inv, army, state };
}

describe.skipIf(!mongo)('ADR-026 base siege e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  /** cardInv exposed by the fake meta, keyed by accountId (mutated per test before the battle runs). */
  let cardInvByAccount: Record<string, Record<string, CardInstance>>;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) { pushes.push({ accountId, msg }); },
    async broadcast(recipients, msg) { for (const a of recipients) pushes.push({ accountId: a, msg }); },
  };

  const fakeMeta: WorldMetaClient = {
    available: true,
    async deductMaterial() { /* n/a */ },
    async grantMaterial() { /* n/a */ },
    async getProfile(): Promise<PlayerProfile | null> { return null; },
    async getSaveFields(accountId): Promise<SaveFields | null> {
      return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: cardInvByAccount[accountId] ?? {} };
    },
    async escrowEquipment() { throw new Error('n/a'); },
    async grantEquipment() { /* n/a */ },
    async escrowCard() { throw new Error('n/a'); },
    async grantCard() { /* n/a */ },
    async grantTitle() { /* n/a */ },
  };

  /** Find a non-blocking tile near (sx,sy). */
  function findCoord(sx: number, sy: number): { x: number; y: number } {
    const cx = Math.floor(SLG_MAP_W / 2), cy = Math.floor(SLG_MAP_H / 2);
    for (let r = 0; r < 80; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = sx + dx, y = sy + dy;
          if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
          if (x === cx && y === cy) continue;
          const t = proceduralTile(W, x, y);
          if (t.type !== 'obstacle' && t.type !== 'gate' && t.type !== 'center') return { x, y };
        }
      }
    }
    throw new Error('no matching tile found');
  }

  /** Writes a defender 'b' with a main-base anchor tile (level 1, given HP) + playerWorld (optional teams/cardState). */
  async function setupBase(
    x: number, y: number,
    opts: { hp: number; teams?: TeamTemplate[]; cardState?: Record<string, CardSLGState>; teamState?: PlayerWorldDoc['teamState']; ink?: number } = { hp: 100 },
  ): Promise<void> {
    const anchor = tileId(W, x, y);
    const tile: TileDoc = {
      _id: anchor, worldId: W, x, y, type: 'base', level: 1,
      ownerId: 'b', garrison: 500, hp: opts.hp, rev: 0,
    };
    await m.collections.tiles.updateOne({ _id: anchor }, { $set: tile }, { upsert: true });
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(W, 'b'), worldId: W, accountId: 'b',
      troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE,
      resources: { ink: opts.ink ?? 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      lastTickAt: nowMs, mainBaseTile: anchor,
      ...(opts.teams ? { teams: opts.teams } : {}),
      ...(opts.cardState ? { cardState: opts.cardState } : {}),
      ...(opts.teamState ? { teamState: opts.teamState } : {}),
      rev: 0,
    };
    await m.collections.playerWorld.updateOne({ _id: pw._id }, { $set: pw }, { upsert: true });
  }

  /** Inserts an already-arrived attack march by 'a' carrying a card army, then settles arrivals. */
  async function arriveAttack(toX: number, toY: number, army: TeamTemplate['army'], teamId = 't1'): Promise<void> {
    const doc: MarchDoc = {
      _id: `mA-${toX}-${toY}-${nowMs}`, worldId: W, ownerId: 'a',
      fromTile: tileId(W, 5, 5), toTile: tileId(W, toX, toY),
      kind: 'attack', troops: army.length * 60, army, teamId,
      departAt: nowMs, arriveAt: nowMs, status: 'marching', rev: 0,
    };
    await m.collections.marches.insertOne(doc);
    await svc.processDueArrivals();
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    pushes = [];
    cardInvByAccount = {};
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, meta: fakeMeta, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  /** Attacker 'a': join (own base) + set card inventory (fake meta) + card troops. Returns the attacker army entries. */
  async function setupAttacker(n: number, troops = 60, defId = 'lichuang'): Promise<TeamTemplate['army']> {
    await svc.joinWorld(W, 'a', 5, 5);
    const { inv, army, state } = mkCards('ca', n, troops, defId);
    cardInvByAccount['a'] = inv;
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, 'a') },
      { $set: Object.fromEntries(Object.entries(state).map(([id, s]) => [`cardState.${id}`, s])) },
    );
    return army;
  }

  it('no defenders + partial hit: HP reduced by team siege value, no capture, survivors refunded', async () => {
    const tgt = findCoord(20, 5);
    await setupBase(tgt.x, tgt.y, { hp: 100 }); // b has no teams → no defenders
    const army = await setupAttacker(3);         // siege value = sum of per-card 攻城值 (3 × lichuang L1)
    // Expected damage = the team's real per-card siege value (ADR-026), computed the same way as production.
    const expectedDamage = teamSiegeValue(army, cardInvByAccount['a']);

    await arriveAttack(tgt.x, tgt.y, army);

    // Garrison auto-cleared (no defenders) → a siege win is recorded and a delayed HP hit is scheduled (not yet applied).
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    const pending = await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) });
    expect(pending).toBeTruthy();
    expect(pending!.damage).toBe(expectedDamage);
    expect(pending!.dueAt).toBe(nowMs + SLG_SIEGE_DAMAGE_DELAY_MS);
    // HP not yet touched.
    expect((await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) }))!.hp).toBe(100);

    // Advance past the delay and settle: HP reduced by the team's siege value, base survives, still owned by b.
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    expect(await svc.processDueSiegeDamage()).toBe(1);
    const after = await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) });
    expect(after!.hp).toBe(100 - expectedDamage);
    expect(after!.ownerId).toBe('b');
    // Pending hit consumed.
    expect(await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) })).toBeNull();
  });

  it('siege value is per-card: a shieldbearer team dents HP more than an archer team of equal size', async () => {
    // ADR-026 §4: 攻城值 is a per-card attribute. chenshou (shieldbearer, wall-breaker) > suyuan (archer, glass cannon).
    const tgt = findCoord(20, 5);
    await setupBase(tgt.x, tgt.y, { hp: 100 });
    const shieldArmy = await setupAttacker(3, 60, 'chenshou');
    const expected = teamSiegeValue(shieldArmy, cardInvByAccount['a']);

    await arriveAttack(tgt.x, tgt.y, shieldArmy);
    const pending = await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) });
    expect(pending!.damage).toBe(expected);
    // Differentiation is real, not the old uniform 10/card: a 3-shieldbearer team out-sieges a 3-archer team.
    const archerInv = mkCards('cx', 3, 60, 'suyuan').inv;
    const archerArmy = mkCards('cx', 3, 60, 'suyuan').army;
    expect(expected).toBeGreaterThan(teamSiegeValue(archerArmy, archerInv));
    // And the per-card helper scales with level.
    expect(cardSiegeValue({ id: 'z', defId: 'chenshou', level: 5, xp: 0, gear: {}, locked: false }))
      .toBeGreaterThan(cardSiegeValue({ id: 'z', defId: 'chenshou', level: 1, xp: 0, gear: {}, locked: false }));
  });

  it('HP depleted → forced relocation (old base gone, territory lost, new base + protection shield)', async () => {
    const tgt = findCoord(20, 5);
    await setupBase(tgt.x, tgt.y, { hp: 25, ink: 1000 }); // one 3-card siege (30) exceeds 25
    // give b a territory tile that must be lost on relocation.
    const terr = findCoord(23, 5);
    await m.collections.tiles.updateOne(
      { _id: tileId(W, terr.x, terr.y) },
      { $set: { _id: tileId(W, terr.x, terr.y), worldId: W, x: terr.x, y: terr.y, type: 'territory', level: 1, ownerId: 'b', garrison: 100, rev: 0 } },
      { upsert: true },
    );
    const army = await setupAttacker(3);

    await arriveAttack(tgt.x, tgt.y, army);
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    expect(await svc.processDueSiegeDamage()).toBe(1);

    // Old base anchor + old territory reverted to neutral (deleted).
    expect((await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) }))?.ownerId).toBeUndefined();
    expect((await m.collections.tiles.findOne({ _id: tileId(W, terr.x, terr.y) }))?.ownerId).toBeUndefined();
    // b relocated to a fresh base (different tile, full HP, protection shield).
    const meB = await svc.getMe(W, 'b');
    expect(meB.mainBaseTile).toBeDefined();
    expect(meB.mainBaseTile).not.toBe(tileId(W, tgt.x, tgt.y));
    const newBase = await m.collections.tiles.findOne({ _id: meB.mainBaseTile! });
    expect(newBase?.type).toBe('base');
    expect(newBase?.hp).toBe(buildingMaxHp(newBase!.level));
    expect(newBase?.protectedUntil).toBeGreaterThan(nowMs);
    // Attacker looted (b had 1000 ink).
    expect((await svc.getMe(W, 'a')).resources?.ink).toBeGreaterThan(0);
  });

  it('wave battle: defeated defender teams are injured (10 min) and all-cleared schedules the HP hit', async () => {
    const tgt = findCoord(20, 5);
    // Defender b: two weak single-card teams t1,t2.
    const d = mkCards('cd', 2, 60);
    cardInvByAccount['b'] = d.inv;
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Guard1', army: [d.army[0]!] },
      { id: 't2', name: 'Guard2', army: [d.army[1]!] },
    ];
    await setupBase(tgt.x, tgt.y, { hp: 100, teams, cardState: d.state });
    // Overwhelming attacker (12 cards) clears both single-card waves (each wave = team + a minimal engine base).
    const army = await setupAttacker(12);

    await arriveAttack(tgt.x, tgt.y, army);

    const bPw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'b') });
    expect(bPw?.teamState?.['t1']?.injuredUntil).toBe(nowMs + SLG_TEAM_INJURY_MS);
    expect(bPw?.teamState?.['t2']?.injuredUntil).toBe(nowMs + SLG_TEAM_INJURY_MS);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    expect(await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) })).toBeTruthy();
  });

  it('attacker wiped by a strong wave → defender_win, no HP hit scheduled', async () => {
    const tgt = findCoord(20, 5);
    // Defender b: one strong 8-card team.
    const d = mkCards('cd', 8, 60);
    cardInvByAccount['b'] = d.inv;
    await setupBase(tgt.x, tgt.y, { hp: 100, teams: [{ id: 't1', name: 'Wall', army: d.army }], cardState: d.state });
    // Weak attacker (single card).
    const army = await setupAttacker(1);

    await arriveAttack(tgt.x, tgt.y, army);

    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
    // No delayed hit; base HP untouched.
    expect(await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) })).toBeNull();
    expect((await m.collections.tiles.findOne({ _id: tileId(W, tgt.x, tgt.y) }))!.hp).toBe(100);
  });

  it('out-team (on an active march) and injured team are skipped as defenders', async () => {
    const tgt = findCoord(20, 5);
    const d = mkCards('cd', 2, 60);
    cardInvByAccount['b'] = d.inv;
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Deployed', army: [d.army[0]!] }, // will be "out"
      { id: 't2', name: 'Hurt', army: [d.army[1]!] },     // will be injured
    ];
    await setupBase(tgt.x, tgt.y, {
      hp: 100, teams, cardState: d.state,
      teamState: { t2: { injuredUntil: nowMs + SLG_TEAM_INJURY_MS } },
    });
    // t1 is out on an active march (any non-recalled march by b referencing the team).
    await m.collections.marches.insertOne({
      _id: 'mB-out', worldId: W, ownerId: 'b', fromTile: tileId(W, tgt.x, tgt.y), toTile: tileId(W, 30, 30),
      kind: 'attack', troops: 60, teamId: 't1', departAt: nowMs, arriveAt: nowMs + 10_000_000, status: 'marching', rev: 0,
    });
    const army = await setupAttacker(3);

    await arriveAttack(tgt.x, tgt.y, army);

    // Both defender teams unavailable → no waves → auto-clear → HP hit scheduled; neither team newly injured by this siege.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    expect(await m.collections.siegeDamage.findOne({ tile: tileId(W, tgt.x, tgt.y) })).toBeTruthy();
    const bPw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, 'b') });
    expect(bPw?.teamState?.['t1']?.injuredUntil).toBeUndefined(); // out team not injured
    expect(bPw?.teamState?.['t2']?.injuredUntil).toBe(nowMs + SLG_TEAM_INJURY_MS); // pre-existing injury unchanged
  });
});
