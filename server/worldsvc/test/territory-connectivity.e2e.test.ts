// worldsvc territory connectivity end-to-end (ADR-039, SLG_DESIGN §4.1): real Mongo + fake clock.
//   "连地" hard rule: occupy/attack march targets must be 4-directionally adjacent to a tile already owned
//   by the requester's sect (own family ∪ sibling families in the same sect — allied sects do NOT count).
//   ① solo player (no family): only own territory counts; blocked far away, allowed once adjacent.
//   ② sect-wide judgment: a sibling family's territory (not the requester's own) satisfies connectivity.
//   ③ a different, non-allied sect's territory does not count.
//   ④ an ALLIED sect's territory still does not count (alliance ≠ merged frontier).
//   ⑤ capitals check the whole 3×3 footprint (not just the anchor cell, which is only ever bordered by its
//      own ring): blocked from afar, allowed once bordering the footprint.
//   ⑥ arrival re-check: losing the connecting tile mid-flight turns a would-be capture into a miss (refund).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  OCCUPY_MIN_TROOPS,
  baseFootprintInBounds,
  baseFootprintCells,
  familyProsperity,
  type FamilyRole,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldGatewayClient, SlgPushMsg } from '../src/gatewayClient';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_connectivity_test';
const W = 's1-connectivity';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.territory-connectivity.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);
const NON_BLOCKING = (t: ReturnType<typeof proceduralTile>): boolean =>
  t.type !== 'obstacle' && t.type !== 'bridge' && t.type !== 'plankway' && t.type !== 'center' && t.type !== 'stronghold';

function findCoord(predicate: (t: ReturnType<typeof proceduralTile>) => boolean, sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        if (predicate(proceduralTile(W, x, y))) return { x, y };
      }
    }
  }
  throw new Error('no matching tile found');
}

/** Spiral-search for a spawnable 3×3 base anchor near (sx,sy) (mirrors alliance-attack.e2e / joinWorld's footprintFree). */
function findBaseCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx, y = sy + dy;
        if (!baseFootprintInBounds(x, y, SLG_MAP_W, SLG_MAP_H)) continue;
        const blocked = baseFootprintCells(x, y).some((c) => {
          const t = proceduralTile(W, c.x, c.y);
          return t.type === 'center' || t.type === 'obstacle' || t.type === 'bridge' || t.type === 'plankway' || t.type === 'stronghold';
        });
        if (!blocked) return { x, y };
      }
    }
  }
  throw new Error('no spawnable base anchor found');
}

/** First 4-directional neighbor of `target` that is non-blocking (used both to occupy a connector tile and, for
 *  capitals, to border the footprint ring without landing inside it). */
function neighborOf(target: { x: number; y: number }): { x: number; y: number } {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const nx = target.x + dx, ny = target.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    if (NON_BLOCKING(proceduralTile(W, nx, ny))) return { x: nx, y: ny };
  }
  throw new Error('no connector neighbor found');
}

/**
 * First cell strictly OUTSIDE a 3×3 base footprint anchored at `base` that is still 4-directionally adjacent
 * to the footprint's ring (offset ±2 along an axis — offset ±1 would land ON the ring itself, which is the
 * base's own territory and can't be occupied as a "connector", and which the connectivity check's footprint
 * resolution deliberately excludes from its own neighbor set — see coreVision.ts targetFootprintCells).
 */
function outsideFootprint(base: { x: number; y: number }): { x: number; y: number } {
  for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
    const nx = base.x + dx, ny = base.y + dy;
    if (nx < 0 || ny < 0 || nx >= SLG_MAP_W || ny >= SLG_MAP_H) continue;
    if (NON_BLOCKING(proceduralTile(W, nx, ny))) return { x: nx, y: ny };
  }
  throw new Error('no footprint-adjacent cell found');
}

/** In-process fake of socialsvc's family store (family identity/roster/sectId mirror live there, P4; mirrors alliance-attack.e2e). */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

  addFamily(familyId: string, leaderId: string, name: string, tag: string, sectId?: string): string {
    this.families.set(familyId, {
      familyId, name, tag: tag.toUpperCase(), leaderId, memberCount: 1,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0, ...(sectId ? { sectId } : {}),
    });
    this.memberRole.set(leaderId, { familyId, role: 'leader' });
    return familyId;
  }

  addMember(accountId: string, familyId: string): void {
    this.memberRole.set(accountId, { familyId, role: 'member' });
    const f = this.families.get(familyId);
    if (f) f.memberCount += 1;
  }

  async getFamilyId(accountId: string): Promise<string | null> {
    return this.memberRole.get(accountId)?.familyId ?? null;
  }

  async getMember(accountId: string): Promise<FamilyMembership | null> {
    const mr = this.memberRole.get(accountId);
    if (!mr) return null;
    const f = this.families.get(mr.familyId);
    if (!f) return null;
    return { familyId: mr.familyId, role: mr.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id))
      .filter((f): f is FamilySummary & { activity: number } => !!f).map((f) => ({ ...f }));
  }

  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }

  async setSect(familyId: string, sid: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) f.sectId = sid; else delete f.sectId;
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    const f = this.families.get(familyId);
    if (f) f.activity += delta;
  }

  async refreshProsperity(familyId: string, territoryCount: number): Promise<number> {
    const f = this.families.get(familyId);
    if (!f) return 0;
    f.prosperity = familyProsperity(territoryCount, f.memberCount, f.activity);
    f.territoryCount = territoryCount;
    return f.prosperity;
  }

  async resetSlgState(familyId: string): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    f.territoryCount = 0; f.prosperity = 0; f.activity = 0; delete f.sectId;
  }

  async push(_channel: SocialsvcChannel, _event: string, _payload: unknown, _targets?: string[]): Promise<void> {
    /* not exercised */
  }
}

describe.skipIf(!mongo)('worldsvc territory connectivity e2e (ADR-039)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;

  const fakeGateway: WorldGatewayClient = {
    available: true,
    async push(_a: string, _msg: SlgPushMsg) { /* not asserted */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({ cols: m.collections, redis: null, gateway: fakeGateway, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('solo player (no family): blocked far from own territory, allowed once bordering it', async () => {
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);

    const far = findCoord((t) => t.type === 'resource', 60, 60);
    await expect(svc.startMarch(W, 'solo', base.x, base.y, far.x, far.y, 'occupy', OCCUPY_MIN_TROOPS))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });

    // Bordering the base's own 3×3 footprint (already-owned ring cells) satisfies connectivity for free.
    const adjacent = outsideFootprint(base);
    await expect(svc.startMarch(W, 'solo', base.x, base.y, adjacent.x, adjacent.y, 'occupy', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'occupy', status: 'marching' });
  });

  it('capital footprint bootstraps connectivity even if the ring cells lost their ownerId (legacy base repair)', async () => {
    // Regression: a base whose 8 ring TileDocs are missing `ownerId` (a pre-full-footprint / legacy
    // capital) must still let the owner occupy land bordering the footprint. Before the mainBaseTile-based
    // bootstrap, connectivity counted only ring TileDocs' ownerId, so such a base could occupy nothing at
    // all beside itself ("连自己基地旁边的地都没法打"). The anchor is left owned (so joinWorld still treats
    // the base as the player's), only the 8 ring cells are stripped.
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);
    const anchorTid = tileId(W, base.x, base.y);
    await m.collections.tiles.updateMany(
      { worldId: W, ownerId: 'solo', baseRing: true, _id: { $ne: anchorTid } },
      { $unset: { ownerId: '' } },
    );

    const adjacent = outsideFootprint(base);
    await expect(svc.startMarch(W, 'solo', base.x, base.y, adjacent.x, adjacent.y, 'occupy', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'occupy', status: 'marching' });
  });

  it('legacy-base repair is sect-wide: a sibling\'s ownerId-stripped capital footprint still connects', async () => {
    // Same repair as above, but the guaranteed-territory footprint belongs to a *sibling family* (a2), not
    // the requester (a). Exercises the family branch of the mainBaseTile resolution: a2's capital footprint
    // must count sect-wide even though its ring cells carry no ownerId.
    const sectA = `s:${W}:AAA`;
    const famA = `f:${W}:A`, famA2 = `f:${W}:A2`;
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addFamily(famA2, 'a2', 'A2', 'A2', sectA);
    await m.collections.sects.insertOne({
      _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a',
      memberFamilyCount: 2, allySectIds: [], prosperity: 0, rev: 1,
    });
    const aBase = findBaseCoord(10, 10);
    const a2Base = findBaseCoord(60, 10);
    await svc.joinWorld(W, 'a', aBase.x, aBase.y);
    await svc.joinWorld(W, 'a2', a2Base.x, a2Base.y);
    // Strip a2's ring ownership (legacy capital), so only its mainBaseTile-derived footprint can bootstrap it.
    await m.collections.tiles.updateMany(
      { worldId: W, ownerId: 'a2', baseRing: true, _id: { $ne: tileId(W, a2Base.x, a2Base.y) } },
      { $unset: { ownerId: '' } },
    );
    const target = outsideFootprint(a2Base); // adjacent to a2's footprint, far from a's own territory
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'occupy', status: 'marching' });
  });

  it('pathfinding: a legacy base\'s army can still march out past its own ownerId-stripped ring', async () => {
    // Isolates the computeMarchPath fix from connectivity. Sweep is NOT connectivity-gated (only occupy/attack
    // claim land), so a successful far sweep proves the army escaped its own footprint — before the fix the
    // un-owned ring cells (type:'base', no ownerId) matched the "enemy building" $nin filter and walled the
    // army inside the city, throwing PATH_BLOCKED.
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);
    await m.collections.tiles.updateMany(
      { worldId: W, ownerId: 'solo', baseRing: true, _id: { $ne: tileId(W, base.x, base.y) } },
      { $unset: { ownerId: '' } },
    );
    const far = findCoord((t) => t.type === 'resource', 60, 60);
    await expect(svc.startMarch(W, 'solo', base.x, base.y, far.x, far.y, 'sweep', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'sweep', status: 'marching' });
  });

  it('sect-wide judgment: a sibling family\'s territory (not the requester\'s own) satisfies connectivity', async () => {
    const sectA = `s:${W}:AAA`;
    const famA = `f:${W}:A`, famA2 = `f:${W}:A2`;
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addFamily(famA2, 'a2', 'A2', 'A2', sectA);
    await m.collections.sects.insertOne({
      _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a',
      memberFamilyCount: 2, allySectIds: [], prosperity: 0, rev: 1,
    });

    const aBase = findBaseCoord(10, 10);
    const a2Base = findBaseCoord(60, 10); // far from a's base
    await svc.joinWorld(W, 'a', aBase.x, aBase.y);
    await svc.joinWorld(W, 'a2', a2Base.x, a2Base.y);

    // A target adjacent to a2's base (far from a's own territory) — connected only through the shared sect.
    const target = outsideFootprint(a2Base);
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'occupy', status: 'marching' });
  });

  it('a different, non-allied sect\'s territory does not count toward connectivity', async () => {
    const sectA = `s:${W}:AAA`, sectB = `s:${W}:BBB`;
    const famA = `f:${W}:A`, famB = `f:${W}:B`;
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addFamily(famB, 'b', 'B', 'B', sectB);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'b', memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1 },
    ]);

    const aBase = findBaseCoord(10, 10);
    const bBase = findBaseCoord(60, 10);
    await svc.joinWorld(W, 'a', aBase.x, aBase.y);
    await svc.joinWorld(W, 'b', bBase.x, bBase.y);

    const target = outsideFootprint(bBase); // adjacent to b's (unrelated sect) territory only
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });
  });

  it('an ALLIED sect\'s territory still does not count (alliance ≠ merged frontier)', async () => {
    const sectA = `s:${W}:AAA`, sectB = `s:${W}:BBB`;
    const famA = `f:${W}:A`, famB = `f:${W}:B`;
    socialsvc.addFamily(famA, 'a', 'A', 'A', sectA);
    socialsvc.addFamily(famB, 'b', 'B', 'B', sectB);
    await m.collections.sects.insertMany([
      { _id: sectA, worldId: W, name: 'A', tag: 'AAA', leaderFamilyId: famA, leaderId: 'a', memberFamilyCount: 1, allySectIds: [sectB], prosperity: 0, rev: 1 },
      { _id: sectB, worldId: W, name: 'B', tag: 'BBB', leaderFamilyId: famB, leaderId: 'b', memberFamilyCount: 1, allySectIds: [sectA], prosperity: 0, rev: 1 },
    ]);

    const aBase = findBaseCoord(10, 10);
    const bBase = findBaseCoord(60, 10);
    await svc.joinWorld(W, 'a', aBase.x, aBase.y);
    await svc.joinWorld(W, 'b', bBase.x, bBase.y);

    const target = outsideFootprint(bBase); // adjacent to allied-sect b's territory only
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });
  });

  it('capitals check the whole 3×3 footprint: blocked from afar, allowed once bordering the footprint ring', async () => {
    const aBase = findBaseCoord(10, 10);
    const bBase = findBaseCoord(60, 10);
    await svc.joinWorld(W, 'a', aBase.x, aBase.y);
    await svc.joinWorld(W, 'b', bBase.x, bBase.y);
    // Drop b's protection shield so the attack gets past PROTECTED and actually reaches the connectivity gate.
    await m.collections.tiles.updateMany(
      { _id: { $in: baseFootprintCells(bBase.x, bBase.y).map((c) => tileId(W, c.x, c.y)) } },
      { $unset: { protectedUntil: '' } },
    );

    // Attacking the anchor directly from far away is blocked (a's only territory is its own distant base).
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, bBase.x, bBase.y, 'attack', OCCUPY_MIN_TROOPS))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });

    // Border the footprint from outside via the instant test-only occupy, then retry: the connectivity gate
    // now passes (the anchor's own neighbors are its own ring, so this only works because the check resolves
    // to the whole footprint, not just the exact anchor cell).
    const conn = outsideFootprint(bBase);
    await svc.occupyTile(W, 'a', conn.x, conn.y);
    await expect(svc.startMarch(W, 'a', aBase.x, aBase.y, bBase.x, bBase.y, 'attack', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'attack', status: 'marching' });
  });

  it('arrival re-check: losing the connecting tile mid-flight turns a would-be capture into a miss (refund)', async () => {
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);
    const target = findCoord((t) => t.type === 'resource', 60, 60);
    const conn = neighborOf(target);
    await svc.occupyTile(W, 'solo', conn.x, conn.y); // borders the target, clears the departure gate

    const before = (await svc.getMe(W, 'solo')).troops!;
    const mv = await svc.startMarch(W, 'solo', base.x, base.y, target.x, target.y, 'occupy', OCCUPY_MIN_TROOPS);

    // The connecting tile is lost mid-flight (e.g. sieged away) before the march lands.
    await m.collections.tiles.deleteOne({ _id: tileId(W, conn.x, conn.y) });

    nowMs = mv.arriveAt;
    expect(await svc.processDueArrivals()).toBe(1);

    // Treated as a miss: the full march troop count is refunded (the pool returns to its pre-departure value,
    // `before`, which already reflects the connector's permanent GARRISON_PER_TILE deduction), target still neutral.
    expect((await svc.getMe(W, 'solo')).troops).toBe(before);
    expect((await svc.getTile(W, 'solo', target.x, target.y)).mine).toBeUndefined();
  });

  it('incremental frontier growth: a tile 2 hops from the base is reachable once the intervening tile is owned', async () => {
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);

    // hop1 borders the base footprint; hop2 borders hop1 but is NOT itself adjacent to the base footprint —
    // only reachable via the sect's growing frontier, one hop at a time (not a straight line back to the base).
    const hop1 = outsideFootprint(base);
    const hop2 = neighborOf(hop1);
    // Sanity: hop2 must not accidentally also border the base footprint (would make this test vacuous).
    const touchesBase = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(
      ([dx, dy]) => Math.abs(hop2.x + dx - base.x) <= 1 && Math.abs(hop2.y + dy - base.y) <= 1,
    );
    expect(touchesBase).toBe(false);

    // Before owning hop1, hop2 is unreachable (not adjacent to any owned tile).
    await expect(svc.startMarch(W, 'solo', base.x, base.y, hop2.x, hop2.y, 'occupy', OCCUPY_MIN_TROOPS))
      .rejects.toMatchObject({ code: 'TERRITORY_NOT_CONNECTED' });

    await svc.occupyTile(W, 'solo', hop1.x, hop1.y); // claim the intervening tile
    await expect(svc.startMarch(W, 'solo', base.x, base.y, hop2.x, hop2.y, 'occupy', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'occupy', status: 'marching' });
  });

  it('sweep (PvE loot, no capture) is not gated by connectivity — only occupy/attack claim land', async () => {
    const base = findBaseCoord(10, 10);
    await svc.joinWorld(W, 'solo', base.x, base.y);
    const far = findCoord((t) => t.type === 'resource', 60, 60); // far from any owned tile
    await expect(svc.startMarch(W, 'solo', base.x, base.y, far.x, far.y, 'sweep', OCCUPY_MIN_TROOPS))
      .resolves.toMatchObject({ kind: 'sweep', status: 'marching' });
  });
});
