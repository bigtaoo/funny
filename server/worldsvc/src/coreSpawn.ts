// worldsvc core — spawn selection & 3×3 base footprint helpers (ADR-025).
// Peeled out of the WorldCore god-class (2026-07-03). Random/near-family spawn point
// selection plus the footprint build/validate/integrity/purge primitives. No behavior change.
import {
  proceduralTile,
  tileId,
  playerWorldId,
  buildingMaxHp,
  baseFootprintCells,
  baseFootprintInBounds,
  GARRISON_PER_TILE,
  type ResourceType,
} from '@nw/shared';
import { WorldCoreNation } from './coreNation';
import { SPAWN_NEAR_FAMILY_RADIUS, SPAWN_OUTER_MIN_DR } from './coreHelpers';
import type { TileDoc } from './db';

export class WorldCoreSpawn extends WorldCoreNation {
  async pickRandomEmptyTile(
    worldId: string,
    minDr = 0,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { mapW, mapH } = this.deps;
    const cx = mapW / 2;
    const cy = mapH / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(Math.random() * mapW);
      const y = Math.floor(Math.random() * mapH);
      if (minDr > 0) {
        const dx = x - cx;
        const dy = y - cy;
        if (Math.sqrt(dx * dx + dy * dy) / maxDist <= minDr) continue; // too close to the center, skip
      }
      const proc = proceduralTile(worldId, x, y);
      if (
        proc.type === 'center' ||
        proc.type === 'obstacle' ||
        proc.type === 'gate' ||
        proc.type === 'stronghold' // stronghold system strongpoint; cannot be used as a capital respawn location (G8)
      ) {
        continue;
      }
      // ADR-025: a candidate anchor must host the whole 3×3 footprint (in bounds + all 9 cells free).
      if (!(await this.footprintFree(worldId, x, y, mapW, mapH))) continue;
      return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
    }
    return null;
  }

  /**
   * Auto-spawn point selection (§3.4, decided 2026-06-24; system auto-placement on first entry; placement strategy = prefer near family):
   *  1) Has a family → search outward ring by ring (Chebyshev distance) around each family member's capital for the first legal empty tile (radius ≤ SPAWN_NEAR_FAMILY_RADIUS);
   *     member order is randomly shuffled so new players don't always crowd the same member (core SLG clustering mechanic).
   *  2) Fall back to outer newbie ring random (dr > SPAWN_OUTER_MIN_DR, away from the central contest zone).
   *  3) Whole-map random fallback. If none found, return null (treated as world full / no empty tile).
   */
  async pickSpawnTile(
    worldId: string,
    accountId: string,
    familyId?: string,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { cols } = this.deps;
    if (familyId) {
      const mates = await cols.playerWorld.find({ worldId, familyId }).project<{ accountId: string }>({ accountId: 1 }).toArray();
      const mateIds = mates.map((m) => m.accountId).filter((id): id is string => !!id && id !== accountId);
      if (mateIds.length > 0) {
        const bases = await cols.tiles.find({ worldId, type: 'base', ownerId: { $in: mateIds } }).toArray();
        for (const b of this.shuffled(bases)) {
          const spot = await this.spiralFindEmpty(worldId, b.x, b.y, SPAWN_NEAR_FAMILY_RADIUS);
          if (spot) return spot;
        }
      }
    }
    return (await this.pickRandomEmptyTile(worldId, SPAWN_OUTER_MIN_DR)) ?? (await this.pickRandomEmptyTile(worldId));
  }

  /**
   * Starting from (ox,oy), search ring by ring (Chebyshev distance 1..maxR) for the first legal empty tile (in bounds, not center/obstacle/gate/stronghold, unoccupied).
   * Candidates within each ring are randomly shuffled so new family members don't line up in a fixed direction. Used by auto-spawn near family.
   */
  private async spiralFindEmpty(
    worldId: string,
    ox: number,
    oy: number,
    maxR: number,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    for (let r = 1; r <= maxR; r++) {
      const ring: [number, number][] = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // only include tiles on this ring's border
          ring.push([ox + dx, oy + dy]);
        }
      }
      for (const [x, y] of this.shuffled(ring)) {
        if (!this.inBounds(x, y)) continue;
        const proc = proceduralTile(worldId, x, y);
        if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'gate' || proc.type === 'stronghold') {
          continue;
        }
        // ADR-025: the candidate anchor must host the whole 3×3 footprint.
        if (!(await this.footprintFree(worldId, x, y, this.deps.mapW, this.deps.mapH))) continue;
        return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
      }
    }
    return null;
  }

  /** Fisher–Yates shuffle (not a replay path; Math.random is safe). Returns a new array; does not mutate the original. */
  private shuffled<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  // ── Main-base 3×3 footprint helpers (ADR-025) ────────────────────

  /**
   * Build the 9 TileDocs for a base anchored (centered) at (ax,ay). The anchor is a full type:'base' tile
   * (garrison + level + optional resType), the 8 ring cells are type:'base' placeholders (ownerId + protection,
   * baseRing:true, baseAnchor→anchor tileId, level:1, no garrison/resType/yield). All are indivisible (ADR-025).
   */
  baseTileDocs(
    worldId: string,
    ax: number,
    ay: number,
    ownerId: string,
    opts: { garrison?: number; level: number; resType?: ResourceType; protectedUntil?: number; familyId?: string },
  ): TileDoc[] {
    const anchorTid = tileId(worldId, ax, ay);
    const docs: TileDoc[] = [];
    for (const { x, y } of baseFootprintCells(ax, ay)) {
      const isAnchor = x === ax && y === ay;
      if (isAnchor) {
        docs.push({
          _id: anchorTid,
          worldId,
          x,
          y,
          type: 'base',
          level: opts.level,
          ...(opts.resType ? { resType: opts.resType } : {}),
          ownerId,
          ...(opts.familyId ? { familyId: opts.familyId } : {}),
          garrison: opts.garrison ?? GARRISON_PER_TILE,
          // ADR-026: the anchor holds the whole capital's building HP (= level × SLG_BASE_HP_PER_LEVEL).
          hp: buildingMaxHp(opts.level),
          ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
          rev: 0,
        });
      } else {
        docs.push({
          _id: tileId(worldId, x, y),
          worldId,
          x,
          y,
          type: 'base',
          level: 1,
          ownerId,
          ...(opts.familyId ? { familyId: opts.familyId } : {}),
          ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
          baseRing: true,
          baseAnchor: anchorTid,
          rev: 0,
        });
      }
    }
    return docs;
  }

  /**
   * True iff the whole 3×3 block anchored at (ax,ay) can host a base: fully in bounds, no cell is a
   * blocking/reserved procedural type (center/obstacle/gate/stronghold), and no cell is occupied by another
   * player. `ignoreOwnerId` excludes a player's own existing tiles (belt-and-suspenders for relocate).
   */
  async footprintFree(
    worldId: string,
    ax: number,
    ay: number,
    mapW: number,
    mapH: number,
    opts?: { ignoreOwnerId?: string },
  ): Promise<boolean> {
    if (!baseFootprintInBounds(ax, ay, mapW, mapH)) return false;
    const cells = baseFootprintCells(ax, ay);
    for (const { x, y } of cells) {
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'gate' || proc.type === 'stronghold') {
        return false;
      }
    }
    const ids = cells.map(({ x, y }) => tileId(worldId, x, y));
    const existing = await this.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string }>({ ownerId: 1 })
      .toArray();
    for (const e of existing) {
      if (e.ownerId && e.ownerId !== opts?.ignoreOwnerId) return false;
    }
    return true;
  }

  /**
   * ADR-025 data integrity: is the capital anchored at `mainBaseTile` a complete, same-owner 3×3?
   * True iff all 9 footprint cells exist as `type:'base'` owned by `accountId` (anchor + 8 rings).
   * A player created by joinWorld/relocate/passiveRelocate always satisfies this; a stored base that
   * fails it is corrupt or legacy (e.g. a pre-ADR-025 single-tile capital) and must be purged rather
   * than tolerated — the client renders the city sprite only on a full 3×3 anchor.
   */
  async isBaseIntact(worldId: string, accountId: string, mainBaseTile: string): Promise<boolean> {
    const ax = this.coordX(mainBaseTile);
    const ay = this.coordY(mainBaseTile);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
    if (!baseFootprintInBounds(ax, ay, this.deps.mapW, this.deps.mapH)) return false;
    const ids = baseFootprintCells(ax, ay).map(({ x, y }) => tileId(worldId, x, y));
    const cells = await this.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string; type?: string }>({ ownerId: 1, type: 1 })
      .toArray();
    if (cells.length !== ids.length) return false; // some footprint cell missing
    return cells.every((c) => c.type === 'base' && c.ownerId === accountId);
  }

  /**
   * Wipe a player's entire presence in a world: all owned tiles (capital + territory) + the
   * playerWorld doc. Used to discard a corrupt/legacy capital so the next joinWorld re-places the
   * player as a brand-new user with a proper 3×3 (ADR-025). Marches/sieges are left to expire
   * naturally (they reference tiles by id and no-op once the tiles are gone).
   */
  async purgePlayerWorld(worldId: string, accountId: string): Promise<void> {
    await this.deps.cols.tiles.deleteMany({ worldId, ownerId: accountId });
    await this.deps.cols.playerWorld.deleteOne({ _id: playerWorldId(worldId, accountId) });
  }
}
