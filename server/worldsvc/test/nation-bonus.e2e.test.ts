// worldsvc province-bonus end-to-end (S8-6.5 / G1, §2.4, ADR-034; re-keyed by ADR-074 §9 / ADR-076): real
// Mongo + fake clock.
//   Ownership determination: a tile falls within the province of a capital whose CITY the tile owner's SECT
//   holds → the defence bonus applies. Until 2026-08-27 the predicate was `nations.ownerId === owner`, an
//   account-level field that had had no writer since ADR-074 P0 deleted `applyNationChange` — so the bonus
//   this file exists to isolate was, in production, reaching nobody. `ownProvince` below therefore sets
//   `CityDoc.ownerSectId`, and `ownNationLegacy` still writes the old field so one case can prove it is
//   ignored. The PRODUCTION half of the pair was retired outright (double-counts §8.1's city table).
//   ① Production bonus: tiles in own capital region yield ×(1+NATION_BONUS_PRODUCTION); no national affiliation → raw yield (control case).
//   ② Defense bonus: garrison in own capital region → effective garrison ×(1+NATION_BONUS_DEFENSE), raising the conquest threshold (defender wins with equal attack);
//      no national affiliation → same attack breaks through (control case, confirming the bonus comes from nationality).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  provinceCapitalPositions,
  provinceIdxAt,
  worldSeed,
  tileYield,
  RESOURCE_YIELD_BASE,
  NATION_BONUS_PRODUCTION,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  type ResourceType,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import type { TileDoc, PlayerWorldDoc, NationDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_nation_test';
const W = 's1-nation';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.nation.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const CAPS = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, worldSeed(W));

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

const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center';

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so an attack march to a far-away target clears the new gate. Costs GARRISON_PER_TILE troops.
 */
async function connect(svc: WorldService, accountId: string, target: { x: number; y: number }): Promise<void> {
  const deltas: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dx, dy] of deltas) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    if (!NON_BLOCKING(proceduralTile(W, nx, ny))) continue;
    await svc.occupyTile(W, accountId, nx, ny);
    return;
  }
  throw new Error('no connector neighbor found');
}

describe.skipIf(!mongo)('worldsvc nation-bonus e2e', () => {
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

  /** Makes an account own a capital (writes NationDoc directly, bypassing the siege nation-founding flow). */
  /**
   * Give `accountId`'s sect the province capital's CITY — the predicate the bonus reads since ADR-076.
   * Creates the sect on the fly (these fixtures have no social setup of their own) and mirrors it onto
   * playerWorld, which is where `inOwnSectProvince` looks.
   */
  async function ownProvince(capitalIdx: number, accountId: string): Promise<void> {
    const sectId = `sect-${accountId}`;
    await m.collections.sects.updateOne(
      { _id: sectId },
      { $set: { _id: sectId, worldId: W, name: sectId, tag: 'TG', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 0 } },
      { upsert: true },
    );
    await m.collections.playerWorld.updateOne({ _id: playerWorldId(W, accountId) }, { $set: { sectId } });
    // The capital city document for this province. `initCities` is not run by this file's fixtures (they
    // predate ADR-074), so the doc is written directly — only `kind`/`provinceIdx`/`ownerSectId` matter here.
    const [cx, cy] = CAPS[capitalIdx]!;
    await m.collections.cities.updateOne(
      { _id: `city:${W}:capital-${capitalIdx}` },
      {
        $set: {
          worldId: W, nodeId: `capital-${capitalIdx}`, kind: 'capital', provinceIdx: capitalIdx,
          x: cx, y: cy, footprint: 9, level: 10, ownerSectId: sectId,
          durability: 1, durabilityMax: 1, durabilityRegenAt: nowMs, regenPerHour: 0, rev: 0,
        },
      },
      { upsert: true },
    );
  }

  /** Writes the PRE-ADR-076 `nations.ownerId` field. Kept only to prove nothing reads it any more. */
  async function ownNationLegacy(capitalIdx: number, accountId: string): Promise<void> {
    const [cx, cy] = CAPS[capitalIdx]!;
    const doc: NationDoc = {
      _id: `nation:${W}:${capitalIdx}`,
      worldId: W,
      capitalIdx,
      x: cx,
      y: cy,
      ownerId: accountId,
      rev: 0,
    };
    await m.collections.nations.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
  }

  /** Sets up a defender directly (playerWorld + one territory tile) with full garrison control (aligned with siege.e2e). */
  async function setupDefender(accountId: string, x: number, y: number, garrison: number): Promise<void> {
    const proc = proceduralTile(W, x, y);
    const tile: TileDoc = {
      _id: tileId(W, x, y),
      worldId: W,
      x,
      y,
      type: 'territory',
      // level: 1 pins the in-engine defender base HP at npcBaseHp(1)=60. ADR-069 (2026-08-19) made siege
      // damage scale with carried troops, which turned that base into a real gate — so leaving the level to
      // whatever the terrain generator rolled here (1..10 → base 60..600) would silently make the fixed
      // 815-troop force in the defense cases below decide the test, instead of the nationality bonus this
      // file exists to isolate. The production-bonus cases above don't go through this helper.
      level: 1,
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
      resources: { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 },
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

  // ── Production bonus ──

  // ADR-074 P3 / §9 RETIRED this bonus (this case asserted it until 2026-08-27). A province capital's
  // economic value is now paid by SLG_CITY_SIEGE_DESIGN §8.1's flat city table, so leaving the +10% here
  // would pay twice for the same conquest — and P0 had already made it unreachable in production by
  // deleting `applyNationChange` and unsetting `nations` ownership at season open, so the only thing still
  // exercising it was this test. Inverted rather than deleted: the removal is the property worth pinning,
  // because a well-meaning re-add is exactly how a double-count comes back.
  it('production bonus is GONE (§9): owning the capital region no longer amplifies tile yield', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource' && t.resType !== 'ink', 8, 8);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    // a owns the (5,5) main base AND the capital region containing (r) — the exact precondition that used to
    // grant the bonus, asserted through BOTH spellings of it so the removal cannot be mistaken for "the new
    // predicate just isn't set up": the legacy `nations.ownerId` field AND ADR-076's `CityDoc.ownerSectId`.
    const baseCap = provinceIdxAt(5, 5);
    const rCap = provinceIdxAt(r.x, r.y);
    await ownNationLegacy(baseCap, 'a');
    await ownProvince(baseCap, 'a');
    if (rCap !== baseCap) { await ownNationLegacy(rCap, 'a'); await ownProvince(rCap, 'a'); }
    await svc.occupyTile(W, 'a', r.x, r.y);

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    const rawResource = RESOURCE_YIELD_BASE * Math.max(1, proc.level);
    expect(rate[rt]).toBe(rawResource);
    // Spelled out so a re-add fails loudly rather than by an off-by-10%: the old expectation, now wrong.
    expect(rate[rt]).not.toBe(Math.floor(rawResource * (1 + NATION_BONUS_PRODUCTION)));
    // ...and the control case below must now be indistinguishable from this one.
  });

  it('control — no national affiliation: the same raw value, i.e. nationality now changes nothing', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const r = findCoord((t) => t.type === 'resource' && t.resType !== 'ink', 8, 8);
    const proc = proceduralTile(W, r.x, r.y);
    const rt = proc.resType as ResourceType;
    await svc.occupyTile(W, 'a', r.x, r.y); // no capital occupied

    const rate = (await svc.getMe(W, 'a')).yieldRate!;
    expect(rate[rt]).toBe(tileYield('resource', proc.level, rt)[rt]); // raw value, no amplification
  });

  // ── Defense bonus ──

  it('defense bonus: garrison in own capital region → conquest threshold raised, defender wins with equal attack', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500);
    await ownProvince(provinceIdxAt(tgt.x, tgt.y), 'b'); // ADR-076: b's SECT holds the province capital's CITY
    await connect(svc, 'a', tgt); // ADR-039: border the target before attacking

    // Authoritative engine (G3-2b, §16 / ADR-026 siege-value tuning): 660 troops can defeat 500 defenders
    // (see control case below), but cannot defeat the nation-bonus-boosted floor(500*1.15)=575 effective
    // defenders → defender wins (same march seed; the only variable is the +75 effective garrison from nationality).
    // The force was 815 until ADR-069 (2026-08-19): once siege damage scales with carried troops, 815 beat
    // BOTH garrisons and the pair stopped discriminating. Re-measured flip window at base HP 60: 640-680
    // beats 500 but not 575 on all 5 seeds, so 660 sits in the middle of it.
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 660);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    expect((await svc.getTile(W, 'b', tgt.x, tgt.y)).mine).toBe(true); // tile did not change hands
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('defender_win');
  });

  it('the LEGACY nations.ownerId alone grants nothing — the same attack conquers (ADR-076 re-key)', async () => {
    // The other half of the re-key, and the one that would have gone unnoticed: before ADR-076 this exact
    // fixture was what the defence case above used, and it was already reaching nobody in production because
    // no code path writes `nations.ownerId` any more. Pinning it means a revert to the account-level
    // predicate fails here rather than silently restoring a dead bonus.
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500);
    await ownNationLegacy(provinceIdxAt(tgt.x, tgt.y), 'b'); // legacy field only — no city, no sect
    await connect(svc, 'a', tgt);

    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 660);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
  });

  it('control — defender has no province affiliation: same attack conquers the tile (confirms bonus comes from the capital city)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const tgt = findCoord(NON_BLOCKING, 10, 5);
    await setupDefender('b', tgt.x, tgt.y, 500); // b is given no capital
    await connect(svc, 'a', tgt); // ADR-039: border the target before attacking

    // Same 660 troops, same march seed, but defender has no nationality bonus (500) → tile conquered, disproving hypothesis that the prior defender win was unrelated to nationality.
    const mv = await svc.startMarch(W, 'a', 5, 5, tgt.x, tgt.y, 'attack', 660);
    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // 2026-08-09: winning a PvP attack now enters an OCCUPY_HOLD_SEC contested hold instead of transferring
    // ownership instantly (mirrors ADR-037 §5.4 neutral-land occupation) — settle it before asserting capture.
    const held = await svc.getTile(W, 'a', tgt.x, tgt.y);
    expect(held.contestedByMe).toBe(true);
    const siege = await m.collections.sieges.findOne({ worldId: W, attackerId: 'a' });
    expect(siege?.outcome).toBe('attacker_win');
    nowMs = held.contestedUntil!;
    expect(await svc.processDueOccupations()).toBe(1);
    expect((await svc.getTile(W, 'a', tgt.x, tgt.y)).mine).toBe(true); // tile changed hands to attacker
  });
});
