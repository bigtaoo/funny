// worldsvc wild-city SIEGE (ADR-074 P1) end-to-end: real Mongo + fake clock.
//
// P0 (see city-ground.e2e.test.ts) only closed the holes — a city was un-takeable by any route. P1 makes it
// a real entity: a `CityDoc` with durability that regenerates, a per-march NPC wave ladder, sect-gated
// attack, and sect ownership on capture. Every case here fails on P0's code.
//
// The three things worth stating up front, because they are the ones the design doc got wrong and the
// econ-sim measurement corrected (ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE):
//   • the wave ladder is PER-MARCH, never shared city state with a respawn timer — a shared empty ladder
//     hands out free full-damage hits to every march arriving inside the respawn window;
//   • durability regen is the single-player gate, and it is checked LAZILY (no timers);
//   • ownership is by SECT, never by account or family.
//
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  cityDocId,
  allCityNodes,
  isCityGroundTile,
  cityDurabilityMax,
  cityRegenPerHour,
  cityWaveCount,
  cityWaveGarrison,
  cityWaveBaseHp,
  CITY_WAVE_COUNT,
  CITY_CAPTURE_PROTECTION_MS,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  baseFootprintCells,
  baseFootprintInBounds,
  teamSiegeValue,
  marchDurationFromPath,
  marchStepArriveAt,
  CITY_CAPITAL_SIEGE_BONUS,
  CITY_WORLD_CENTER_SIEGE_BONUS,
  CITY_WORLD_CENTER_MARCH_DISCOUNT,
  waveSeed,
  SLG_TEAM_INJURY_MS,
  NATION_BONUS_DEFENSE,
  cityDefenderFortifyMult,
  cityDefenderTeamFortify,
  cityDefenderBaseHp,
  CARD_DEFS,
  type CardInstance,
  type MapEditorCityNode,
  type EquipmentInstance,
} from '@nw/shared';
import { ATTACK_LANES, garrisonProgressionRatios, UnitType } from '@nw/engine';
import { createWorldMongo, type WorldMongo, type TeamTemplate, type CardSLGState, type SectDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';
import type { WorldMailClient, WorldMailContent } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_citysiege_test';
const W = 's1-citysiege';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city-siege.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * The LOWEST-level graded city with room around it — the weakest wild city, which is the one the
 * single-player-proof invariant is measured against and therefore the one worth testing (a low-level city
 * has the cheapest wave ladder, so it is where an attacker comes closest to out-damaging the regen).
 * Returns the node plus a cell just OUTSIDE its footprint that is plain, claimable land — the beachhead a
 * besieger needs for ADR-039 connectivity.
 */
function findSiegeableCity(): { node: MapEditorCityNode; outside: { x: number; y: number } } {
  const graded = allCityNodes(W).filter((n) => n.kind === 'garrison').sort((a, b) => a.level - b.level);
  for (const node of graded) {
    const r = (node.footprint - 1) / 2;
    // Walk outward from the plot edge until a plain, occupiable neighbour turns up. It must NOT be city
    // ground (another city's plot can abut this one) and must be marchable terrain.
    for (let d = 1; d <= 6; d++) {
      const cand = { x: node.x + r + d, y: node.y };
      if (cand.x < 0 || cand.x >= SLG_MAP_W) continue;
      const t = proceduralTile(W, cand.x, cand.y);
      if (isCityGroundTile(t.type) || t.type === 'obstacle' || t.type === 'stronghold' || t.type === 'bridge' || t.type === 'plankway') continue;
      // The beachhead must be adjacent to the plot on the x axis for the footprint connectivity check to
      // pass once it is owned, so only d === 1 qualifies as the claim target.
      if (d !== 1) break;
      return { node, outside: cand };
    }
  }
  throw new Error('no graded city with a plain claimable neighbour cell');
}

/** Placeable capital anchor near (sx,sy): whole 3×3 in bounds and clear of reserved terrain. */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 2; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return isCityGroundTile(t.type) || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no placeable base near the city');
}

describe.skipIf(!mongo)('worldsvc wild-city siege e2e (ADR-074 P1)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  /** Capture-mail recorder — §7 sends exactly ONE, to the player who landed the killing blow. */
  const mailCalls: { accountId: string; dispatchKey: string; content: WorldMailContent }[] = [];
  const fakeMail: WorldMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) { mailCalls.push({ accountId, dispatchKey, content }); },
  };

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* pushes are irrelevant to these assertions */ },
    async broadcast() { /* ditto */ },
  };
  // Per-card weapon-slot override (cardId -> equipment instance id) — empty by default. Lets one test
  // equip a single card's gear without the Proxy having to fabricate stateful per-id storage.
  let cardGearOverride: Record<string, string>;
  // equipmentInv exposed by the fake meta — empty by default (SLG_CITY_SIEGE_DESIGN §12.7's gear channel
  // needs a real end-to-end case through THIS call site too, not just baseSiege.e2e.test.ts's).
  let equipmentInvOverride: Record<string, EquipmentInstance>;
  const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
    get: (_t, prop: string) => ({ id: prop, defId: 'chenshou', level: 9, gear: cardGearOverride[prop] ? { weapon: cardGearOverride[prop] } : {}, locked: false }),
  });
  const fakeMeta: WorldMetaClient = {
    available: true,
    async getProfile() { return null; },
    async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: equipmentInvOverride, cardInv: CARD_INV_ANY }; },
    grantMaterial: async () => { /* unused */ },
    batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
    grantTitle: () => { throw new Error('fake WorldMetaClient.grantTitle() is not stubbed in this test'); },
  };
  /**
   * Which sect each account belongs to, as socialsvc would report it. `joinWorld` mirrors
   * `getMember().sectId` onto PlayerWorldDoc (comm-audit batch F item 8b), and that mirror is what the
   * siege gate reads — so membership has to come from here, not only from a direct doc write, or the
   * mirroring step itself would never be exercised.
   */
  const membership = new Map<string, { familyId: string; sectId?: string }>();
  const fakeSocialsvc = {
    available: true,
    async getMember(accountId: string) { return membership.get(accountId) ?? null; },
    async getFamiliesByIds(familyIds: string[]) {
      // ADR-039 connectivity resolves the besieger's sect through their family, so this has to answer with
      // the sect the membership map says — otherwise every connectivity check falls back to "own tiles only".
      return familyIds.map((familyId) => {
        const sectId = [...membership.values()].find((v) => v.familyId === familyId)?.sectId;
        return { familyId, name: familyId, ...(sectId ? { sectId } : {}) };
      });
    },
    async getFamiliesBySect(sectId: string) { return [{ familyId: `fam-of-${sectId}`, name: `fam-of-${sectId}`, sectId }]; },
    async push() { /* announcements are asserted via the sectMessages collection, not the push */ },
    async resetSlgState() { /* unused */ },
  } as unknown as WorldSocialsvcClient;

  const { node: city, outside } = findSiegeableCity();
  const base = findNearbyBase(city.x, city.y);
  const A = 'acct-siege-a';
  const B = 'acct-siege-b';
  const SECT_A = 'sect-a';
  const SECT_B = 'sect-b';
  const CITY_ID = cityDocId(W, city.id);
  const TEAM = 'team-siege';
  const CARDS = Array.from({ length: 12 }, (_, i) => `card-siege-${i}`);

  /** Give `acct` a 12-card team filled to `troopsPerCard`, and put it in `sectId` ('' = no sect). */
  async function armSiegeTeam(acct: string, sectId: string, troopsPerCard: number): Promise<void> {
    await svc.setTeams(W, acct, [{
      id: TEAM, name: TEAM,
      // Columns must be real attack lanes (ATTACK_LANES skips 5 and 6 — the base columns), otherwise
      // `validateAttackerArmy` rejects the whole formation before any battle runs.
      army: CARDS.map((id, i) => ({ cardInstanceId: id, col: ATTACK_LANES[i % ATTACK_LANES.length]!, row: 3 + Math.floor(i / ATTACK_LANES.length) })),
    }] as TeamTemplate[]);
    const set: Record<string, unknown> = { troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE };
    for (const id of CARDS) set[`cardState.${id}`] = { currentTroops: troopsPerCard, teamId: TEAM } as CardSLGState;
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, acct) },
      sectId ? { $set: { ...set, sectId } } : { $set: set, $unset: { sectId: '' } },
    );
  }

  /**
   * Re-plant `acct`'s capital at (ax,ay) by writing its nine tiles directly. `relocateBase` cannot be used:
   * it requires the destination 3x3 to be territory the account ALREADY owns, which is the opposite of what
   * a "move me next to that city" fixture needs.
   */
  async function moveBase(acct: string, ax: number, ay: number): Promise<void> {
    await m.collections.tiles.deleteMany({ worldId: W, type: 'base', ownerId: acct });
    const anchorId = tileId(W, ax, ay);
    await m.collections.tiles.insertOne({
      _id: anchorId, worldId: W, x: ax, y: ay, type: 'base', level: 2, ownerId: acct,
      garrison: 500, hp: 200, rev: 0,
    } as never);
    for (const c of baseFootprintCells(ax, ay)) {
      if (c.x === ax && c.y === ay) continue;
      await m.collections.tiles.insertOne({
        _id: tileId(W, c.x, c.y), worldId: W, x: c.x, y: c.y, type: 'base',
        baseRing: true, baseAnchor: anchorId, level: 1, ownerId: acct, rev: 0,
      } as never);
    }
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, acct) }, { $set: { mainBaseTile: anchorId }, $inc: { rev: 1 } });
  }

  /** Claim the beachhead cell for `acct` directly, so ADR-039 connectivity to the city plot is satisfied. */
  async function claimBeachhead(acct: string): Promise<void> {
    await m.collections.tiles.updateOne(
      { _id: tileId(W, outside.x, outside.y) },
      {
        $set: {
          worldId: W, x: outside.x, y: outside.y, type: 'territory' as const,
          level: proceduralTile(W, outside.x, outside.y).level, ownerId: acct, garrison: 500, rev: 0,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Run one full siege march from `acct`'s base to arrival, advance to the settlement deadline, then settle
   * the delayed durability hit. `beforeSettle` runs after the clock has already advanced to the deadline —
   * which is the only safe place for a case to pre-damage the wall, because regen is lazy: writing
   * `durability: 1` before the march flies gets ~6 minutes of regen (~1,350 at the weakest city) added back
   * before the hit lands, which is several times a single hit's damage.
   */
  async function siegeAndSettle(acct: string, beforeSettle?: () => Promise<void>): Promise<void> {
    const pw = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, acct) }))!;
    const from = pw.mainBaseTile!;
    const view = await svc.startMarch(W, acct, Number(from.split(':')[1]), Number(from.split(':')[2]), city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    if (beforeSettle) await beforeSettle();
    await svc.processDueSiegeDamage(nowMs);
  }

  /** Bring the wall to `durability` with its regen checkpoint at the current clock (no accrual pending). */
  async function setDurability(durability: number, extra: Record<string, unknown> = {}): Promise<void> {
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { durability, durabilityRegenAt: nowMs, ...extra } });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    mailCalls.length = 0;
    cardGearOverride = {};
    equipmentInvOverride = {};
    membership.clear();
    membership.set(A, { familyId: `fam-of-${SECT_A}`, sectId: SECT_A });
    membership.set(B, { familyId: `fam-of-${SECT_B}`, sectId: SECT_B });
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
      mail: fakeMail,
      socialsvc: fakeSocialsvc,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
    await svc.initNations(W);
    await svc.initCities(W);
    for (const sid of [SECT_A, SECT_B]) {
      await m.collections.sects.insertOne({ _id: sid, worldId: W, name: sid.toUpperCase(), tag: sid.replace('sect-', 'TAG'), rev: 0 } as unknown as SectDoc);
    }
    await svc.joinWorld(W, A, base.x, base.y);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A) },
      { $set: { troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE } },
    );
  });

  afterAll(async () => { await m.close(); });

  // ── ① initCities ──────────────────────────────────────────────────────────────────────────
  it('creates one city document per served node, with durability from the calibrated curve', async () => {
    const nodes = await svc.getCities(W);
    const docs = await m.collections.cities.find({ worldId: W }).toArray();
    expect(docs).toHaveLength(nodes.length);
    expect(docs.length).toBeGreaterThan(60); // world center + 9 capitals + 54 graded

    const doc = docs.find((d) => d.nodeId === city.id)!;
    expect(doc.kind).toBe('garrison');
    expect(doc.level).toBe(city.level);
    expect(doc.durabilityMax).toBe(cityDurabilityMax(city.level, 'garrison'));
    expect(doc.durability).toBe(doc.durabilityMax); // starts intact
    expect(doc.regenPerHour).toBe(cityRegenPerHour(city.level, 'garrison'));
    expect(doc.ownerSectId).toBeUndefined();
  });

  it('doubles the world center\'s durability and regen', async () => {
    const wc = await m.collections.cities.findOne({ _id: cityDocId(W, 'worldCenter') });
    const cap = await m.collections.cities.findOne({ worldId: W, kind: 'capital' });
    expect(wc!.durabilityMax).toBe(cap!.durabilityMax * 2);
    expect(wc!.regenPerHour).toBe(cap!.regenPerHour * 2);
  });

  it('is idempotent, and a re-init clears last season\'s conquest without resetting battle damage', async () => {
    await m.collections.cities.updateOne(
      { _id: CITY_ID },
      { $set: { ownerSectId: SECT_B, ownerSectName: 'B', capturedAt: 5, protectedUntil: 9e15, durability: 1234, siegeLog: { [SECT_B]: 77 } } },
    );
    await svc.initCities(W);
    const after = await m.collections.cities.findOne({ _id: CITY_ID });
    expect(await m.collections.cities.countDocuments({ worldId: W })).toBe((await svc.getCities(W)).length);
    // Ownership/round state is season-scoped and must not survive a reopen (same rule initNations applies).
    expect(after!.ownerSectId).toBeUndefined();
    expect(after!.protectedUntil).toBeUndefined();
    expect(after!.siegeLog).toBeUndefined();
    // Damage is NOT reset: only the CAP is re-stamped, so a level change published mid-season rescales the
    // wall without healing a city that is under siege right now.
    expect(after!.durability).toBe(1234);
  });

  it('follows the world PUBLISHED node list, not the seed-derived one', async () => {
    // ADR-074's own core bug class. `allCityNodes(worldId)` is a seed computation; the list that agrees with
    // the GROUND is the one cloned onto the WorldDoc from the active map template, which a designer can drag
    // in tools/map-editor. Deriving city HP from the seed would put a city's durability where its sprite is
    // NOT — the exact shape of the 2026-08-19 "sprite layer recomputed allCityNodes" bug, one layer down.
    const nodes = await svc.getCities(W);
    const moved = nodes.map((n) => (n.id === city.id ? { ...n, x: n.x - 11, y: n.y + 7, level: 8, footprint: 7 } : n));
    await m.collections.worlds.updateOne(
      { _id: W },
      { $set: { cities: moved, season: 1, shard: 0, status: 'open' as const, mapW: SLG_MAP_W, mapH: SLG_MAP_H, openAt: nowMs, capacity: 10, population: 0, rev: 1 } },
      { upsert: true },
    );
    await svc.initCities(W);

    const doc = (await m.collections.cities.findOne({ _id: CITY_ID }))!;
    expect({ x: doc.x, y: doc.y }).toEqual({ x: city.x - 11, y: city.y + 7 });
    // The dragged level must drive the durability curve too — level IS the wall's depth and the garrison's
    // size from P1 onward, so a stale level is a stale difficulty, not a cosmetic mismatch.
    expect(doc.level).toBe(8);
    expect(doc.durabilityMax).toBe(cityDurabilityMax(8, 'garrison'));
    // And the footprint lookup must follow it: the OLD anchor is no longer this city.
    expect((await svc.cityAt(W, city.x - 11, city.y + 7))?.nodeId).toBe(city.id);
  });

  // ── ② The sect gate (ADR-074 decision 1) ──────────────────────────────────────────────────
  it('rejects a city siege from a player with no sect', async () => {
    await armSiegeTeam(A, '', 300);
    await claimBeachhead(A);
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM))
      .rejects.toMatchObject({ code: 'NOT_IN_SECT' });
  });

  it('checks the sect gate BEFORE connectivity, so a sectless player gets the actionable error', async () => {
    // Both preconditions fail here (no sect AND no bordering territory). The sect one is the one the player
    // can act on, and the one the design doc names as the gate — reporting TERRITORY_NOT_CONNECTED instead
    // would send them off to conquer land they still could not use.
    await armSiegeTeam(A, '', 300);
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM))
      .rejects.toMatchObject({ code: 'NOT_IN_SECT' });
  });

  it('still requires ADR-039 connectivity for a sect member', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });
  });

  it('accepts the march once the besieger holds a cell bordering the plot', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    expect(view.kind).toBe('attack');
  });

  it('rejects a siege against a city the besieger\'s own sect already holds', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_A } });
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM))
      .rejects.toMatchObject({ code: 'ALLY_TILE' });
  });

  it('rejects a siege during the post-capture protection window', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B, protectedUntil: nowMs + 60_000 } });
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM))
      .rejects.toMatchObject({ code: 'PROTECTED' });
  });

  // ── ③ The wave ladder ─────────────────────────────────────────────────────────────────────
  it('a strong team clears the ladder and schedules exactly one delayed durability hit', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    const pending = await m.collections.siegeDamage.find({ worldId: W }).toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.cityId).toBe(CITY_ID);
    expect(pending[0]!.attackerSectId).toBe(SECT_A);
    expect(pending[0]!.isBase).toBe(false);
    expect(pending[0]!.dueAt).toBe(nowMs + SLG_SIEGE_DAMAGE_DELAY_MS);
    // Damage is the team's siege value — NOT scaled by troops. This is the property the whole "many players,
    // not one big player" design rests on.
    const inv: Record<string, CardInstance> = {};
    for (const id of CARDS) inv[id] = CARD_INV_ANY[id]!;
    expect(pending[0]!.damage).toBe(teamSiegeValue(CARDS.map((id) => ({ cardInstanceId: id })), inv));
    // Durability is untouched until the hit settles (the 5-minute delayed pipeline).
    expect((await m.collections.cities.findOne({ _id: CITY_ID }))!.durability).toBe(cityDurabilityMax(city.level, 'garrison'));
  });

  it('equipped siege-value gear raises the scheduled durability hit (SLG_CITY_SIEGE_DESIGN §12.7, end-to-end)', async () => {
    // Every other test in this file fakes equipmentInv as {}, so this call site's gear channel
    // (applyCitySiege reading attackerSave?.equipmentInv straight off scope) had never actually been
    // exercised through the real pipeline — only baseSiege.e2e.test.ts's sibling call site and the
    // isolated teamSiegeValue unit tests. This proves this chain too.
    await armSiegeTeam(A, SECT_A, 300);
    const gearInstanceId = 'eq_siege_test';
    cardGearOverride[CARDS[0]!] = gearInstanceId;
    equipmentInvOverride = {
      [gearInstanceId]: { id: gearInstanceId, defId: 'sim_test', rarity: 'rare', level: 0, affixes: [{ id: 's_siege', value: 60 }] },
    };
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    const inv: Record<string, CardInstance> = {};
    for (const id of CARDS) inv[id] = CARD_INV_ANY[id]!;
    const bare = teamSiegeValue(CARDS.map((id) => ({ cardInstanceId: id })), inv); // no equipmentInv → old gear-blind number
    const geared = teamSiegeValue(CARDS.map((id) => ({ cardInstanceId: id })), inv, equipmentInvOverride);
    expect(geared).toBeGreaterThan(bare); // sanity: the fixture actually moves the number

    const pending = await m.collections.siegeDamage.find({ worldId: W }).toArray();
    expect(pending).toHaveLength(1);
    // This is the real assertion: worldsvc's actual pipeline used the attacker's real equipmentInv.
    expect(pending[0]!.damage).toBe(geared);
    expect(pending[0]!.damage).not.toBe(bare);
  });

  it('a team too weak to clear the ladder schedules NO damage and still loses troops', async () => {
    // 12 cards at 20 troops each cannot beat the first wave. A repelled march must deal nothing — otherwise
    // the ladder stops bounding anything.
    await armSiegeTeam(A, SECT_A, 20);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W })).toBe(0);
    const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, A) });
    const survivingTroops = CARDS.reduce((a, id) => a + (pw!.cardState?.[id]?.currentTroops ?? 0), 0);
    expect(survivingTroops).toBeLessThan(12 * 20);
  });

  it('the ladder is the full CITY_WAVE_COUNT every march — the numbers come from the shared curve', () => {
    // Pinned here because the ladder shape is what the econ-sim calibration measured: a 4th wave makes a
    // level-10 city unclearable by ANY roster the game can produce, and 1180 troops/wave (the design doc's
    // DRAFT) routes level 9-10 waves to the cheap linear path where card quality stops mattering.
    expect(cityWaveCount(city.level)).toBe(CITY_WAVE_COUNT);
    expect(cityWaveCount(3)).toBe(cityWaveCount(10));
    expect(cityWaveGarrison(10)).toBeGreaterThan(cityWaveGarrison(3));
    expect(cityWaveBaseHp(10)).toBeGreaterThan(cityWaveBaseHp(3));
  });

  // ── ④ Durability, lazy regen, capture ─────────────────────────────────────────────────────
  it('subtracts the hit from durability and records it in the per-sect siege log', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A);
    const doc = await m.collections.cities.findOne({ _id: CITY_ID });
    const max = cityDurabilityMax(city.level, 'garrison');
    expect(doc!.durability).toBeLessThan(max);
    expect(doc!.durability).toBeGreaterThan(0);
    expect(doc!.siegeLog?.[SECT_A]).toBe(max - doc!.durability);
    expect(doc!.ownerSectId).toBeUndefined(); // one hit is nowhere near enough
    expect(doc!.durabilityRegenAt).toBe(nowMs); // the lazy-regen checkpoint advances with the hit
  });

  it('regenerates lazily — a city left alone for hours is back at full with no timer having run', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A);
    const damaged = await m.collections.cities.findOne({ _id: CITY_ID });
    expect(damaged!.durability).toBeLessThan(damaged!.durabilityMax);

    // No scheduler tick, no write — just time passing and a read.
    nowMs += 10 * 3_600_000;
    const view = (await svc.getCityViews(W)).find((c) => c.id === city.id)!;
    expect(view.durability).toBe(view.durabilityMax);
    // The stored checkpoint is deliberately still the damaged value: regen is computed on read.
    expect((await m.collections.cities.findOne({ _id: CITY_ID }))!.durability).toBe(damaged!.durability);
  });

  it('hands the city to the sect that lands the LAST hit, with full durability and a protection window', async () => {
    // Ownership is by sect and goes to the last hit (ADR-074 decision 2). Driven by pre-damaging the wall to
    // just above one hit's worth rather than by running dozens of marches, so the case stays fast and is
    // about the CAPTURE branch, not about the ladder.
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A, () => setDurability(1, { siegeLog: { [SECT_B]: 999_999 } }));

    const doc = await m.collections.cities.findOne({ _id: CITY_ID });
    // SECT_B contributed vastly more this round and still loses the city — the documented consequence of
    // the last-hit rule the user chose over cumulative damage.
    expect(doc!.ownerSectId).toBe(SECT_A);
    expect(doc!.ownerSectName).toBe(SECT_A.toUpperCase());
    expect(doc!.capturedAt).toBe(nowMs);
    expect(doc!.protectedUntil).toBe(nowMs + CITY_CAPTURE_PROTECTION_MS);
    // A captured city starts intact for its new owner, and the round's contribution history is cleared.
    expect(doc!.durability).toBe(cityDurabilityMax(city.level, 'garrison'));
    expect(doc!.siegeLog).toBeUndefined();
  });

  it('announces a capture on the new owner\'s sect channel and on the previous owner\'s', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A, () => setDurability(1, { ownerSectId: SECT_B }));

    const msgs = await m.collections.sectMessages.find({ worldId: W }).toArray();
    const toWinner = msgs.find((x) => x.sectId === SECT_A);
    const toLoser = msgs.find((x) => x.sectId === SECT_B);
    expect(toWinner?.body).toContain('slg.city.captured');
    expect(toLoser?.body).toContain('slg.city.lost');
    // A city is held by a sect, not an account, so there is no single defender to warn — the losing sect's
    // channel post IS the notification. Both carry the city's identity so the client can render it.
    expect(toWinner?.body).toContain(city.id);
    // Not a world-channel announcement: that is reserved for the world center.
    expect(await m.collections.nationMessages.countDocuments({ worldId: W })).toBe(0);
  });

  it('voids a hit that lands after the besieger\'s own sect already took the city', async () => {
    // Two marches from the same sect can be in the 5-minute settlement window together; the second must not
    // re-capture (and re-announce) a city its own sect already holds.
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_A, durability: 500, durabilityRegenAt: nowMs } });
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    await svc.processDueSiegeDamage(nowMs);
    const doc = await m.collections.cities.findOne({ _id: CITY_ID });
    expect(doc!.durability).toBe(500); // untouched
    expect(await m.collections.sectMessages.countDocuments({ worldId: W })).toBe(0);
  });

  it('a world-center capture also announces on the WORLD channel, and mails the killing blow', async () => {
    // §7: the world center is the one objective the whole shard cares about, so it gets the world channel on
    // top of the two sect channels. The mail goes to ONE player — the one whose march landed the last hit —
    // deliberately not fanned out to a sect's ≤900 members across 64 cities.
    const wcId = cityDocId(W, 'worldCenter');
    const wc = (await m.collections.cities.findOne({ _id: wcId }))!;
    await armSiegeTeam(A, SECT_A, 300);
    // The world center sits at the map's middle, ~600 tiles from this suite's default base — far past the
    // A* budget ("No viable path found"). Move the besieger next to it for this case only.
    const wcBase = findNearbyBase(wc.x + (wc.footprint - 1) / 2 + 3, wc.y);
    await moveBase(A, wcBase.x, wcBase.y);
    const wcOutside = { x: wc.x + (wc.footprint - 1) / 2 + 1, y: wc.y };
    await m.collections.tiles.updateOne(
      { _id: tileId(W, wcOutside.x, wcOutside.y) },
      { $set: { worldId: W, x: wcOutside.x, y: wcOutside.y, type: 'territory' as const, level: 1, ownerId: A, garrison: 500, rev: 0 } },
      { upsert: true },
    );
    const view = await svc.startMarch(W, A, wcBase.x, wcBase.y, wc.x, wc.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    await m.collections.cities.updateOne({ _id: wcId }, { $set: { durability: 1, durabilityRegenAt: nowMs } });
    await svc.processDueSiegeDamage(nowMs);

    expect((await m.collections.cities.findOne({ _id: wcId }))!.ownerSectId).toBe(SECT_A);
    const worldMsgs = await m.collections.nationMessages.find({ worldId: W }).toArray();
    expect(worldMsgs).toHaveLength(1);
    expect(worldMsgs[0]!.body).toContain('slg.city.worldCenterCaptured');
    expect(worldMsgs[0]!.senderId).toBe('system');
    expect(mailCalls.map((c) => c.accountId)).toEqual([A]);
    expect(mailCalls[0]!.dispatchKey).toContain(wcId); // idempotent per city+time, not per player
  });

  // ── ④b Arrival-time re-validation (departure checks all go stale in transit) ───────────────
  it('a besieger who LEAVES their sect mid-flight lands a miss, not a hit', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, A) }, { $unset: { sectId: '' } });
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W })).toBe(0);
  });

  it('a city that entered its protection window mid-flight takes no damage', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B, protectedUntil: view.arriveAt + 600_000 } });
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W })).toBe(0);
    expect((await m.collections.cities.findOne({ _id: CITY_ID }))!.ownerSectId).toBe(SECT_B);
  });

  it('voids the delayed hit when the city document itself is gone (world reset under a pending siege)', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W })).toBe(1);
    await m.collections.cities.deleteOne({ _id: CITY_ID }); // e.g. /admin/world/reset mid-window
    nowMs += SLG_SIEGE_DAMAGE_DELAY_MS + 1;
    // Must not throw, must not resurrect the document, and must consume the pending hit.
    await svc.processDueSiegeDamage(nowMs);
    expect(await m.collections.cities.countDocuments({ _id: CITY_ID })).toBe(0);
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W })).toBe(0);
  });

  // ── ⑤ Views ───────────────────────────────────────────────────────────────────────────────
  it('serves siege state alongside the node geometry, with regen already applied', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A);
    const stored = (await m.collections.cities.findOne({ _id: CITY_ID }))!;
    nowMs += 1_800_000; // half an hour of regen

    const views = await svc.getCityViews(W);
    expect(views).toHaveLength((await svc.getCities(W)).length);
    const v = views.find((c) => c.id === city.id)!;
    expect(v.footprint).toBe(city.footprint); // geometry still comes from the node list
    expect(v.durabilityMax).toBe(cityDurabilityMax(city.level, 'garrison'));
    expect(v.regenPerHour).toBe(cityRegenPerHour(city.level, 'garrison'));
    expect(v.durability).toBeGreaterThan(stored.durability);
    expect(v.siegeLog?.[SECT_A]).toBeGreaterThan(0);
  });

  it('exposes the besieger\'s sect on getMe so the client can gate the siege button', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    const me = await svc.getMe(W, A);
    expect(me.sectId).toBe(SECT_A);
  });

  it('reports a city for any cell of its footprint, not just the anchor', async () => {
    const r = (city.footprint - 1) / 2;
    const corner = { x: city.x + r, y: city.y + r };
    const hit = await svc.cityAt(W, corner.x, corner.y);
    expect(hit?.nodeId).toBe(city.id);
    // And nothing outside it.
    expect(await svc.cityAt(W, city.x + r + 3, city.y + r + 3)).toBeNull();
  });

  it('a second besieging sect adds to the same round\'s log rather than replacing it', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    await siegeAndSettle(A);
    const afterA = (await m.collections.cities.findOne({ _id: CITY_ID }))!;

    const bBase = findNearbyBase(outside.x + 8, outside.y + 8);
    await svc.joinWorld(W, B, bBase.x, bBase.y);
    await armSiegeTeam(B, SECT_B, 300);
    await claimBeachhead(B); // ownership of the beachhead moves to B; connectivity is per-sect
    await siegeAndSettle(B);

    const doc = (await m.collections.cities.findOne({ _id: CITY_ID }))!;
    expect(doc.siegeLog?.[SECT_A]).toBe(afterA.siegeLog?.[SECT_A]);
    expect(doc.siegeLog?.[SECT_B]).toBeGreaterThan(0);
  });
  // ── ADR-074 P3 (§8.3/§8.4): what holding cities does to the sect's own marches ────────────────────

  it('§8.3: the attacking sect\'s held capitals scale the durability hit, on their own channel', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    // Two capitals plus the world center — a bonus big enough that a rounding coincidence cannot make an
    // unscaled hit look scaled.
    const caps = (await m.collections.cities.find({ worldId: W, kind: 'capital' }).limit(2).toArray()).map((c) => c._id);
    await m.collections.cities.updateMany(
      { _id: { $in: [...caps, cityDocId(W, 'worldCenter')] } },
      { $set: { ownerSectId: SECT_A } },
    );
    await svc.recomputeSectPayoff(W, SECT_A);
    const bonus = 2 * CITY_CAPITAL_SIEGE_BONUS + CITY_WORLD_CENTER_SIEGE_BONUS;
    expect((await svc.sectPayoff(SECT_A)).siegeBonus).toBeCloseTo(bonus, 10);

    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    const inv: Record<string, CardInstance> = {};
    for (const id of CARDS) inv[id] = CARD_INV_ANY[id]!;
    const bare = teamSiegeValue(CARDS.map((id) => ({ cardInstanceId: id })), inv);
    const pending = await m.collections.siegeDamage.find({ worldId: W, cityId: CITY_ID }).toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.damage).toBe(Math.floor(bare * (1 + bonus)));
    expect(pending[0]!.damage).toBeGreaterThan(bare); // the bonus is definitely doing something
  });

  it('§8.3: holding the world center shortens the march, and the STEP cadence moves with it', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const plain = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    const plainDoc = (await m.collections.marches.findOne({ _id: plain.marchId }))!;
    expect(plainDoc.speedMult).toBeUndefined(); // omitted at 1 — pre-P3 document shape
    const plainDuration = plain.arriveAt - plainDoc.departAt;

    // The same march again, now with the world center held.
    await m.collections.marches.deleteMany({ worldId: W });
    await m.collections.cities.updateOne({ _id: cityDocId(W, 'worldCenter') }, { $set: { ownerSectId: SECT_A } });
    await svc.recomputeSectPayoff(W, SECT_A);
    const fast = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    const fastDoc = (await m.collections.marches.findOne({ _id: fast.marchId }))!;

    expect(fastDoc.speedMult).toBeCloseTo(1 - CITY_WORLD_CENTER_MARCH_DISCOUNT, 10);
    expect(fast.arriveAt - fastDoc.departAt).toBe(plainDuration * (1 - CITY_WORLD_CENTER_MARCH_DISCOUNT));
    // The load-bearing half: the step cursor must run at the SAME discounted cadence, or the march
    // "arrives" while the encounter scan still has cells to walk (see marchStepArriveAt's note).
    expect(fastDoc.path!.length).toBeGreaterThan(1);
    expect(fastDoc.nextStepAt).toBe(marchStepArriveAt(fastDoc.departAt, 1, fastDoc.speedMult));
    expect(marchStepArriveAt(fastDoc.departAt, fastDoc.path!.length - 1, fastDoc.speedMult)).toBe(fast.arriveAt);
    // ...and the undiscounted cadence would NOT land on arriveAt, which is what makes that check bite.
    expect(marchStepArriveAt(fastDoc.departAt, fastDoc.path!.length - 1)).not.toBe(fast.arriveAt);
    expect(marchDurationFromPath(fastDoc.path!, fastDoc.speedMult) * 1000).toBe(fast.arriveAt - fastDoc.departAt);
  });

  it('§8.4: an idle team may park on a capital its own sect holds, and then march from there', async () => {
    const capital = (await m.collections.cities.findOne({ worldId: W, kind: 'capital' }))!;
    const capBase = findNearbyBase(capital.x + (capital.footprint - 1) / 2 + 3, capital.y);
    await moveBase(A, capBase.x, capBase.y);
    await armSiegeTeam(A, SECT_A, 300);
    await m.collections.cities.updateOne({ _id: capital._id }, { $set: { ownerSectId: SECT_A } });
    await svc.recomputeSectPayoff(W, SECT_A);

    const moveView = await svc.startMarch(W, A, capBase.x, capBase.y, capital.x, capital.y, 'move', 1, TEAM, 'idle');
    nowMs = moveView.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    const parked = await m.collections.stationed.findOne({ worldId: W, ownerId: A, teamId: TEAM });
    expect(parked, 'the team must actually be standing in the city').not.toBeNull();
    expect({ x: parked!.x, y: parked!.y }).toEqual({ x: capital.x, y: capital.y });
    expect(parked!.mode).toBe('idle');

    // The anchor itself: a re-dispatch departs from the CITY, not from home (ADR-051 P3c's idle
    // re-dispatch is what §8.4 rides on — "not a teleport, just a shorter first leg").
    const out = await svc.startMarch(W, A, capBase.x, capBase.y, capital.x + 1, capital.y + 1, 'move', 1, TEAM, 'idle');
    expect(out.fromTile).toBe(tileId(W, capital.x, capital.y));
  });

  it('§8.4: only capitals and the world center are anchors — an idle park on a graded city is refused', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_A } });
    await svc.recomputeSectPayoff(W, SECT_A);
    // Own sect holds it, but it is a graded city: idle parking there would make all 64 cities launch
    // anchors, and §8.4 is explicit that then there is no front line.
    await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'move', 1, TEAM, 'idle'))
      .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    // Garrison intent on the same city IS allowed — that is a defender team, and it stays locked in place.
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'move', 1, TEAM, 'garrison');
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    const parked = await m.collections.stationed.findOne({ worldId: W, ownerId: A, teamId: TEAM });
    expect(parked?.mode).toBe('garrison');
    // Locked: a garrison team cannot be re-commanded from where it stands.
    await expect(svc.startMarch(W, A, base.x, base.y, city.x + 1, city.y, 'move', 1, TEAM, 'idle'))
      .rejects.toMatchObject({ code: 'TEAM_BUSY' });
  });

  it('§8.4: a city held by another sect (or nobody) is still siege-only, both intents', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    for (const mode of ['idle', 'garrison'] as const) {
      await m.collections.cities.updateOne({ _id: CITY_ID }, { $unset: { ownerSectId: '' } });
      await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'move', 1, TEAM, mode), 'npc/' + mode)
        .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
      await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B } });
      await expect(svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'move', 1, TEAM, mode), 'enemy/' + mode)
        .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    }
  });

  it('§8.4: a city that changes hands mid-flight bounces the arriving team instead of parking it', async () => {
    // Why the arrival guard re-checks instead of trusting dispatch: landing anyway would park a team inside
    // someone else's fortress.
    const capital = (await m.collections.cities.findOne({ worldId: W, kind: 'capital' }))!;
    const capBase = findNearbyBase(capital.x + (capital.footprint - 1) / 2 + 3, capital.y);
    await moveBase(A, capBase.x, capBase.y);
    await armSiegeTeam(A, SECT_A, 300);
    await m.collections.cities.updateOne({ _id: capital._id }, { $set: { ownerSectId: SECT_A } });
    await svc.recomputeSectPayoff(W, SECT_A);

    const view = await svc.startMarch(W, A, capBase.x, capBase.y, capital.x, capital.y, 'move', 1, TEAM, 'idle');
    // Taken by SECT_B while the team is in the air.
    await m.collections.cities.updateOne({ _id: capital._id }, { $set: { ownerSectId: SECT_B } });
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    expect(await m.collections.stationed.findOne({ _id: tileId(W, capital.x, capital.y) })).toBeNull();
  });
  // ── ADR-074 P3: sect defender teams (additive, ahead of the NPC ladder) ──────────────────────────

  /**
   * Park one of `acct`'s teams inside the city as a garrison defender, by writing the StationedDoc directly.
   * Going through a real `move` march would work (that path has its own cases above) but would also consume
   * the account's single team slot and its troops, which these cases need for the attacker.
   */
  async function garrisonCity(acct: string, teamId: string, cell: { x: number; y: number }, troopsPerCard: number): Promise<void> {
    const cards = Array.from({ length: 12 }, (_, i) => `def-${acct}-${teamId}-${i}`);
    const set: Record<string, unknown> = {};
    for (const id of cards) set[`cardState.${id}`] = { currentTroops: troopsPerCard, teamId } as CardSLGState;
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, acct) }, { $set: set });
    await m.collections.stationed.insertOne({
      _id: tileId(W, cell.x, cell.y),
      worldId: W,
      ownerId: acct,
      tile: tileId(W, cell.x, cell.y),
      x: cell.x,
      y: cell.y,
      teamId,
      army: cards.map((id, i) => ({ cardInstanceId: id, col: ATTACK_LANES[i % ATTACK_LANES.length]!, row: 3 + Math.floor(i / ATTACK_LANES.length) })),
      troops: troopsPerCard * cards.length,
      sinceAt: nowMs,
      mode: 'garrison',
    } as never);
  }

  it('an NPC-held city fights no defender rung at all — the pre-P3 path, unchanged', async () => {
    // The guard against the additive ladder quietly costing something on the common path: no ownership, no
    // stationed teams, so `fightCityDefenders` must return without a battle and the hit must be the plain one.
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);
    const inv: Record<string, CardInstance> = {};
    for (const id of CARDS) inv[id] = CARD_INV_ANY[id]!;
    const pending = await m.collections.siegeDamage.find({ worldId: W, cityId: CITY_ID }).toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.damage).toBe(teamSiegeValue(CARDS.map((id) => ({ cardInstanceId: id })), inv));
  });

  it('a strong defender team repels the assault before the NPC ladder, and no damage is scheduled', async () => {
    await armSiegeTeam(A, SECT_A, 20); // deliberately weak
    await claimBeachhead(A);
    // B holds the city and garrisons it heavily.
    const bBase = findNearbyBase(outside.x + 10, outside.y + 10);
    await svc.joinWorld(W, B, bBase.x, bBase.y);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B } });
    // 3,000 troops per card, against an attacker on 40. The gap has to be this wide because per-unit
    // blueprint quality, not troop count, is what decides this fight: the ATTACKER's cards get the full
    // level/equipment injection while a DEFENDER's fight on base blueprints (see applyBaseSiege's doc
    // comment). ADR-077 gives the defender back a FORTIFICATION factor for its own progression —
    // asserted explicitly at the bottom of this case — but not the attack/armor/trait half, so the
    // asymmetry the number above compensates for is reduced, not gone.
    await garrisonCity(B, 'def1', { x: city.x, y: city.y }, 3000);

    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    expect(await m.collections.siegeDamage.countDocuments({ worldId: W, cityId: CITY_ID })).toBe(0);
    const siege = await m.collections.sieges.findOne({ worldId: W }, { sort: { _id: -1 } });
    expect(siege?.outcome).toBe('defender_win');
    // The defender WON, so it is not injured — same rule as a base siege.
    const bPw = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, B) }))!;
    expect(bPw.teamState?.def1?.injuredUntil ?? 0).toBe(0);
    // "No damage + no injury" alone would ALSO describe "the NPC ladder repelled it and the defender never
    // fought", and this attacker is weak enough to fail that ladder too — so pin which rung was last fought.
    // The recorded replay's garrison carries the defender's own 3,000-troop cards, a figure no NPC wave has;
    // if the defender rung had been skipped or lost, the stored replay would be an NPC wave's instead.
    const cfg = siege?.defenderConfig as { garrison?: { initialHp?: number }[]; defenderBaseHp?: number } | null;
    expect(cfg?.garrison, 'the siege record must carry the rung that decided it').toBeDefined();
    // The garrison's own troop counts are recorded UNSCALED — the ADR-077 factor is deliberately not spent
    // here (measured worthless: see cityDefenderProgression.test.ts's header), so 3,000 is still a figure
    // no NPC wave has and still identifies the rung.
    expect(cfg!.garrison!.some((u) => u.initialHp === 3000), 'the deciding rung must be the defender TEAM').toBe(true);
    // ADR-077 proper: the rung's symbolic base HP carries the garrison's fortification factor, derived
    // from the same three functions worldsvc calls rather than hardcoded. The fake meta hands every card
    // out as a level-9 `chenshou` with no gear, so the factor is whatever hp-growth x attack-growth at
    // level 9 produces. Asserting it on the STORED config is the point: that is the replay input, so this
    // doubles as the proof a client reconstructs the identical battle from the payload it already
    // receives — no engine change, no ENGINE_VERSION bump, no new field.
    const defUnit = CARD_DEFS['chenshou']!.unitType as UnitType;
    const ratios = garrisonProgressionRatios(
      [{ id: 'probe', defId: 'chenshou', unitType: defUnit, level: 9, gear: {} }],
      {},
    );
    const perCard = cityDefenderFortifyMult(ratios.hp[defUnit] ?? 1, ratios.attack[defUnit] ?? 1);
    expect(perCard, 'a level-9 defender must actually earn a factor above 1, or this case proves nothing').toBeGreaterThan(1);
    const fortify = cityDefenderTeamFortify(CARDS.map(() => ({ troops: 3000, mult: perCard })));
    expect(cfg!.defenderBaseHp).toBe(cityDefenderBaseHp(city.level, fortify));
    expect(cfg!.defenderBaseHp!, 'the fortified base HP must exceed the plain per-wave figure').toBeGreaterThan(cityWaveBaseHp(city.level));
  });

  it('a beaten defender team is injured for SLG_TEAM_INJURY_MS and loses its troops, and the NPC ladder still runs', async () => {
    await armSiegeTeam(A, SECT_A, 300);
    await claimBeachhead(A);
    const bBase = findNearbyBase(outside.x + 10, outside.y + 10);
    await svc.joinWorld(W, B, bBase.x, bBase.y);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B } });
    await garrisonCity(B, 'def1', { x: city.x, y: city.y }, 5); // token defence — beaten, but not free

    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    const bPw = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, B) }))!;
    expect(bPw.teamState?.def1?.injuredUntil).toBe(nowMs + SLG_TEAM_INJURY_MS);
    // Wiped out, so its cards must not still be standing at full strength once the injury heals. Asserted as
    // "lost nearly everything" rather than "exactly 0": `computeCardStateUpdates` distributes survivors and
    // floors, so a wiped team can land on 1 rather than 0 — the property that matters is that it was spent.
    const anyCard = Object.entries(bPw.cardState ?? {}).find(([k]) => k.startsWith('def-'));
    expect(anyCard, 'the fixture must have written defender cardState').toBeDefined();
    expect(anyCard![1].currentTroops).toBeLessThan(5);
    // Additive, not substitutive: the attacker went on to clear the NPC ladder and scheduled its hit.
    expect(await m.collections.siegeDamage.countDocuments({ worldId: W, cityId: CITY_ID })).toBe(1);
    // And the NPC ladder was not SHORTENED by the defender rung, which is the whole 2026-08-27 decision.
    // Rungs are seeded `waveSeed(marchId, index)` over one continuous sequence, so the seed recorded for
    // the last rung fought says how many there were: 1 defender + CITY_WAVE_COUNT NPC waves means the last
    // index is CITY_WAVE_COUNT. Had the defender REPLACED a wave, it would be CITY_WAVE_COUNT - 1.
    const siege = await m.collections.sieges.findOne({ worldId: W }, { sort: { _id: -1 } });
    expect(siege?.seed).toBe(waveSeed(view.marchId, CITY_WAVE_COUNT));
    expect(siege?.seed).not.toBe(waveSeed(view.marchId, CITY_WAVE_COUNT - 1));
  });

  it('an injured defender team does not defend again until it heals', async () => {
    await armSiegeTeam(A, SECT_A, 40); // weak: only a live defender can stop it
    await claimBeachhead(A);
    const bBase = findNearbyBase(outside.x + 10, outside.y + 10);
    await svc.joinWorld(W, B, bBase.x, bBase.y);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B } });
    await garrisonCity(B, 'def1', { x: city.x, y: city.y }, 400);
    // Pre-injured — the state a previous assault would have left.
    const injuredUntil = nowMs + SLG_TEAM_INJURY_MS;
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, B) },
      { $set: { 'teamState.def1.injuredUntil': injuredUntil } },
    );

    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    // It sat out: the injury stamp is untouched (not pushed to a later one, which is what fighting and
    // losing again would do) and its troops are intact.
    const bPw = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, B) }))!;
    expect(bPw.teamState?.def1?.injuredUntil, 'an injured team must not have fought').toBe(injuredUntil);
    const anyCard = Object.entries(bPw.cardState ?? {}).find(([k]) => k.startsWith('def-'));
    expect(anyCard![1].currentTroops, 'a team that sat out keeps its troops').toBe(400);
  });

  it('a garrison team whose owner left the sect stops defending the city', async () => {
    await armSiegeTeam(A, SECT_A, 40);
    await claimBeachhead(A);
    const bBase = findNearbyBase(outside.x + 10, outside.y + 10);
    await svc.joinWorld(W, B, bBase.x, bBase.y);
    await m.collections.cities.updateOne({ _id: CITY_ID }, { $set: { ownerSectId: SECT_B } });
    await garrisonCity(B, 'def1', { x: city.x, y: city.y }, 400);
    // B leaves SECT_B — its team is now a stranger standing in someone else's city.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, B) }, { $unset: { sectId: '' } });

    const view = await svc.startMarch(W, A, base.x, base.y, city.x, city.y, 'attack', 1, TEAM);
    nowMs = view.arriveAt + 1;
    await svc.processDueArrivals(nowMs);

    const bPw = (await m.collections.playerWorld.findOne({ _id: playerWorldId(W, B) }))!;
    expect(bPw.teamState?.def1?.injuredUntil ?? 0, 'it must not have fought').toBe(0);
  });

  it('§9: the province defence bonus follows CITY ownership now, not the dead nations.ownerId', async () => {
    // Pure-unit assertion of the re-pointed predicate — the battle-side effect is already covered by
    // nation-bonus.e2e.test.ts's defence case, which this must not silently stop feeding.
    const capital = (await m.collections.cities.findOne({ worldId: W, kind: 'capital' }))!;
    expect(capital.provinceIdx, 'capitals must carry provinceIdx for the lookup to work').toBeGreaterThanOrEqual(0);
    // Nobody holds it → no bonus, even with a nations document that says otherwise.
    await m.collections.nations.updateOne(
      { _id: `nation:${W}:${capital.provinceIdx}` },
      { $set: { worldId: W, capitalIdx: capital.provinceIdx, ownerId: A } },
      { upsert: true },
    );
    expect(await svc.inOwnSectProvince(W, A, capital.x, capital.y)).toBe(false);
    // Own sect holds the capital city → bonus.
    await m.collections.cities.updateOne({ _id: capital._id }, { $set: { ownerSectId: SECT_A } });
    expect(await svc.inOwnSectProvince(W, A, capital.x, capital.y)).toBe(true);
    // Another sect holds it → no bonus.
    await m.collections.cities.updateOne({ _id: capital._id }, { $set: { ownerSectId: SECT_B } });
    expect(await svc.inOwnSectProvince(W, A, capital.x, capital.y)).toBe(false);
    expect(NATION_BONUS_DEFENSE).toBeGreaterThan(0); // the constant survives §9; only its key changed
  });
});
