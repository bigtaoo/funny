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
  type CardInstance,
  type MapEditorCityNode,
} from '@nw/shared';
import { ATTACK_LANES } from '@nw/engine';
import { createWorldMongo, type WorldMongo, type TeamTemplate, type CardSLGState, type SectDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';

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

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* pushes are irrelevant to these assertions */ },
    async broadcast() { /* ditto */ },
  };
  const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
    get: (_t, prop: string) => ({ id: prop, defId: 'chenshou', level: 9, gear: {}, locked: false }),
  });
  const fakeMeta: WorldMetaClient = {
    available: true,
    async getProfile() { return null; },
    async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
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
    membership.clear();
    membership.set(A, { familyId: `fam-of-${SECT_A}`, sectId: SECT_A });
    membership.set(B, { familyId: `fam-of-${SECT_B}`, sectId: SECT_B });
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
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
});
