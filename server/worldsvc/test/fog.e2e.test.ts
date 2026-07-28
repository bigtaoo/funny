// worldsvc vision/fog end-to-end (G5-1, §8.2 / §15.2 G5): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Fog model 2b (2026-07-24): the STATIC structure layer (location / ownership / base identity / level / occupation)
//   is public map-wide — a player can always see WHERE others are. Fog now gates only the INTEL fields
//   (garrison / hp / maxHp / watchtower) and marching troops (getMarches). Out-of-vision tiles keep visible:true
//   but have their intel fields stripped (coreMap.gateIntel).
//   Vision sources = own territories/home base + same-family member territories (shared) + marches in transit. getMap / getTile use the same gate.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  baseFootprintCells,
  baseFootprintInBounds,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_BASE_RADIUS,
  VISION_MARCH_RADIUS,
  type FamilyRole,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_fog_test';
const W = 's1-fog';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.fog.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

/**
 * In-process fake of socialsvc's family store (P4 follow-up: family identity/roster now live there, not in worldsvc).
 * Family-shared vision resolves members via PlayerWorldDoc.familyId (mirrored on joinWorld from getFamilyId), so tests
 * register membership here before calling joinWorld.
 */
class FakeSocialsvc implements WorldSocialsvcClient {
  available = true;
  private families = new Map<string, FamilySummary & { activity: number }>();
  private memberRole = new Map<string, { familyId: string; role: FamilyRole }>();

  addFamily(familyId: string, leaderId: string, name: string, tag: string): string {
    this.families.set(familyId, {
      familyId, name, tag: tag.toUpperCase(), leaderId, memberCount: 1,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0,
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
    const m = this.memberRole.get(accountId);
    if (!m) return null;
    const f = this.families.get(m.familyId);
    if (!f) return null;
    return { familyId: m.familyId, role: m.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount, ...(f.sectId ? { sectId: f.sectId } : {}) };
  }

  async getFamiliesByIds(familyIds: string[]): Promise<FamilySummary[]> {
    return familyIds.map((id) => this.families.get(id)).filter((f): f is FamilySummary & { activity: number } => !!f)
      .map((f) => ({ ...f }));
  }

  async getFamiliesBySect(sid: string): Promise<FamilySummary[]> {
    return [...this.families.values()].filter((f) => f.sectId === sid).map((f) => ({ ...f }));
  }

  async setSect(familyId: string, sid: string | null): Promise<void> {
    const f = this.families.get(familyId);
    if (!f) return;
    if (sid) f.sectId = sid;
    else delete f.sectId;
  }

  async bumpActivity(familyId: string, delta: number): Promise<void> {
    const f = this.families.get(familyId);
    if (f) f.activity += delta;
  }

  async refreshProsperity(): Promise<number> { return 0; }
  async bumpActivityAndProsperity(familyId: string, delta: number): Promise<number> {
    const f = this.families.get(familyId);
    if (f) f.activity += delta;
    return 0;
  }
  async resetSlgState(): Promise<void> { /* not exercised here */ }
  async push(_channel: SocialsvcChannel, _event: string, _payload: unknown, _targets?: string[]): Promise<void> {
    /* not exercised here */
  }
}

const CENTER_X = Math.floor(SLG_MAP_W / 2);
const CENTER_Y = Math.floor(SLG_MAP_H / 2);

/** Spirally search around (sx,sy) for a tile satisfying predicate (deterministic). */
function findCoord(
  predicate: (t: ReturnType<typeof proceduralTile>) => boolean,
  sx: number,
  sy: number,
): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
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
// ADR-032 follow-up: resourceDensity=1.0 means 'neutral' tiles no longer occur; any occupiable land is 'resource'.
const NEUTRAL = (t: ReturnType<typeof proceduralTile>) => t.type === 'resource' || t.type === 'neutral';

/**
 * ADR-039 territory connectivity: give `accountId` an owned tile bordering `target` via the instant/test-only
 * occupyTile so a march to a far-away target clears the new gate.
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

/** Spiral-search for a spawnable 3×3 base anchor near (sx,sy): whole footprint in-bounds + free of center/obstacle/gate/stronghold (mirrors joinWorld's footprintFree). */
function findBaseCoord(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 80; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
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

describe.skipIf(!mongo)('worldsvc fog/vision e2e (G5)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({ cols: m.collections, redis: null, socialsvc, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('within vision: own home base structure + intel (garrison/HP) visible (visible:true + mine + type:base + maxHp)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const view = await svc.getMap(W, 'a', 5, 5, 2);
    const base = view.tiles.find((t) => t.x === 5 && t.y === 5)!;
    expect(base).toMatchObject({ type: 'base', mine: true, occupied: true, visible: true });
    expect(base.maxHp).toBeGreaterThan(0); // own base is in vision → HP intel present
    // Surrounding tiles (within base vision radius) are also visible:true.
    expect(view.tiles.every((t) => t.visible === true)).toBe(true);
  });

  it('outside vision (model 2b): enemy STRUCTURE is public (type:base + occupied), only INTEL (garrison/HP/watchtower) is hidden', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Enemy e settles at (200,200), far beyond a's base vision radius.
    await svc.joinWorld(W, 'e', 200, 200);

    const view = await svc.getMap(W, 'a', 200, 200, 2);
    const enemyBase = view.tiles.find((t) => t.x === 200 && t.y === 200)!;
    // Structure/ownership is public map-wide now — a player can always see WHERE others are.
    expect(enemyBase).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(enemyBase.mine).toBeUndefined();
    // But intel stays fog-gated: garrison / HP / watchtower are stripped outside vision.
    expect(enemyBase.garrison).toBeUndefined();
    expect(enemyBase.hp).toBeUndefined();
    expect(enemyBase.maxHp).toBeUndefined();
    expect(enemyBase.watchtower).toBeUndefined();
  });

  it('getTile same gate: enemy tile outside vision → structure public (base/occupied), intel (HP) hidden', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 200, 200);
    const tile = await svc.getTile(W, 'a', 200, 200);
    expect(tile).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(tile.mine).toBeUndefined();
    expect(tile.maxHp).toBeUndefined();   // intel fogged
    expect(tile.garrison).toBeUndefined();
  });

  it('regression (zoom consistency): an out-of-vision enemy base appears in BOTH getMap (L1) and getMapSparse (L2/L3) — no more "bases vanish when zooming in"', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 200, 200); // far beyond a's vision

    // L2/L3 bird's-eye (sparse, skips vision): e's base is listed as an occupied tile.
    for (const lod of ['mid', 'thin'] as const) {
      const sparse = await svc.getMapSparse(W, 'a', 200, 200, 5, lod);
      const eSparse = sparse.tiles.find((t) => t.x === 200 && t.y === 200);
      expect(eSparse, `sparse(${lod}) should list e's base`).toBeDefined();
      expect(eSparse!.type).toBe('base');
      expect(eSparse!.mine).toBeUndefined();
    }

    // L1 detail (getMap): the SAME base is present — the original bug was that fog hid it here,
    // so the client's city layer drew nothing when zoomed in even though L2/L3 showed it.
    const detail = await svc.getMap(W, 'a', 200, 200, 5);
    const eDetail = detail.tiles.find((t) => t.x === 200 && t.y === 200)!;
    expect(eDetail).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(eDetail.mine).toBeUndefined();

    // Every one of the 3×3 footprint cells comes back as an owned base tile, so the client's
    // isBaseAnchor (center + 4 orthogonal neighbours all base + same owner) succeeds and renders
    // the city sprite — the concrete precondition that used to fail under fog model 2a.
    const byKey = new Map(detail.tiles.map((t) => [`${t.x}:${t.y}`, t]));
    for (const c of baseFootprintCells(200, 200)) {
      const cell = byKey.get(`${c.x}:${c.y}`)!;
      expect(cell.type, `footprint cell (${c.x},${c.y})`).toBe('base');
      expect(cell.occupied).toBe(true);
    }
  });

  it('family shared vision: distant territory of a same-family member is visible to me (occupied but not mine)', async () => {
    // a and mate are in the same family: register membership in socialsvc first so joinWorld mirrors familyId onto
    // each PlayerWorldDoc (computeVisionSources / familyMemberIds resolve members from playerWorld.familyId).
    const fam = 'fam-1';
    socialsvc.addFamily(fam, 'a', 'Fam', 'FM');
    socialsvc.addMember('mate', fam);
    const matePos = findBaseCoord(400, 400); // distant, beyond a's base vision range
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'mate', matePos.x, matePos.y);

    const view = await svc.getMap(W, 'a', matePos.x, matePos.y, 2);
    const mateBase = view.tiles.find((t) => t.x === matePos.x && t.y === matePos.y)!;
    expect(mateBase).toMatchObject({ type: 'base', occupied: true, visible: true, ally: true });
    expect(mateBase.mine).toBeUndefined(); // belongs to ally, not me (ally=true tells the client to use ally color instead of enemy color)

    // Control: to non-family e, mate's base structure is still public (occupied, not ally), but its intel stays fogged.
    const ePos = findBaseCoord(280, 280);
    await svc.joinWorld(W, 'e', ePos.x, ePos.y);
    const v2 = await svc.getMap(W, 'e', matePos.x, matePos.y, 2); // from e's perspective, mate's base
    const mateFromE = v2.tiles.find((t) => t.x === matePos.x && t.y === matePos.y)!;
    expect(mateFromE).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(mateFromE.ally).toBeUndefined();  // e is not in mate's family → no friendly tag
    expect(mateFromE.maxHp).toBeUndefined(); // intel still fogged from e's perspective
  });

  it('march in transit illuminates intel: an enemy base within the marching column\'s vision reveals its HP even outside base vision', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const ePos = findBaseCoord(5, 60); // distant enemy base, well beyond a's base vision radius
    expect(ePos.y).toBeGreaterThan(5 + VISION_BASE_RADIUS);
    await svc.joinWorld(W, 'e', ePos.x, ePos.y);

    // Baseline: e's base structure is public to a, but its HP intel is fogged (no vision on it yet).
    const before = await svc.getMap(W, 'a', ePos.x, ePos.y, 2);
    const eBefore = before.tiles.find((t) => t.x === ePos.x && t.y === ePos.y)!;
    expect(eBefore).toMatchObject({ type: 'base', occupied: true, visible: true });
    expect(eBefore.maxHp).toBeUndefined();

    // March a column to a neutral tile bordering e's base (within VISION_MARCH_RADIUS of the anchor).
    const dst = findCoord(NEUTRAL, ePos.x, ePos.y + 2); // ~Chebyshev 2 below the anchor → its arrival vision covers e's base
    expect(Math.max(Math.abs(dst.x - ePos.x), Math.abs(dst.y - ePos.y))).toBeLessThanOrEqual(VISION_MARCH_RADIUS);
    await connect(svc, 'a', dst); // ADR-039: border the target before marching
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', 500);

    // Advance to just before arrival: the column sits on dst, whose march vision now covers e's base.
    nowMs = mv.arriveAt - 1;
    const after = await svc.getMap(W, 'a', ePos.x, ePos.y, 2);
    const eAfter = after.tiles.find((t) => t.x === ePos.x && t.y === ePos.y)!;
    expect(eAfter.maxHp).toBeGreaterThan(0); // march vision reveals the HP intel
  });
});
