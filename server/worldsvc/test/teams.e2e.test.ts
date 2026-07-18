// worldsvc attack formation templates (teams) + siege team attachment + replay spectating end-to-end (G3-2c, §16.2/§16.3): real Mongo.
//   ① setTeams/getTeams: validates team count cap / unique ids / valid formation (engine levelSchema) + round-trip read/write;
//   ② startMarch attack with teamId → committed troops = sum of all unit allocations in the team; army snapshot persisted with march;
//      authoritative siege is run with the real formation when the march arrives;
//   ③ getSiegeReplay: after a key siege, seed + both formations are persisted; attacker and defender can read, spectators are rejected;
//   ④ custom defender formation benefits from the national bonus (buildDefenderConfig scaleArmyHp path).
//
// CC-3: every army entry is card-based (`cardInstanceId`, resolved via a fake meta client's `cardInv`) — the
// pre-CC-3 raw `{unitType, initialHp}` format has no compat path (`sanitizeCardArmy` drops it silently on
// save), so tests build teams from a pool of fake owned cards and set each card's `cardState.currentTroops`
// directly (mirroring `distributeTroops`, without its baseTroopStock bookkeeping).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  npcGarrison,
  playerWorldId,
  SLG_MAP_W,
  SLG_MAP_H,
  SIEGE_TEAM_CAP,
  TROOP_CAP_BASE,
  type CardInstance,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, TeamTemplate } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

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
if (!mongo) console.warn(`[worldsvc.teams.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

function findCoord(
  sx: number,
  sy: number,
  predicate?: (t: ReturnType<typeof proceduralTile>) => boolean,
): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y);
        if (t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'center') continue;
        if (predicate && !predicate(t)) continue;
        return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so an attack march to a far-away target clears the new gate.
 */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    const t = proceduralTile(W, nx, ny);
    if (t.type === 'obstacle' || t.type === 'center' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold') continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

// Fake owned-card pool for account 'a' — all `lichuang` (unitType 'infantry'), matching the old
// raw-unitType fixtures this suite used before the CC-3 card migration.
const CARD_DEF_ID = 'lichuang';
const CARD_IDS = Array.from({ length: 100 }, (_, i) => `card${i}`);
const CARD_INV_A: Record<string, CardInstance> = Object.fromEntries(
  CARD_IDS.map((id) => [id, { id, defId: CARD_DEF_ID, level: 1, xp: 0, gear: {}, locked: false }]),
);
const fakeMeta: WorldMetaClient = {
  available: true,
  async getSaveFields(accountId: string) {
    if (accountId !== 'a') return null;
    return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_A };
  },
  async getProfile() { return null; },
  async grantMaterial() {},
  async grantTitle() {},
};

describe.skipIf(!mongo)('worldsvc teams + siege replay e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let pushes: { accountId: string; msg: SlgPushMsg }[];
  let cardCursor = 0;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(accountId, msg) {
      pushes.push({ accountId, msg });
    },
    async broadcast(recipients, msg) {
      for (const accountId of recipients) pushes.push({ accountId, msg });
    },
  };

  /** Next `n` fresh card ids from the shared pool — fresh per call so sibling teams/tests never collide on the same card. */
  function nextCardIds(n: number): string[] {
    const ids = CARD_IDS.slice(cardCursor, cardCursor + n);
    cardCursor += n;
    if (ids.length < n) throw new Error('card pool exhausted; raise CARD_IDS length');
    return ids;
  }

  /** A valid card-based attack formation: n fresh cards spread across row 1 lanes. Caller sets each card's troops via setTroops. */
  function army(n: number): { entries: TeamTemplate['army']; ids: string[] } {
    const ids = nextCardIds(n);
    const lanes = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
    const entries = ids.map((id, i) => ({ cardInstanceId: id, col: lanes[i % lanes.length]!, row: 1 + Math.floor(i / lanes.length) }));
    return { entries, ids };
  }

  /** Sets each card's cardState.currentTroops directly (mirrors distributeTroops without its baseTroopStock bookkeeping). */
  async function setTroops(accountId: string, ids: string[], hp: number): Promise<void> {
    const set: Record<string, number> = {};
    for (const id of ids) set[`cardState.${id}.currentTroops`] = hp;
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, accountId) }, { $set: set });
  }

  /** army(n) + setTroops(hp) in one call — the common case where every unit carries the same troop count. */
  async function armyWithTroops(accountId: string, n: number, hp: number): Promise<TeamTemplate['army']> {
    const { entries, ids } = army(n);
    await setTroops(accountId, ids, hp);
    return entries;
  }

  async function setupDefender(accountId: string, x: number, y: number, garrison: number, ink = 0): Promise<void> {
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
      resources: { ink, paper: 0, graphite: 0, metal: 0, sticker: 0 },
      yieldRate: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
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
    cardCursor = 0;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
      meta: fakeMeta,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('setTeams/getTeams round-trip; validates cap / unique ids / valid formation', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const teams: TeamTemplate[] = [
      { id: 't1', name: 'Vanguard', army: army(3).entries },
      { id: 't2', name: 'Main Force', army: army(5).entries },
    ];
    await svc.setTeams(W, 'a', teams);
    expect(await svc.getTeams(W, 'a')).toEqual(teams);

    // over the cap → rejected.
    const tooMany = Array.from({ length: SIEGE_TEAM_CAP + 1 }, (_, i) => ({
      id: `t${i}`,
      name: `q${i}`,
      army: army(1).entries,
    }));
    await expect(svc.setTeams(W, 'a', tooMany)).rejects.toThrow();
    // duplicate id → rejected.
    await expect(
      svc.setTeams(W, 'a', [
        { id: 'dup', name: 'x', army: army(1).entries },
        { id: 'dup', name: 'y', army: army(1).entries },
      ]),
    ).rejects.toThrow();
    // invalid formation (out-of-bounds column) → rejected.
    const [badId] = nextCardIds(1);
    await expect(
      svc.setTeams(W, 'a', [{ id: 't1', name: 'bad', army: [{ cardInstanceId: badId, col: 99, row: 1 }] }]),
    ).rejects.toThrow();
    // validation failure does not persist (teams remain from the first successful call).
    expect(await svc.getTeams(W, 'a')).toEqual(teams);
  });

  it('an army entry with no cardInstanceId (pre-CC-3 raw unit-type format) is dropped silently, not rejected', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const { entries, ids } = army(2);
    await setTroops('a', ids, 60);
    const legacyEntry = { unitType: 'infantry', col: 5, row: 1, initialHp: 999 } as unknown as TeamTemplate['army'][number];
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Mixed', army: [...entries, legacyEntry] }]);
    const saved = await svc.getTeams(W, 'a');
    expect(saved[0]!.army).toHaveLength(2); // the legacy entry never persisted
    expect(saved[0]!.army.every((e) => !!e.cardInstanceId)).toBe(true);
  });

  it('setTeams drops a stale cardInstanceId (card no longer owned — fed/consumed since the team was built) and frees it: teamId/currentTroops cleared, resources refunded', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    const { entries, ids } = army(2);
    await setTroops('a', ids, 60);
    // A card the team references was consumed (fed to another card) after being assigned — its id is no
    // longer in cardInv (CARD_INV_A never contains 'card-fed'), but cardState still has a stale ledger entry
    // as if it had been on a team with troops.
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      { $set: { 'cardState.card-fed': { currentTroops: 100, teamId: 't1' } } },
    );
    const staleEntry = { cardInstanceId: 'card-fed', col: 8, row: 2 };
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Mixed', army: [...entries, staleEntry] }]);

    const saved = await svc.getTeams(W, 'a');
    expect(saved[0]!.army).toHaveLength(2); // the stale entry never persisted
    expect(saved[0]!.army.some((e) => e.cardInstanceId === 'card-fed')).toBe(false);

    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.cardState?.['card-fed']?.currentTroops).toBe(0);
    expect(pw?.cardState?.['card-fed']?.teamId).toBeNull();
    // 80% refund of the 100 troops it carried (CARD_TROOP_*_COST × CARD_TROOP_REFUND_RATE), same terms as an explicit removal.
    expect(pw?.resources?.paper).toBeGreaterThan(0);
  });

  it('getTeams self-heals pre-existing bad data (written directly, bypassing setTeams): drops unresolvable entries, persists the cleanup once, frees the card', async () => {
    const pwId = playerWorldId(W, 'a');
    await svc.joinWorld(W, 'a', 5, 5);
    const { entries, ids } = army(1);
    await setTroops('a', ids, 40);
    // Simulate data that predates this fix (or a direct-DB edge case): a team with one valid card entry and
    // one that never resolves (no matching cardInv id), plus a matching stale cardState ledger with troops.
    await m.collections.playerWorld.updateOne(
      { _id: pwId },
      {
        $set: {
          teams: [{ id: 't1', name: 'Stale', army: [...entries, { cardInstanceId: 'card-ghost', col: 9, row: 2 }] }],
          'cardState.card-ghost': { currentTroops: 50, teamId: 't1' },
        },
      },
    );

    const healed = await svc.getTeams(W, 'a');
    expect(healed[0]!.army).toHaveLength(1);
    expect(healed[0]!.army[0]!.cardInstanceId).toBe(ids[0]);

    // self-heal persisted: re-reading returns the same cleaned result, and the freed card was refunded.
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.teams?.[0]?.army).toHaveLength(1);
    expect(pw?.cardState?.['card-ghost']?.currentTroops).toBe(0);
    expect(pw?.cardState?.['card-ghost']?.teamId).toBeNull();
    expect(pw?.resources?.paper).toBeGreaterThan(0);

    // idempotent: a second read doesn't re-refund (the ghost card's teamId is already cleared).
    const paperAfterFirstHeal = pw!.resources.paper;
    await svc.getTeams(W, 'a');
    const pw2 = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw2?.resources?.paper).toBe(paperAfterFirstHeal);
  });

  it('setTeams/getTeams fail closed (not destructive) when the meta cardInv lookup is unavailable', async () => {
    const pwId = playerWorldId(W, 'nometa');
    // fakeMeta only serves 'a' — any other account gets getSaveFields() => null, simulating metaserver being down.
    await svc.joinWorld(W, 'nometa', 6, 6);
    // Pre-seed teams directly (as if saved earlier while meta was reachable).
    const seeded = [{ id: 't1', name: 'Seeded', army: [{ cardInstanceId: 'card-x', col: 0, row: 1 }] }];
    await m.collections.playerWorld.updateOne({ _id: pwId }, { $set: { teams: seeded } });

    // setTeams must reject rather than silently persist an emptied-out team.
    await expect(svc.setTeams(W, 'nometa', [{ id: 't1', name: 'New', army: [{ cardInstanceId: 'card-y', col: 0, row: 1 }] }]))
      .rejects.toThrow(/unavailable/i);
    // getTeams degrades to returning the stored data as-is, rather than wiping it because cardInv couldn't be checked.
    expect(await svc.getTeams(W, 'nometa')).toEqual(seeded);
    const pw = await m.collections.playerWorld.findOne({ _id: pwId });
    expect(pw?.teams).toEqual(seeded); // untouched
  });

  it('siege with team: committed = sum of team allocations; army snapshot persisted with march; authoritative siege runs on arrival + replayable', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Low tile level (findCoord's usual level<=2 constraint, matching the occupation-hold test below) — a
    // territory tile's symbolic base HP (npcBaseHp(level)) scales with level, and a single-battle assault
    // must destroy it within the tick limit; a high-level tile's base HP can outlast any one battle regardless
    // of garrison strength.
    const tgt = findCoord(10, 5, (t) => t.level <= 2);
    await setupDefender('b', tgt.x, tgt.y, 100, 800);
    await connect(svc, 'a', tgt); // ADR-039: border the target before attacking

    // 12 infantry (CARD_TEAM_MAX_SIZE cap), each carrying 160 troops via cardState (not initialHp — card
    // entries carry none, so `march.troops` below degenerates to a card count; see combatMarch.ts's CC-3 note);
    // 12×160 = 1920 stays under the default (no-satchel) 2000 carry cap. An overwhelming force over the
    // 100 garrison → capture.
    const entries = await armyWithTroops('a', 12, 160);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Assault', army: entries }]);
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1');
    expect(mv.troops).toBe(12); // card-army march.troops degenerates to card count (real strength is in cardState)

    // march is persisted to the database with the army snapshot.
    const marchDoc = await m.collections.marches.findOne({ _id: mv.marchId });
    expect(marchDoc?.army).toHaveLength(12);

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // tile ownership changes hands (12-unit assault overwhelms the 100 garrison).
    const tile = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(tile?.mine).toBe(true);

    // battle report persists replay inputs.
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege).toBeTruthy();
    expect(typeof siege!.seed).toBe('number');
    expect(siege!.attackerArmy).toHaveLength(12);

    // attacker can read the replay level; it includes the attacker army.
    const replay = await svc.getSiegeReplay(W, 'a', siege!._id);
    expect(replay.seed).toBe(siege!.seed);
    expect(replay.outcome).toBe('attacker_win');
    expect(Array.isArray((replay.level as { attackerArmy?: unknown }).attackerArmy)).toBe(true);
    // defender can also read; spectators are rejected.
    await expect(svc.getSiegeReplay(W, 'b', siege!._id)).resolves.toBeTruthy();
    await expect(svc.getSiegeReplay(W, 'c', siege!._id)).rejects.toThrow();

    // §16.3 replay names: attacker resolves via the fake meta client; defender 'b' has no profile → blank.
    expect(replay.attackerName).toBe('');
    expect(replay.defenderName).toBe('');

    // With a meta client that also serves profiles, the display names resolve. Owner→side mapping: attacker → bottom, defender → top.
    const svcNamed = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
      meta: {
        ...fakeMeta,
        async getProfile(id: string) {
          return { publicId: id, displayName: id === 'a' ? 'Alice' : id === 'b' ? 'Bob' : '' };
        },
      },
    });
    const named = await svcNamed.getSiegeReplay(W, 'a', siege!._id);
    expect(named.attackerName).toBe('Alice');
    expect(named.defenderName).toBe('Bob');
  });

  it('satchel cap: a team carrying more troops than satchelCarryCapFor(buildings) is rejected (SATCHEL_CAP_EXCEEDED)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(10, 5);
    await setupDefender('b', tgt.x, tgt.y, 50);
    await connect(svc, 'a', tgt);
    // no satchel built → cap = SATCHEL_CARRY_BASE (2000, = TROOP_CAP_BASE); 12 units × 200 = 2400 committed exceeds it.
    const entries = await armyWithTroops('a', 12, 200);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Overloaded', army: entries }]);
    await expect(svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1')).rejects.toThrow(/satchel/i);

    // building satchel raises the cap enough for the same team to depart.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, 'a') }, { $set: { buildings: { desk: 1, satchel: 1 } } });
    await expect(svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 1, 't1')).resolves.toBeTruthy();
  });

  it('idle-team gate: a team en route to an attack rejects a second order (TEAM_BUSY)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt1 = findCoord(10, 5);
    const tgt2 = findCoord(5, 10);
    await setupDefender('b', tgt1.x, tgt1.y, 50);
    await setupDefender('c', tgt2.x, tgt2.y, 50);
    await connect(svc, 'a', tgt1);
    await connect(svc, 'a', tgt2);
    const entries = await armyWithTroops('a', 10, 60);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Vanguard', army: entries }]);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt1.x, tgt1.y, 'attack', 1, 't1');
    expect(mv.status).toBe('marching');

    // t1 is still en route → a second order onto the same team is rejected, not silently re-dispatched
    // (this is the reported bug: the UI let a busy team's order get silently overridden by a new one).
    await expect(svc.startMarch(W, 'a', 5, 5, tgt2.x, tgt2.y, 'attack', 1, 't1')).rejects.toThrow(/marching or occupying/i);

    // once the attack lands (instant — no hold for an owned-territory siege), the team is free again.
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    await expect(svc.startMarch(W, 'a', 5, 5, tgt2.x, tgt2.y, 'attack', 1, 't1')).resolves.toBeTruthy();
  });

  it('idle-team gate: a team stays "out" through the occupation-hold countdown, not just in transit', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord(30, 30, (t) => t.type === 'resource' && t.level <= 2);
    const proc = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(proc.level);
    await connect(svc, 'a', target);

    // enough troops per unit to overwhelm the NPC garrison comfortably.
    const entries = await armyWithTroops('a', 12, Math.ceil(npc / 8) + 100);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Vanguard', army: entries }]);
    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // won the PvE battle → occupation hold pending (tile not yet owned) → team is still "out" during the hold.
    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);
    const other = findCoord(5, 5);
    await expect(svc.startMarch(W, 'a', 10, 10, other.x, other.y, 'attack', 1, 't1')).rejects.toThrow(/marching or occupying/i);

    // hold elapses → ownership lands → team is free again.
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    const target2 = findCoord(20, 40);
    await setupDefender('d', target2.x, target2.y, 50);
    await connect(svc, 'a', target2);
    await expect(svc.startMarch(W, 'a', 10, 10, target2.x, target2.y, 'attack', 1, 't1')).resolves.toBeTruthy();
  });

  it('cancelOccupation: team management can force a mid-hold team back to idle instantly, no troop refund, tile reverts to unclaimed', async () => {
    await svc.joinWorld(W, 'a', 10, 10);
    const target = findCoord(30, 30, (t) => t.type === 'resource' && t.level <= 2);
    const proc = proceduralTile(W, target.x, target.y);
    const npc = npcGarrison(proc.level);
    await connect(svc, 'a', target);

    const entries = await armyWithTroops('a', 12, Math.ceil(npc / 8) + 100);
    await svc.setTeams(W, 'a', [{ id: 't1', name: 'Vanguard', army: entries }]);
    const mv = await svc.startMarch(W, 'a', 10, 10, target.x, target.y, 'occupy', 1, 't1');
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    const held = await svc.getTile(W, 'a', target.x, target.y);
    expect(held.contestedByMe).toBe(true);
    const poolBefore = (await svc.getMe(W, 'a')).troops;

    // player cancels from Team Management, mid-hold (no need to wait out OCCUPY_HOLD_SEC).
    await svc.cancelOccupation(W, 'a', 't1');
    expect(await svc.getOccupations(W, 'a')).toHaveLength(0);

    // garrison was forfeited, not refunded (unlike march recall) — troop pool unchanged by the cancel itself.
    expect((await svc.getMe(W, 'a')).troops).toBe(poolBefore);

    // team is idle right away — a brand-new order dispatches immediately, no TEAM_BUSY.
    const other = findCoord(20, 40);
    await setupDefender('d', other.x, other.y, 50);
    await connect(svc, 'a', other);
    await expect(svc.startMarch(W, 'a', 10, 10, other.x, other.y, 'attack', 1, 't1')).resolves.toBeTruthy();

    // tile reverts to unclaimed (not settled to the canceller, not left mid-contest for anyone else).
    const afterCancel = await svc.getTile(W, 'a', target.x, target.y);
    expect(afterCancel.mine).toBeFalsy();
    expect(afterCancel.contestedByMe).toBeFalsy();

    // cancelling again (nothing left to cancel) is rejected.
    await expect(svc.cancelOccupation(W, 'a', 't1')).rejects.toThrow();
  });
});
