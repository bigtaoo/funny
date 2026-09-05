// worldsvc core — spawn selection & 3×3 base footprint helpers (ADR-025).
// Peeled out of the WorldCore god-class (2026-07-03). Random/near-family spawn point
// selection plus the footprint build/validate/integrity/purge primitives. No behavior change.
//
// 2026-08-11 (mixin-chain re-audit, claudedocs/server.md "拆分形态的优先级" 形态②): converted from an
// `extends WorldCoreNation` inheritance-chain link to composition — cross-layer calls are all to the
// kernel primitives (`inBounds`/`coordX`/`coordY`), so this takes a narrow constructor-injected
// `core: WorldCore`.
import {
  proceduralTile,
  tileId,
  playerWorldId,
  buildingMaxHp,
  baseDurabilityMax,
  baseFootprintCells,
  baseFootprintInBounds,
  GARRISON_PER_TILE,
  isCityGroundTile,
  type ResourceType,
  type TileType,
} from '@nw/shared';
import type { WorldCore } from '../core';
import { SPAWN_NEAR_FAMILY_RADIUS, SPAWN_OUTER_MIN_DR } from './helpers';
import type { TileDoc } from '../db';

/**
 * Terrain a player capital's 3×3 footprint may never cover. Four call sites in this file used to spell
 * this list out inline, which is exactly how `familyKeep` came to be missing from all four: before
 * ADR-074 a city was a single `familyKeep` cell, so a base could spawn right on top of a city anchor —
 * and once ADR-074 widened city ground to the whole footprint that hole would have grown from 1 cell per
 * city to up to 81. One predicate, so a future tile type cannot be added to three of four lists.
 *
 * `isCityGroundTile` covers `familyKeep` AND `center`, which is why 'center' is no longer named here.
 */
function isReservedBaseTerrain(type: TileType): boolean {
  return isCityGroundTile(type)
    || type === 'obstacle'
    || type === 'bridge'
    || type === 'plankway'
    || type === 'stronghold'; // stronghold system strongpoint; cannot be used as a capital respawn location (G8)
}

export class SpawnService {
  constructor(private readonly core: WorldCore) {}

  /** Injected uniform [0,1) source (WorldServiceDeps.rng), falling back to Math.random. See that field's doc. */
  private get rnd(): () => number {
    return this.core.deps.rng ?? Math.random;
  }

  async pickRandomEmptyTile(
    worldId: string,
    minDr = 0,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { mapW, mapH } = this.core.deps;
    const cx = mapW / 2;
    const cy = mapH / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(this.rnd() * mapW);
      const y = Math.floor(this.rnd() * mapH);
      if (minDr > 0) {
        const dx = x - cx;
        const dy = y - cy;
        if (Math.sqrt(dx * dx + dy * dy) / maxDist <= minDr) continue; // too close to the center, skip
      }
      const proc = proceduralTile(worldId, x, y);
      if (isReservedBaseTerrain(proc.type)) continue;
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
    const { cols } = this.core.deps;
    if (familyId) {
      const mates = await cols.playerWorld.find({ worldId, familyId }).project<{ accountId: string }>({ accountId: 1 }).toArray();
      const mateIds = mates.map((m) => m.accountId).filter((id): id is string => !!id && id !== accountId);
      if (mateIds.length > 0) {
        // 2026-08-03 (worldsvc code review): `type:'base'` alone also matches the 8 non-anchor ring
        // cells every capital's 3x3 footprint writes (baseTileDocs above, `baseRing: true`) — without
        // excluding them, this queries and iterates 9 "capitals" per family member instead of 1, each
        // spiralFindEmpty search centered on a ring cell rather than the true anchor.
        const bases = await cols.tiles.find({ worldId, type: 'base', ownerId: { $in: mateIds }, baseRing: { $ne: true } }).toArray();
        for (const b of this.shuffled(bases)) {
          const spot = await this.spiralFindEmpty(worldId, b.x, b.y, SPAWN_NEAR_FAMILY_RADIUS);
          if (spot) return spot;
        }
      }
    }
    return (await this.pickRandomEmptyTile(worldId, SPAWN_OUTER_MIN_DR)) ?? (await this.pickRandomEmptyTile(worldId));
  }

  /**
   * Starting from (ox,oy), search ring by ring (Chebyshev distance 1..maxR) for the first legal empty tile (in bounds, not reserved terrain per {@link isReservedBaseTerrain}, unoccupied).
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
        if (!this.core.inBounds(x, y)) continue;
        const proc = proceduralTile(worldId, x, y);
        if (isReservedBaseTerrain(proc.type)) {
          continue;
        }
        // ADR-025: the candidate anchor must host the whole 3×3 footprint.
        if (!(await this.footprintFree(worldId, x, y, this.core.deps.mapW, this.core.deps.mapH))) continue;
        return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
      }
    }
    return null;
  }

  /** Fisher–Yates shuffle (not a replay path; the injected rng — Math.random by default — is safe). Returns a new array; does not mutate the original. */
  private shuffled<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
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
    opts: {
      garrison?: number;
      level: number;
      resType?: ResourceType;
      protectedUntil?: number;
      familyId?: string;
      /** D-CITY-8: account's current `wall` building level, drives the anchor's durabilityMax. Defaults to 0 (no wall). */
      wallLevel?: number;
      /** D-CITY-8: current durability to carry over (e.g. voluntary relocate keeps damage taken); defaults to full. */
      durability?: number;
      /** D-CITY-8: regen anchor timestamp to carry over alongside `durability`; defaults to `now` (caller-supplied). */
      durabilityRegenAt?: number;
      now: number;
    },
  ): TileDoc[] {
    const anchorTid = tileId(worldId, ax, ay);
    const durabilityMax = baseDurabilityMax(opts.wallLevel ?? 0);
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
          // Uniformly present even though a base anchor never heals (liveGarrison excludes type 'base' —
          // the capital defends with in-base teams, ADR-026 §2), so no tile this factory writes is missing
          // the checkpoint and readable as "healed long ago".
          garrisonRegenAt: opts.now,
          // ADR-026: the anchor holds the whole capital's building HP (= level × SLG_BASE_HP_PER_LEVEL).
          hp: buildingMaxHp(opts.level),
          // D-CITY-8: the anchor's durability, capped by the wall-level-derived durabilityMax (replaces hp for base sieges).
          durability: Math.min(opts.durability ?? durabilityMax, durabilityMax),
          durabilityMax,
          durabilityRegenAt: opts.durabilityRegenAt ?? opts.now,
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
   * blocking/reserved procedural type (center/obstacle/bridge/plankway/stronghold), and no cell is occupied by another
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
      if (isReservedBaseTerrain(proc.type)) {
        return false;
      }
    }
    const ids = cells.map(({ x, y }) => tileId(worldId, x, y));
    const existing = await this.core.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string }>({ ownerId: 1 })
      .toArray();
    for (const e of existing) {
      if (e.ownerId && e.ownerId !== opts?.ignoreOwnerId) return false;
    }
    return true;
  }

  /**
   * True iff EVERY cell of the 3×3 block anchored at (ax,ay) is currently owned by `ownerId` (block fully in
   * bounds, no reserved/blocking procedural terrain). This is the relocate gate (§3.4): the capital may only
   * move onto a 3×3 the player already fully holds — a cell that is unowned, neutral, or owned by anyone else
   * disqualifies the block. Note it is the inverse of `footprintFree` (which wants the block *empty*).
   */
  async footprintOwnedBy(worldId: string, ax: number, ay: number, mapW: number, mapH: number, ownerId: string): Promise<boolean> {
    if (!baseFootprintInBounds(ax, ay, mapW, mapH)) return false;
    const cells = baseFootprintCells(ax, ay);
    for (const { x, y } of cells) {
      const proc = proceduralTile(worldId, x, y);
      if (isReservedBaseTerrain(proc.type)) {
        return false;
      }
    }
    const ids = cells.map(({ x, y }) => tileId(worldId, x, y));
    const existing = await this.core.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string }>({ ownerId: 1 })
      .toArray();
    if (existing.length < cells.length) return false; // a cell with no tile doc is unowned
    for (const e of existing) {
      if (e.ownerId !== ownerId) return false;
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
    const ax = this.core.coordX(mainBaseTile);
    const ay = this.core.coordY(mainBaseTile);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
    if (!baseFootprintInBounds(ax, ay, this.core.deps.mapW, this.core.deps.mapH)) return false;
    const ids = baseFootprintCells(ax, ay).map(({ x, y }) => tileId(worldId, x, y));
    const cells = await this.core.deps.cols.tiles
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
    await this.core.deps.cols.tiles.deleteMany({ worldId, ownerId: accountId });
    await this.core.deps.cols.playerWorld.deleteOne({ _id: playerWorldId(worldId, accountId) });
  }
}
