// worldsvc vision/fog end-to-end (G5-1, §8.2 / §15.2 G5): real Mongo. Entire suite skipped if Mongo is unreachable.
//   Fog model 2a: terrain layer visible across the whole map; dynamic layer (ownership/garrison/shield) only visible within
//   current vision; falls back to procedural terrain outside vision.
//   Vision sources = own territories/home base + same-family member territories (shared) + marches in transit. getMap / getTile use the same gate.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  proceduralTile,
  tileId,
  SLG_MAP_W,
  SLG_MAP_H,
  VISION_BASE_RADIUS,
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
    return { familyId: m.familyId, role: m.role, leaderId: f.leaderId, name: f.name, tag: f.tag, memberCount: f.memberCount };
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

  it('within vision: own home base and surrounding dynamic layer visible (visible:true + mine + type:base)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    const view = await svc.getMap(W, 'a', 5, 5, 2);
    const base = view.tiles.find((t) => t.x === 5 && t.y === 5)!;
    expect(base).toMatchObject({ type: 'base', mine: true, occupied: true, visible: true });
    // Surrounding tiles (within base vision radius) are also visible:true.
    expect(view.tiles.every((t) => t.visible === true)).toBe(true);
  });

  it('outside vision: distant enemy territory fully hidden (visible:false + falls back to procedural terrain, no owner/occupied)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // Enemy e settles at (200,200), far beyond a's base vision radius.
    await svc.joinWorld(W, 'e', 200, 200);

    const view = await svc.getMap(W, 'a', 200, 200, 2);
    const enemyBase = view.tiles.find((t) => t.x === 200 && t.y === 200)!;
    // Key: enemy home base is outside vision → "occupied" status not exposed; type falls back to procedural base (not 'base'/'territory').
    const proc = proceduralTile(W, 200, 200);
    expect(enemyBase.visible).toBe(false);
    expect(enemyBase.type).toBe(proc.type);
    expect(enemyBase.occupied).toBeUndefined();
    expect(enemyBase.mine).toBeUndefined();
    expect(enemyBase.ownerPublicId).toBeUndefined();
    expect(enemyBase.garrison).toBeUndefined();
    // But the terrain layer (type/level) is still returned as-is (model 2a: terrain is not a secret).
    expect(enemyBase.level).toBe(proc.level);
  });

  it('getTile same gate: enemy tile outside vision also returns only procedural terrain (prevents getMap bypass)', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'e', 200, 200);
    const tile = await svc.getTile(W, 'a', 200, 200);
    expect(tile.visible).toBe(false);
    expect(tile.mine).toBeUndefined();
    expect(tile.occupied).toBeUndefined();
    expect(tile.type).toBe(proceduralTile(W, 200, 200).type);
  });

  it('family shared vision: distant territory of a same-family member is visible to me (occupied but not mine)', async () => {
    // a and mate are in the same family: register membership in socialsvc first so joinWorld mirrors familyId onto
    // each PlayerWorldDoc (computeVisionSources / familyMemberIds resolve members from playerWorld.familyId).
    const fam = 'fam-1';
    socialsvc.addFamily(fam, 'a', 'Fam', 'FM');
    socialsvc.addMember('mate', fam);
    await svc.joinWorld(W, 'a', 5, 5);
    await svc.joinWorld(W, 'mate', 400, 400); // distant, beyond a's base vision range

    const view = await svc.getMap(W, 'a', 400, 400, 2);
    const mateBase = view.tiles.find((t) => t.x === 400 && t.y === 400)!;
    expect(mateBase).toMatchObject({ type: 'base', occupied: true, visible: true, ally: true });
    expect(mateBase.mine).toBeUndefined(); // belongs to ally, not me (ally=true tells the client to use ally color instead of enemy color)

    // Control: non-family e (distant) is still fogged.
    await svc.joinWorld(W, 'e', 280, 280);
    const v2 = await svc.getMap(W, 'e', 400, 400, 2); // from e's perspective, mate's base → fog
    expect(v2.tiles.find((t) => t.x === 400 && t.y === 400)!.visible).toBe(false);
  });

  it('march in transit illuminates path: tiles near the mid-march position are visible even outside base vision', async () => {
    await svc.joinWorld(W, 'a', 5, 5);
    // March south to a distant neutral tile (outside base vision radius).
    const dst = findCoord(NEUTRAL, 5, 40);
    const mv = await svc.startMarch(W, 'a', 5, 5, dst.x, dst.y, 'occupy', 500);

    // Advance to the midpoint of the march: interpolated position is far from the base (y well beyond 5+VISION_BASE_RADIUS).
    nowMs = Math.floor((mv.departAt + mv.arriveAt) / 2);
    const midY = Math.round(5 + (dst.y - 5) * 0.5);
    expect(midY).toBeGreaterThan(5 + VISION_BASE_RADIUS); // confirm it is truly outside base vision

    const view = await svc.getMap(W, 'a', dst.x, midY, 1);
    const here = view.tiles.find((t) => t.x === dst.x && t.y === midY)!;
    expect(here.visible).toBe(true); // march vision illuminates the tile

    // Control: tiles outside march vision radius and outside base vision remain fogged.
    const far = await svc.getMap(W, 'a', dst.x, midY + 20, 1);
    expect(far.tiles.find((t) => t.x === dst.x && t.y === midY + 20)!.visible).toBe(false);
    void (mv as { marchId: string });
  });
});
