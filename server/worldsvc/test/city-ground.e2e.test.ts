// worldsvc wild-city ground (ADR-074 P0) end-to-end: real Mongo + fake clock.
//
// A wild city's whole footprint is `familyKeep` city ground: indivisible, siege-only, and (from P1) gated on
// sect membership. Every case here fails on the pre-ADR-074 code, which is the point — before this change:
//   • `proceduralTile` classified only a city's single ANCHOR cell as city ground, so the rest of a Lv.3-10
//     city's 5×5/7×7/9×9 plot was ordinary occupiable resource land hidden under the city sprite (用户
//     2026-08-25 截图: 城墙内部弹出「墨水 · Lv.2 · 建议兵力 240」的普通占领框);
//   • `validateMarchTarget` had NO `familyKeep` branch in any of its four march kinds, and neither did the
//     direct `occupyTile` path, so even the anchor cell was claimable by one player;
//   • base placement / auto-spawn never excluded city ground either;
//   • and `settleOccupation` → `applyNationChange` turned a plain occupy of the province-capital anchor
//     (npcGarrison(10) = 1,200 troops) into founding a NATION for that single account.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  playerWorldId,
  allCityNodes,
  cityFootprint,
  isCityGroundTile,
  npcGarrison,
  SLG_MAP_W,
  SLG_MAP_H,
  TROOP_CAP_BASE,
  baseFootprintCells,
  baseFootprintInBounds,
  type CardInstance,
  type MapEditorCityNode,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type TeamTemplate, type CardSLGState, type MarchDoc } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient } from '../src/gatewayClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_cityground_test';
const W = 's1-cityground';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.city-ground.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

/**
 * A city of `kind` whose plot has an in-bounds NON-anchor cell (the cell the old anchor-only generator left
 * as ordinary occupiable land), plus that cell.
 *
 * `kind` is a required argument rather than "whichever city works first" on purpose: capitals and graded
 * cities are two separate branches of `_cityGroundNodeAt`, and a first-match helper silently tested only the
 * capital one. Mutating the graded-city branch to anchor-only then left this whole suite green — measured,
 * not hypothesised (mutation M1 during ADR-074 P0). Graded cities are also the 54 a player actually meets.
 */
function findCityWithInteriorCell(kind: 'capital' | 'garrison'): { node: MapEditorCityNode; cell: { x: number; y: number } } {
  for (const node of allCityNodes(W)) {
    if (node.kind !== kind) continue;
    const r = (node.footprint - 1) / 2;
    if (r < 1) continue;
    const cell = { x: node.x + r, y: node.y };
    if (cell.x < 0 || cell.x >= SLG_MAP_W) continue;
    const t = proceduralTile(W, cell.x, cell.y);
    // Must be city ground AND belong to THIS city. The level check is what distinguishes "this graded city's
    // own plot" from "a neighbouring province capital's 9×9 plot that happens to swallow this cell" —
    // capitals are tested first in `_cityGroundNodeAt`, so an overlapped cell reports level 10, not the
    // graded city's 3-8. Without it this helper hands back a capital cell while claiming it is a graded one.
    if (t.type !== 'familyKeep' || t.level !== node.level) continue;
    return { node, cell };
  }
  throw new Error(`no ${kind} city with an in-bounds interior cell (check allCityNodes / cityFootprint)`);
}

/** Placeable capital anchor near (sx,sy): whole 3×3 in bounds and clear of reserved terrain (mirrors footprintFree). */
function findNearbyBase(sx: number, sy: number): { x: number; y: number } {
  for (let r = 1; r < 80; r++) {
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

describe.skipIf(!mongo)('worldsvc wild-city ground e2e (ADR-074 P0)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push() { /* pushes are irrelevant to these assertions */ },
    async broadcast() { /* ditto */ },
  };
  // Any requested cardInstanceId resolves to a level-1 card — the 'move' case needs setTeams to accept a
  // team, and no case here depends on a specific card's stats (nothing gets as far as a battle).
  const CARD_INV_ANY: Record<string, CardInstance> = new Proxy({} as Record<string, CardInstance>, {
    get: (_t, prop: string) => ({ id: prop, defId: 'lichuang', level: 1, gear: {}, locked: false }),
  });
  const fakeMeta: WorldMetaClient = {
    available: true,
    async getProfile() { return null; },
    async getSaveFields() { return { pveUpgrades: {}, unitLevels: {}, gear: {}, equipmentInv: {}, cardInv: CARD_INV_ANY }; },
    grantMaterial: async () => { /* unused */ },
    batchProfiles: () => { throw new Error('fake WorldMetaClient.batchProfiles() is not stubbed in this test'); },
    grantTitle: () => { throw new Error('fake WorldMetaClient.grantTitle() is not stubbed in this test'); },
  };

  // Graded city ("garrison" kind) — the 54 a player actually meets, and the branch a capital-only helper
  // silently skipped. The capital branch gets its own case below.
  const { node: city, cell: interior } = findCityWithInteriorCell('garrison');
  const { node: capitalCity, cell: capitalInterior } = findCityWithInteriorCell('capital');
  const base = findNearbyBase(city.x, city.y);
  const A = 'acct-city-a';

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      gateway: fakeGateway,
      meta: fakeMeta,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now,
    });
    // initNations, not openSeason: creating a world document would activate joinWorld's capacity guard
    // ($expr population < capacity), and the nation docs are all these cases need — same "no world doc =
    // uncapped" setup the sibling e2e suites use.
    await svc.initNations(W);
    await svc.joinWorld(W, A, base.x, base.y);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A) },
      { $set: { troops: TROOP_CAP_BASE, troopCap: TROOP_CAP_BASE } },
    );
  });

  afterAll(async () => { await m.close(); });

  // ── ① Generation: the whole plot is city ground ────────────────────────────────────────────
  it('classifies a NON-anchor cell of a GRADED city plot as city ground, at the city level', () => {
    expect(city.kind).toBe('garrison');
    expect(city.footprint).toBe(cityFootprint(city.level));
    expect(interior).not.toEqual({ x: city.x, y: city.y }); // this is the cell the old generator left as land
    const t = proceduralTile(W, interior.x, interior.y);
    expect(t.type).toBe('familyKeep');
    expect(t.level).toBe(city.level);
    expect(t.resType).toBeUndefined(); // city ground does not yield (§8.1 double-payout)
  });

  it('classifies a NON-anchor cell of a province-CAPITAL plot as city ground too (separate generator branch)', () => {
    expect(capitalCity.kind).toBe('capital');
    const t = proceduralTile(W, capitalInterior.x, capitalInterior.y);
    expect(t.type).toBe('familyKeep');
    expect(t.level).toBe(capitalCity.level);
    expect(t.resType).toBeUndefined();
  });

  // ── ② The four march kinds + the direct occupy path ────────────────────────────────────────
  it('rejects an occupy march onto a city plot interior cell', async () => {
    await expect(svc.startMarch(W, A, base.x, base.y, interior.x, interior.y, 'occupy', 600))
      .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('rejects a sweep march onto a city plot interior cell (no farmable garrison inside the walls)', async () => {
    await expect(svc.startMarch(W, A, base.x, base.y, interior.x, interior.y, 'sweep', 600))
      .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('rejects a move (station) march onto a city plot interior cell', async () => {
    // 'move' needs a real team to get past its own "Move requires a team" guard, which runs BEFORE target
    // validation — without one this case would pass for the wrong reason.
    const cardId = 'card-move-1';
    await svc.setTeams(W, A, [{ id: 'mt1', name: 'mt1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A) },
      { $set: { [`cardState.${cardId}`]: { currentTroops: 600, teamId: 'mt1' } as CardSLGState } },
    );
    await expect(svc.startMarch(W, A, base.x, base.y, interior.x, interior.y, 'move', 1, 'mt1'))
      .rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('rejects an attack march with an explicit not-implemented error, not the misleading "use occupy/sweep"', async () => {
    // P0 closes the holes; the siege itself is P1. The ownerless branch's TILE_NOT_OWNED advice ("use
    // occupy/sweep") would be actively wrong here since both are now blocked.
    await expect(svc.startMarch(W, A, base.x, base.y, interior.x, interior.y, 'attack', 600))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects the direct occupyTile path on a city plot interior cell', async () => {
    await expect(svc.occupyTile(W, A, interior.x, interior.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  it('rejects the city ANCHOR cell too, not just the interior', async () => {
    await expect(svc.occupyTile(W, A, city.x, city.y)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
  });

  // ── ③ Base placement / auto-spawn never lands on city ground ───────────────────────────────
  it('refuses to place a capital on city ground', async () => {
    await expect(svc.joinWorld(W, 'acct-city-b', interior.x, interior.y))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('never auto-spawns a capital whose 3×3 footprint touches city ground', async () => {
    // 40 auto-placed players: every footprint cell must be off city ground. The old spawn guard listed
    // center/obstacle/bridge/plankway/stronghold and omitted familyKeep entirely.
    for (let i = 0; i < 40; i++) {
      const acct = `acct-spawn-${i}`;
      const view = await svc.joinWorld(W, acct);
      const anchor = view.mainBaseTile;
      expect(anchor).toBeTruthy();
      const bx = Number(anchor!.split(':')[1]);
      const by = Number(anchor!.split(':')[2]);
      for (const c of baseFootprintCells(bx, by)) {
        expect(isCityGroundTile(proceduralTile(W, c.x, c.y).type), `spawned on city ground at ${c.x}:${c.y}`).toBe(false);
      }
    }
  });

  // ── ④ Arrival-time guard (defence in depth) ────────────────────────────────────────────────
  // The departure-side guards above are not the only line: `combatSiege/occupation.ts` (occupy) and
  // `combatMarch/arrival.ts` (move) re-validate the target on ARRIVAL, because the world can change in
  // flight. Both used to name `center` alone and now use `isCityGroundTile`, so a march that got airborne
  // before the guards existed — or against a template whose designer dragged a city under its path — is
  // refused on landing instead of capturing city ground. Marches are inserted directly to bypass
  // startMarch, which is exactly the state an in-flight march from the old build would be in.

  /**
   * `interior` is the plot's EAST EDGE cell, so the cell one step further east is ordinary land outside the
   * walls. Claiming it gives A territory adjacent to `interior`, which is what makes the ADR-039
   * connectivity check pass — without it `applyOccupy` refunds on connectivity and returns BEFORE reaching
   * the city-ground guard, i.e. the test passes without exercising anything (measured: mutation M5 left
   * both arrival cases green until this setup was added).
   */
  async function claimNeighbourOutsideWalls(): Promise<{ x: number; y: number }> {
    const n = { x: interior.x + 1, y: interior.y };
    expect(proceduralTile(W, n.x, n.y).type).not.toBe('familyKeep'); // must be outside the plot
    await svc.occupyTile(W, A, n.x, n.y);
    return n;
  }

  /** Insert an already-due march straight into the collection, then settle arrivals. */
  async function arriveDirect(kind: 'occupy' | 'move', toX: number, toY: number, extra: Partial<MarchDoc> = {}): Promise<void> {
    await m.collections.marches.insertOne({
      _id: `m-${kind}-${toX}-${toY}-${nowMs}`, worldId: W, ownerId: A,
      fromTile: tileId(W, base.x, base.y), toTile: tileId(W, toX, toY),
      kind, troops: 3000,
      departAt: nowMs, arriveAt: nowMs, status: 'marching', rev: 0,
      ...extra,
    } as MarchDoc);
    await svc.processDueArrivals();
  }

  it('an in-flight OCCUPY march landing on city ground does not capture it', async () => {
    await claimNeighbourOutsideWalls();
    await arriveDirect('occupy', interior.x, interior.y);
    const tile = await m.collections.tiles.findOne({ _id: tileId(W, interior.x, interior.y) });
    // Either no tile doc at all, or one that never gained an owner / occupation hold.
    expect(tile?.ownerId).toBeUndefined();
    expect(tile?.contestedBy).toBeUndefined();
    // The march is settled (claimed and consumed), not left pending forever.
    expect(await m.collections.marches.countDocuments({ worldId: W, kind: 'occupy' })).toBe(0);
  });

  it('guards that occupy case: the SAME march against the land outside the walls DOES capture', async () => {
    // Proves the assertions above are the city-ground rule and not the march never being processed —
    // the failure mode this whole block had before `claimNeighbourOutsideWalls` existed.
    const n = await claimNeighbourOutsideWalls();
    const target = { x: n.x + 1, y: n.y };
    if (proceduralTile(W, target.x, target.y).type === 'familyKeep') return; // another plot — skip, rare
    await arriveDirect('occupy', target.x, target.y);
    const tile = await m.collections.tiles.findOne({ _id: tileId(W, target.x, target.y) });
    // Captures land as either an owner (instant) or a pending occupation hold, depending on the garrison
    // battle — either outcome proves the march reached the capture logic.
    expect(tile?.ownerId ?? tile?.contestedBy).toBeTruthy();
  });

  it('an in-flight MOVE march landing on city ground does not station a team there', async () => {
    // A move needs a real team, or applyMove/tryParkTeam bails before the guard (same vacuity trap).
    const cardId = 'card-arrive-1';
    await svc.setTeams(W, A, [{ id: 'at1', name: 'at1', army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A) },
      { $set: { [`cardState.${cardId}`]: { currentTroops: 600, teamId: 'at1' } as CardSLGState } },
    );
    await arriveDirect('move', interior.x, interior.y, {
      teamId: 'at1', troops: 1, army: [{ cardInstanceId: cardId, col: 0, row: 1 }], stationMode: 'idle',
    });
    expect(await m.collections.stationed.findOne({ _id: tileId(W, interior.x, interior.y) })).toBeNull();
  });

  it('guards that move case: the same team DOES station on ordinary land outside the walls', async () => {
    const cardId = 'card-arrive-2';
    await svc.setTeams(W, A, [{ id: 'at2', name: 'at2', army: [{ cardInstanceId: cardId, col: 0, row: 1 }] }] as TeamTemplate[]);
    await m.collections.playerWorld.updateOne(
      { _id: playerWorldId(W, A) },
      { $set: { [`cardState.${cardId}`]: { currentTroops: 600, teamId: 'at2' } as CardSLGState } },
    );
    const outside = { x: interior.x + 1, y: interior.y };
    expect(proceduralTile(W, outside.x, outside.y).type).not.toBe('familyKeep');
    await arriveDirect('move', outside.x, outside.y, {
      teamId: 'at2', troops: 1, army: [{ cardInstanceId: cardId, col: 0, row: 1 }], stationMode: 'idle',
    });
    expect(await m.collections.stationed.findOne({ _id: tileId(W, outside.x, outside.y) })).not.toBeNull();
  });

  // ── ⑤ Nation founding is gone ──────────────────────────────────────────────────────────────
  it('does not found a nation from occupying a province-capital cell (the ADR-074 headline hole)', async () => {
    const caps = svc.capitalsFor(W);
    // Any non-core capital; its whole footprint is city ground now, so the anchor is unoccupiable.
    const capital = caps.find(([cx, cy]) => proceduralTile(W, cx, cy).type === 'familyKeep');
    expect(capital).toBeTruthy();
    const [cx, cy] = capital!;
    expect(npcGarrison(proceduralTile(W, cx, cy).level)).toBeGreaterThan(0); // the garrison that used to be the only gate

    await expect(svc.occupyTile(W, A, cx, cy)).rejects.toMatchObject({ code: 'TILE_OCCUPIED' });
    // …and no nation acquired an owner by any route.
    const owned = (await svc.getNations(W)).filter((n) => n.ownerId != null);
    expect(owned).toEqual([]);
    // The tile itself was never written either.
    expect(await m.collections.tiles.findOne({ _id: tileId(W, cx, cy) })).toBeNull();
  });
});
