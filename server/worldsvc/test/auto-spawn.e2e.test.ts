// worldsvc auto-spawn (§3.4, 2026-06-24) end-to-end: uses a dedicated real Mongo database. Entire suite skips if Mongo is unreachable.
//   First join without coordinates → system auto-spawns: ① no family → spawns in outer-ring novice zone (dr > 0.6) ② has family → spawns
//   near a family member's main base (Chebyshev ≤ SPAWN_NEAR_FAMILY_RADIUS) ③ spawn point is always a valid base tile, avoiding occupied tiles.
//   Manual-coordinate path (internal/test) still works (covered by existing service.e2e tests).
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proceduralTile, tileId, SLG_MAP_W, SLG_MAP_H, type FamilyRole } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldSocialsvcClient, SocialsvcChannel, FamilyMembership, FamilySummary } from '../src/socialsvcClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_autospawn_test';
const W = 's1-autospawn';

// Keep in sync with private constants in service.ts (update here when changing them there).
const SPAWN_NEAR_FAMILY_RADIUS = 6;
const SPAWN_OUTER_MIN_DR = 0.6;

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.autospawn.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

/**
 * In-process fake of socialsvc's family store (P4 follow-up: family identity/roster now live there, not in worldsvc).
 * Auto-spawn-near-family resolves members via PlayerWorldDoc.familyId (mirrored on joinWorld from getFamilyId), so
 * tests register membership here before calling joinWorld for each member.
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
const MAX_DIST = Math.sqrt((SLG_MAP_W / 2) ** 2 + (SLG_MAP_H / 2) ** 2);

/** Normalized distance from the center (0 = center .. 1 = corner), matching the dr convention used inside proceduralTile. */
function dr(x: number, y: number): number {
  const dx = x - SLG_MAP_W / 2;
  const dy = y - SLG_MAP_H / 2;
  return Math.sqrt(dx * dx + dy * dy) / MAX_DIST;
}

function parseTile(mainBaseTile: string): { x: number; y: number } {
  const parts = mainBaseTile.split(':');
  return { x: Number(parts[parts.length - 2]), y: Number(parts[parts.length - 1]) };
}

/** Spirals outward from (sx, sy) to find a placeable valid tile (neutral/resource) for seeding a family member's main base. */
function findPlaceable(sx: number, sy: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) continue;
        if (x === CENTER_X && y === CENTER_Y) continue;
        const t = proceduralTile(W, x, y).type;
        if (t === 'neutral' || t === 'resource') return { x, y };
      }
    }
  }
  throw new Error('no placeable tile');
}

describe.skipIf(!mongo)('worldsvc auto-spawn e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  let svc: WorldService;
  let socialsvc: FakeSocialsvc;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    socialsvc = new FakeSocialsvc();
    svc = new WorldService({
      cols: m.collections,
      redis: null,
      socialsvc,
      mapW: SLG_MAP_W,
      mapH: SLG_MAP_H,
      now: () => nowMs,
    });
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('no family, first join: no coordinates → auto-spawns in outer-ring novice zone (valid base tile, dr > threshold)', async () => {
    const me = await svc.joinWorld(W, 'solo'); // no coordinates passed
    expect(me.joined).toBe(true);
    expect(me.mainBaseTile).toBeTruthy();

    const { x, y } = parseTile(me.mainBaseTile!);
    // Spawn point is valid: not the center, not an obstacle/gate/stronghold tile.
    expect(x === CENTER_X && y === CENTER_Y).toBe(false);
    expect(['center', 'obstacle', 'gate', 'stronghold']).not.toContain(proceduralTile(W, x, y).type);
    // Spawned in outer-ring novice zone (far from the contested center).
    expect(dr(x, y)).toBeGreaterThan(SPAWN_OUTER_MIN_DR);

    // The tile is actually written as a base and belongs to the player.
    const tile = await svc.getTile(W, 'solo', x, y);
    expect(tile).toMatchObject({ type: 'base', mine: true });
  });

  it('has family, first join: auto-spawns near a family member\'s main base (Chebyshev ≤ radius), no overlap', async () => {
    // Put both players in the same family (registered in socialsvc, bypassing family business logic — testing spawn
    // placement only). joinWorld mirrors familyId onto each PlayerWorldDoc, which pickSpawnTile reads to find mates.
    const familyId = `f:${W}:FAM`;
    socialsvc.addFamily(familyId, 'mate', 'FAM', 'FM');
    socialsvc.addMember('newbie', familyId);

    // Place an existing family member's main base at an explicit coordinate to simulate a pre-existing member.
    const mateSpot = findPlaceable(110, 110); // in-bounds interior spot away from the contested center (150,150)
    await svc.joinWorld(W, 'mate', mateSpot.x, mateSpot.y);

    const me = await svc.joinWorld(W, 'newbie'); // no coordinates passed
    expect(me.joined).toBe(true);
    const { x, y } = parseTile(me.mainBaseTile!);

    // Spawned within SPAWN_NEAR_FAMILY_RADIUS Chebyshev ring around the member's main base.
    const cheb = Math.max(Math.abs(x - mateSpot.x), Math.abs(y - mateSpot.y));
    expect(cheb).toBeGreaterThanOrEqual(1); // does not overlap the member's main base
    expect(cheb).toBeLessThanOrEqual(SPAWN_NEAR_FAMILY_RADIUS);

    // The two main bases occupy different tiles.
    expect(tileId(W, x, y)).not.toBe(tileId(W, mateSpot.x, mateSpot.y));
  });

  it('auto-spawn avoids occupied tiles: a member\'s main base tile is never overwritten by a newcomer', async () => {
    const familyId = `f:${W}:FAM2`;
    socialsvc.addFamily(familyId, 'mate', 'FAM2', 'F2');
    socialsvc.addMember('newbie', familyId);

    const mateSpot = findPlaceable(120, 120); // in-bounds interior spot away from the contested center (150,150)
    await svc.joinWorld(W, 'mate', mateSpot.x, mateSpot.y);

    const me = await svc.joinWorld(W, 'newbie');
    const { x, y } = parseTile(me.mainBaseTile!);
    // Newcomer's main base and member's main base have different owners and occupy different tiles.
    const mateTile = await m.collections.tiles.findOne({ _id: tileId(W, mateSpot.x, mateSpot.y) });
    expect(mateTile?.ownerId).toBe('mate');
    const newbieTile = await m.collections.tiles.findOne({ _id: tileId(W, x, y) });
    expect(newbieTile?.ownerId).toBe('newbie');
  });

  it('idempotent: joining again without coordinates after already spawned does not re-spawn', async () => {
    const first = await svc.joinWorld(W, 'solo');
    const base1 = first.mainBaseTile;
    const second = await svc.joinWorld(W, 'solo');
    expect(second.mainBaseTile).toBe(base1);
    expect(second.territoryCount).toBe(9); // ADR-025: a capital is a 3×3 footprint (anchor + 8 ring tiles)
  });
});
