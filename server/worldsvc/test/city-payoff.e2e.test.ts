// worldsvc wild-city OCCUPATION PAYOFF (ADR-074 P3, SLG_CITY_SIEGE_DESIGN §8) end-to-end: real Mongo +
// fake clock.
//
// P1 shipped "takeable, holdable, visible" and paid nothing — a captured city was pure strategic denial.
// P3 is the payoff, and the two properties worth pinning here are the ones that are invisible in a spot
// check of the numbers:
//
//   1. **The flat bonus is the LAST step and it is additive** (§8.6). Folded in any earlier it gets
//      re-multiplied by the resource buildings (+10%/level) and the battle pass (+10%), so §8.1's cap —
//      the whole reason conquest stops paying economically past ~2 provinces — would not cap anything.
//      Asserted as a DIFFERENCE across two players with different multipliers, not as an absolute value:
//      an absolute expectation would pass just as happily with the bonus in the wrong place.
//   2. **A capture is simultaneously a loss** (§8). Both sects' caches have to move, and the loser's is
//      the one a naive implementation forgets — its symptom is a sect being paid for a city it no longer
//      holds, which nothing else in the system would ever contradict.
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
  cityYieldBonus,
  citySiegeBonus,
  cityMarchMult,
  CITY_YIELD_FLAT_CAP,
  CITY_STICKER_FLAT_CAP,
  CITY_BONUS_MEMBERSHIP_DELAY_MS,
  CITY_CAPITAL_SIEGE_BONUS,
  CITY_WORLD_CENTER_SIEGE_BONUS,
  CITY_WORLD_CENTER_MARCH_DISCOUNT,
  BP_YIELD_MULT,
  RESOURCE_TYPES,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  baseFootprintCells,
  baseFootprintInBounds,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type SectDoc } from '../src/db';
import { WorldService } from '../src/service';
import { sectMembershipQualifies } from '../src/core/citySiege';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';
import type { WorldSocialsvcClient } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_citypayoff_test';
const W = 's1-citypayoff';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city-payoff.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/** Placeable capital anchor near (sx,sy): whole 3x3 in bounds and clear of reserved terrain. */
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
  throw new Error('no placeable base near the map centre');
}

describe.skipIf(!mongo)('worldsvc wild-city occupation payoff e2e (ADR-074 P3)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* irrelevant here */ },
    async broadcast() { /* ditto */ },
  };
  const fakeMeta: WorldMetaClient = {
    available: true,
    async getProfile() { return null; },
    async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: {} }; },
    grantMaterial: async () => { /* unused */ },
    batchProfiles: () => { throw new Error('not stubbed'); },
    grantTitle: () => { throw new Error('not stubbed'); },
  };
  const membership = new Map<string, { familyId: string; sectId?: string }>();
  const fakeSocialsvc = {
    available: true,
    async getMember(accountId: string) { return membership.get(accountId) ?? null; },
    async getFamiliesByIds(familyIds: string[]) {
      return familyIds.map((familyId) => {
        const sectId = [...membership.values()].find((v) => v.familyId === familyId)?.sectId;
        return { familyId, name: familyId, ...(sectId ? { sectId } : {}) };
      });
    },
    async getFamiliesBySect(sectId: string) { return [{ familyId: `fam-of-${sectId}`, name: `fam-of-${sectId}`, sectId }]; },
    async setSect() { /* the socialsvc-side write; the worldsvc mirror is what this file asserts */ },
    async push() { /* unused */ },
    async resetSlgState() { /* unused */ },
  } as unknown as WorldSocialsvcClient;

  const SECT_A = 'sect-payoff-a';
  const SECT_B = 'sect-payoff-b';
  const FAM_A = `fam-of-${SECT_A}`;
  const A = 'acct-payoff-a';
  const A2 = 'acct-payoff-a2'; // same family/sect as A, used for the "whole family mirrors at once" case
  const base = findNearbyBase(Math.floor(SLG_MAP_W / 2), Math.floor(SLG_MAP_H / 2));
  const base2 = findNearbyBase(base.x + 20, base.y + 20);

  /** Hand a set of city nodes to a sect by writing ownership directly, then refresh the cache. */
  async function giveCities(sectId: string, nodeIds: string[]): Promise<void> {
    await m.collections.cities.updateMany(
      { worldId: W, _id: { $in: nodeIds.map((id) => cityDocId(W, id)) } },
      { $set: { ownerSectId: sectId } },
    );
    await svc.recomputeSectPayoff(W, sectId);
  }

  /** Node ids by kind, from the same template list `initCities` seeded from. */
  const nodes = allCityNodes(W);
  const gradedIds = nodes.filter((n) => n.kind === 'garrison').map((n) => n.id);
  const capitalIds = nodes.filter((n) => n.kind === 'capital').map((n) => n.id);
  const worldCenterId = nodes.find((n) => n.kind === 'worldCenter')!.id;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  beforeEach(async () => {
    for (const c of Object.values(m.collections)) await c.deleteMany({});
    nowMs = 1_000_000;
    membership.clear();
    membership.set(A, { familyId: FAM_A, sectId: SECT_A });
    membership.set(A2, { familyId: FAM_A, sectId: SECT_A });
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
    await svc.initCities(W);
    for (const sid of [SECT_A, SECT_B]) {
      await m.collections.sects.insertOne({
        _id: sid, worldId: W, name: sid.toUpperCase(), tag: sid.slice(-4).toUpperCase(),
        leaderFamilyId: `fam-of-${sid}`, leaderId: `leader-${sid}`, memberFamilyCount: 1,
        allySectIds: [], prosperity: 0, rev: 0,
      } as unknown as SectDoc);
    }
    await svc.joinWorld(W, A, base.x, base.y);
    await svc.joinWorld(W, A2, base2.x, base2.y);
    // Both joined "long ago" so the §8.5 delay is satisfied unless a case says otherwise.
    await m.collections.playerWorld.updateMany(
      { worldId: W },
      { $set: { sectSince: nowMs - CITY_BONUS_MEMBERSHIP_DELAY_MS - 1, troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE } },
    );
  });

  afterAll(async () => { await m.client.close(); });

  /**
   * The yield SINGLE EXIT's own return value (core/yield.ts `recomputeYield`), not the stored `yieldRate`.
   * The stored field only refreshes when something happens to call the exit, and using `occupyTile` to
   * trigger one would fold that tile's yield into every delta this file measures — which is precisely the
   * kind of noise that makes an "is the bonus in the right place" assertion pass for the wrong reason.
   */
  const rateOf = (acct: string): Promise<Record<ResourceType, number>> =>
    (svc as unknown as { core: { recomputeYield(w: string, a: string): Promise<Record<ResourceType, number>> } })
      .core.recomputeYield(W, acct);

  // ── The cache ────────────────────────────────────────────────────────────────────────────────────

  it('a sect that holds nothing has no cached payoff at all, and reads as zero', async () => {
    const doc = await m.collections.sects.findOne({ _id: SECT_A });
    expect(doc?.cityPayoff).toBeUndefined();
    const p = await svc.sectPayoff(SECT_A);
    expect(p.siegeBonus).toBe(0);
    expect(p.marchMult).toBe(1);
    for (const rt of RESOURCE_TYPES) expect(p.yield[rt], rt).toBe(0);
    // An unknown / absent sect must read the same, so the yield path needs no branch of its own.
    expect((await svc.sectPayoff(undefined)).marchMult).toBe(1);
    expect((await svc.sectPayoff('sect-that-does-not-exist')).siegeBonus).toBe(0);
  });

  it('caches all three derived numbers together, matching the pure functions on the same holding', async () => {
    const held = [gradedIds[0]!, gradedIds[1]!, capitalIds[0]!, worldCenterId];
    await giveCities(SECT_A, held);
    const heldNodes = held.map((id) => nodeById.get(id)!);

    const doc = await m.collections.sects.findOne({ _id: SECT_A });
    expect(doc?.cityPayoff).toBeDefined();
    expect(doc!.cityPayoff!.yield).toEqual(cityYieldBonus(heldNodes));
    expect(doc!.cityPayoff!.siegeBonus).toBeCloseTo(citySiegeBonus(heldNodes), 10);
    expect(doc!.cityPayoff!.marchMult).toBeCloseTo(cityMarchMult(heldNodes), 10);
    expect(doc!.cityPayoff!.at).toBe(nowMs);
    // The world center is in there, so the march discount must actually be on.
    expect(doc!.cityPayoff!.marchMult).toBeCloseTo(1 - CITY_WORLD_CENTER_MARCH_DISCOUNT, 10);
    expect(doc!.cityPayoff!.siegeBonus).toBeCloseTo(CITY_CAPITAL_SIEGE_BONUS + CITY_WORLD_CENTER_SIEGE_BONUS, 10);
  });

  it('holding the whole map lands exactly on the cap, not past it', async () => {
    await giveCities(SECT_A, nodes.map((n) => n.id));
    const p = await svc.sectPayoff(SECT_A);
    expect(p.yield.ink).toBe(CITY_YIELD_FLAT_CAP);
    expect(p.yield.sticker).toBe(CITY_STICKER_FLAT_CAP);
  });

  // ── §8.6: last step, additive ────────────────────────────────────────────────────────────────────

  it('the bonus is added AFTER the building multiplier and the battle pass — the delta is identical for both', async () => {
    // A2 gets a resource building and the battle pass; A gets neither. If the city bonus were folded in
    // before either multiplier, A2's delta would be larger than A's by exactly those multipliers, and
    // §8.1's cap would be a cap on the pre-multiplied figure — i.e. not a cap.
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A2) },
      { $set: { buildings: { desk: 5, inkPot: 5, paperTray: 5, graphiteMill: 5, metalForge: 5, stickerShop: 3 }, hasBattlePass: true } },
    );
    // Recompute both baselines through the real path so the multipliers are actually in play.
    const noCities = { a: await rateOf(A), a2: await rateOf(A2) };
    expect(noCities.a2.ink, 'the fixture must actually give A2 a bigger base rate').toBeGreaterThan(noCities.a.ink);

    const held = [gradedIds[0]!, capitalIds[0]!];
    await giveCities(SECT_A, held);
    const bonus = cityYieldBonus(held.map((id) => nodeById.get(id)!));
    const withCities = { a: await rateOf(A), a2: await rateOf(A2) };

    for (const rt of RESOURCE_TYPES) {
      // The two deltas must be EQUAL to each other and equal to the flat bonus. That equality IS the
      // ordering property: put the addition before either multiplier and A2's delta grows by them.
      expect(withCities.a[rt]! - noCities.a[rt]!, `${rt} delta for the plain player`).toBe(bonus[rt]);
      expect(withCities.a2[rt]! - noCities.a2[rt]!, `${rt} delta for the multiplied player`).toBe(bonus[rt]);
    }
    // Sanity: A2 really is multiplied, so the equality above is not vacuous.
    expect(BP_YIELD_MULT).toBeGreaterThan(1);
    expect(withCities.a2.ink).toBeGreaterThan(withCities.a.ink);
  });

  // ── §8.5: membership delay ───────────────────────────────────────────────────────────────────────

  it('a fresh member collects nothing until the delay elapses (§8.5 anti-hop)', async () => {
    await giveCities(SECT_A, [capitalIds[0]!]);
    const bonus = cityYieldBonus([nodeById.get(capitalIds[0]!)!]);

    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, A) }, { $set: { sectSince: nowMs } });
    const fresh = await rateOf(A);

    nowMs += CITY_BONUS_MEMBERSHIP_DELAY_MS;
    const seasoned = await rateOf(A);

    for (const rt of RESOURCE_TYPES) {
      expect(seasoned[rt]! - fresh[rt]!, `${rt}`).toBe(bonus[rt]);
    }
  });

  it('sectMembershipQualifies: no sect never qualifies, an absent stamp counts as long-standing', () => {
    const t = 10 * CITY_BONUS_MEMBERSHIP_DELAY_MS;
    expect(sectMembershipQualifies({}, t)).toBe(false);
    expect(sectMembershipQualifies({ sectSince: 0 }, t)).toBe(false); // stamped but sect-less
    // Pre-P3 documents have no stamp. Counting them as long-standing under-punishes rather than
    // over-punishes, which is the direction a faucet guard should fail in.
    expect(sectMembershipQualifies({ sectId: SECT_A }, t)).toBe(true);
    expect(sectMembershipQualifies({ sectId: SECT_A, sectSince: t }, t)).toBe(false);
    expect(sectMembershipQualifies({ sectId: SECT_A, sectSince: t - CITY_BONUS_MEMBERSHIP_DELAY_MS }, t)).toBe(true);
  });

  // ── §8: a capture is also a loss ─────────────────────────────────────────────────────────────────

  it('a capture refreshes BOTH sects — the loser stops being paid, not just the winner starting', async () => {
    const nodeId = capitalIds[0]!;
    await giveCities(SECT_B, [nodeId]);
    expect((await svc.sectPayoff(SECT_B)).yield.ink).toBeGreaterThan(0);

    // Hand it over the way `settleCityDamage` does, then run the same two recomputes it runs.
    await m.collections.cities.updateOne({ _id: cityDocId(W, nodeId) }, { $set: { ownerSectId: SECT_A } });
    await svc.recomputeSectPayoff(W, SECT_A);
    await svc.recomputeSectPayoff(W, SECT_B);

    const expected = cityYieldBonus([nodeById.get(nodeId)!]);
    expect((await svc.sectPayoff(SECT_A)).yield).toEqual(expected);
    // The half a naive implementation forgets. Nothing else in the system would contradict a stale value
    // here — the sect would simply keep being paid for a city it lost.
    expect((await svc.sectPayoff(SECT_B)).yield.ink).toBe(0);
    expect((await svc.sectPayoff(SECT_B)).siegeBonus).toBe(0);
  });

  it('initCities wipes every cached payoff, because it wipes every ownership', async () => {
    await giveCities(SECT_A, [capitalIds[0]!, worldCenterId]);
    expect((await m.collections.sects.findOne({ _id: SECT_A }))?.cityPayoff).toBeDefined();

    await svc.initCities(W); // season reopen
    expect((await m.collections.sects.findOne({ _id: SECT_A }))?.cityPayoff).toBeUndefined();
    expect((await svc.sectPayoff(SECT_A)).yield.ink).toBe(0);
    // And the cities really are back to NPC hands, so the two are consistent.
    expect(await m.collections.cities.countDocuments({ worldId: W, ownerSectId: { $exists: true } })).toBe(0);
  });

  // ── the sect mirror (§8.5's clock, and the staleness P3 narrowed) ────────────────────────────────

  it('joining a sect mirrors onto every member of the family at once, and stamps the clock', async () => {
    // Start both accounts sect-less, as a family that has not joined yet.
    await m.collections.playerWorld.updateMany({ worldId: W }, { $unset: { sectId: '', sectSince: '' } });
    nowMs += 5_000;
    // The mirror helper is exercised directly rather than through `joinSect`: that endpoint's own gate
    // (family-leader lookup via socialsvc, sect capacity CAS) is covered by sect.e2e.test.ts, and what
    // matters here is the mirror's shape — which is the SAME function joinSect calls.
    const { mirrorSectMembership } = await import('../src/core/citySiege');
    await mirrorSectMembership(m.collections, W, FAM_A, SECT_B, nowMs);

    for (const acct of [A, A2]) {
      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, acct) });
      expect(pw?.sectId, acct).toBe(SECT_B);
      expect(pw?.sectSince, acct).toBe(nowMs);
      // Freshly stamped → the delay has not elapsed, so no payoff yet even if the sect holds cities.
      expect(sectMembershipQualifies(pw!, nowMs)).toBe(false);
    }
  });

  it('leaving clears both fields, so a departed family cannot keep collecting', async () => {
    const { mirrorSectMembership } = await import('../src/core/citySiege');
    await mirrorSectMembership(m.collections, W, FAM_A, null, nowMs);
    for (const acct of [A, A2]) {
      const pw = await m.collections.playerWorld.findOne({ _id: playerWorldId(W, acct) });
      expect(pw?.sectId, acct).toBeUndefined();
      expect(pw?.sectSince, acct).toBeUndefined();
      expect(sectMembershipQualifies(pw!, nowMs + 10 * CITY_BONUS_MEMBERSHIP_DELAY_MS)).toBe(false);
    }
  });

  it('the mirror is scoped to one world and one family — it does not spray across the collection', async () => {
    const { mirrorSectMembership } = await import('../src/core/citySiege');
    // A2 in a different family; only A's family may be touched.
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, A2) }, { $set: { familyId: 'fam-other' } });
    await mirrorSectMembership(m.collections, W, FAM_A, SECT_B, nowMs);
    expect((await m.collections.playerWorld.findOne({ _id: playerWorldId(W, A) }))?.sectId).toBe(SECT_B);
    expect((await m.collections.playerWorld.findOne({ _id: playerWorldId(W, A2) }))?.sectId).toBe(SECT_A);
    // Another world's document with the same familyId must be untouched.
    await m.collections.playerWorld.insertOne({
      _id: playerWorldId('s2-other', A), worldId: 's2-other', accountId: A, familyId: FAM_A,
      troops: 0, troopCap: 0, resources: {}, yieldRate: {}, lastTickAt: nowMs, buildings: {}, rev: 0,
    } as never);
    await mirrorSectMembership(m.collections, W, FAM_A, null, nowMs);
    expect((await m.collections.playerWorld.findOne({ _id: playerWorldId('s2-other', A) }))?.familyId).toBe(FAM_A);
    expect((await m.collections.playerWorld.findOne({ _id: playerWorldId('s2-other', A) }))?.sectId).toBeUndefined();
  });

  it('the payoff is per-member, not split — two members of the same sect each get the full figure', async () => {
    // §8.1 is explicit that the table is "每名宗门成员各自获得". A split would make cities a reason NOT to
    // recruit, which inverts §8.2's entire argument for the flat shape.
    const held = [capitalIds[0]!];
    await giveCities(SECT_A, held);
    const bonus = cityYieldBonus([nodeById.get(held[0]!)!]);
    const [ra, ra2] = [await rateOf(A), await rateOf(A2)];
    // Both are identical fresh capitals, which produce only ink — so `paper` is the bonus and nothing else,
    // and each member must see the WHOLE figure rather than a share of it.
    expect(ra.paper).toBe(bonus.paper);
    expect(ra2.paper).toBe(bonus.paper);
  });

  it('tileId/proceduralTile fixtures actually resolved (canary: an empty world would pass everything above)', () => {
    expect(gradedIds.length).toBeGreaterThan(5);
    expect(capitalIds.length).toBeGreaterThan(1);
    expect(nodeById.get(worldCenterId)!.kind).toBe('worldCenter');
    expect(tileId(W, base.x, base.y)).toContain(W);
  });
});
