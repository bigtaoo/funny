// worldsvc core — scheduling infra & real-time push (WorldCore split, 2026-07-03).
// Best-effort Redis ZSETs for precise march/siege-damage wake-ups (Mongo scan stays
// authoritative) plus the gateway push helpers. No behavior change.
import { baseFootprintCells, tileId } from '@nw/shared';
import { WorldCoreYield } from './coreYield';
import type { MarchView } from './worldTypes';
import type { SiegeDoc, TileDoc } from './db';

/**
 * ADR-051: one entry in the field-unit occupancy index (`world:{worldId}:occ`, field=tileId). Describes the unit
 * currently standing on a tile so the P2 tile-entry encounter check can identify friend/foe by O(1) lookup.
 * `kind` distinguishes a moving march (P1) from a parked stationed team (P2). `id` is the match key used by
 * clearOccupancy so a unit never deletes another's entry: the marchId for a march, the tileId for a stationed
 * team. `leaveAt` = when a moving march vacates the tile (reaches the next path cell); MAX_SAFE_INTEGER for a
 * parked/stationed unit or a march's final cell.
 */
export interface OccEntry {
  kind: 'march' | 'stationed';
  id: string;
  ownerId: string;
  familyId?: string;
  teamId?: string;
  tile: string;
  leaveAt: number;
}

/**
 * ADR-051 (P3a): one entry in the coverage reverse index (`world:{worldId}:cover`, field=coveredTileId → JSON map
 * of sourceTile→CoverEntry). Describes a garrison team (P3) or arrow tower (P5) whose 3×3 footprint covers this
 * cell, so the P3b interception check answers "who covers this cell?" in O(1). `sourceTile` is the covering unit's
 * own (center) tile — the map key, and the handle used to remove all 9 of its footprint entries on recall/destroy.
 */
export interface CoverEntry {
  kind: 'garrison' | 'tower';
  sourceTile: string;
  ownerId: string;
  familyId?: string;
  teamId?: string;
}

export class WorldCorePush extends WorldCoreYield {
  // ── Redis scheduling (best-effort, §14.4 `world:{worldId}:march` ZSET, score=arriveAt) ──
  // Processing uses the Mongo arriveAt scan as authoritative; the ZSET is only for future precise wake-ups; silently skipped when Redis is absent.
  private marchZsetKey(worldId: string): string {
    return `world:${worldId}:march`;
  }
  async scheduleMarch(worldId: string, mid: string, arriveAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.marchZsetKey(worldId), arriveAt, mid);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo scan still processes arrivals */
    }
  }
  async unscheduleMarch(worldId: string, mid: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.marchZsetKey(worldId), mid);
    } catch {
      /* best-effort */
    }
  }

  // ── ADR-026: delayed building-HP settlement scheduling (best-effort ZSET, score=dueAt; Mongo dueAt scan is authoritative) ──
  private siegeDamageZsetKey(worldId: string): string {
    return `world:${worldId}:siegeDamage`;
  }
  async scheduleSiegeDamage(worldId: string, id: string, dueAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.siegeDamageZsetKey(worldId), dueAt, id);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo dueAt scan still settles the hit */
    }
  }
  async unscheduleSiegeDamage(worldId: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.siegeDamageZsetKey(worldId), id);
    } catch {
      /* best-effort */
    }
  }

  // ── ADR-037 (§5.4): occupation-hold settlement scheduling (best-effort ZSET, score=dueAt; Mongo dueAt scan is authoritative) ──
  private occupationZsetKey(worldId: string): string {
    return `world:${worldId}:occupation`;
  }
  async scheduleOccupation(worldId: string, id: string, dueAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.occupationZsetKey(worldId), dueAt, id);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo dueAt scan still settles the hold */
    }
  }
  async unscheduleOccupation(worldId: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.occupationZsetKey(worldId), id);
    } catch {
      /* best-effort */
    }
  }

  // ── ADR-051 (P1): field-unit occupancy index (best-effort Redis hash, field=tileId → occupant JSON) ──
  // Records which field unit currently stands on each tile so the P2 tile-entry encounter check is an O(1)
  // lookup by tile (no Mongo scan). Best-effort like the ZSETs — a missing/failed Redis only disables the
  // future real-time encounter feature; arrival correctness stays on the authoritative Mongo scan. Written as
  // a march steps tile-to-tile (setOccupancy) and cleared on arrival/recall (clearOccupancy, match-guarded so a
  // unit never deletes another unit's entry after a hand-off on the same tile).
  private occKey(worldId: string): string {
    return `world:${worldId}:occ`;
  }
  async setOccupancy(worldId: string, tile: string, occ: OccEntry): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.hset(this.occKey(worldId), tile, JSON.stringify(occ));
    } catch {
      /* best-effort: a lost write only weakens the encounter index, never arrival */
    }
  }
  async clearOccupancy(worldId: string, tile: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      const cur = await this.deps.redis.hget(this.occKey(worldId), tile);
      if (!cur) return;
      const e = JSON.parse(cur) as OccEntry;
      // Only clear if we still hold the tile — another unit may have taken it since (encounter hand-off, P2).
      if (e.id === id) await this.deps.redis.hdel(this.occKey(worldId), tile);
    } catch {
      /* best-effort */
    }
  }
  /**
   * ADR-051 (P2b): read the unit currently occupying `tile`, or null (no occupant / Redis absent / parse error).
   * The P2b tile-entry encounter check calls this BEFORE a stepping march overwrites the cell with its own entry,
   * so a resident enemy (stationed team = scenario 1, or an earlier-arriving march still on the cell = scenario 2)
   * is detected first. Best-effort: a null return only disables the encounter for this step, never arrival.
   */
  async getOccupancy(worldId: string, tile: string): Promise<OccEntry | null> {
    if (!this.deps.redis) return null;
    try {
      const cur = await this.deps.redis.hget(this.occKey(worldId), tile);
      return cur ? (JSON.parse(cur) as OccEntry) : null;
    } catch {
      return null;
    }
  }

  // ── ADR-051 (P3a): garrison/tower 9-cell coverage reverse index (best-effort Redis hash, field=coveredTileId →
  // JSON map of {sourceTile → CoverEntry}). A garrison team (P3) or arrow tower (P5) writes its whole 3×3
  // footprint here on station/build and clears it on recall/abandon/destroy; the P3b interception check reads it
  // O(1) per stepped cell ("who covers this cell?"). A tile can be covered by several sources at once (overlapping
  // footprints), hence the per-tile map keyed by the source's own tile. Best-effort like occ — a lost write only
  // weakens the interception feature, never arrival correctness.
  private coverKey(worldId: string): string {
    return `world:${worldId}:cover`;
  }
  private async readCoverMap(worldId: string, tile: string): Promise<Record<string, CoverEntry>> {
    const cur = await this.deps.redis!.hget(this.coverKey(worldId), tile);
    return cur ? (JSON.parse(cur) as Record<string, CoverEntry>) : {};
  }
  /** Register one coverage source over its 3×3 footprint centered at (cx,cy). Best-effort; no-op without Redis. */
  async addCover(worldId: string, cx: number, cy: number, entry: CoverEntry): Promise<void> {
    if (!this.deps.redis) return;
    try {
      for (const c of baseFootprintCells(cx, cy)) {
        const tid = tileId(worldId, c.x, c.y);
        const map = await this.readCoverMap(worldId, tid);
        map[entry.sourceTile] = entry;
        await this.deps.redis.hset(this.coverKey(worldId), tid, JSON.stringify(map));
      }
    } catch {
      /* best-effort */
    }
  }
  /** Remove a coverage source (by its own tile) from its 3×3 footprint centered at (cx,cy). */
  async removeCover(worldId: string, cx: number, cy: number, sourceTile: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      for (const c of baseFootprintCells(cx, cy)) {
        const tid = tileId(worldId, c.x, c.y);
        const map = await this.readCoverMap(worldId, tid);
        if (map[sourceTile] === undefined) continue;
        delete map[sourceTile];
        if (Object.keys(map).length === 0) await this.deps.redis.hdel(this.coverKey(worldId), tid);
        else await this.deps.redis.hset(this.coverKey(worldId), tid, JSON.stringify(map));
      }
    } catch {
      /* best-effort */
    }
  }
  /** Read every coverage source over `tile` (garrisons / towers), or [] (uncovered / Redis absent / parse error). */
  async getCover(worldId: string, tile: string): Promise<CoverEntry[]> {
    if (!this.deps.redis) return [];
    try {
      const map = await this.readCoverMap(worldId, tile);
      return Object.values(map);
    } catch {
      return [];
    }
  }

  // ── Real-time push (best-effort, §14.5) ──
  async pushMarch(accountId: string, v: MarchView): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'march_update',
      marchId: v.marchId,
      marchKind: v.kind,
      fromTile: v.fromTile,
      toTile: v.toTile,
      arriveAt: v.arriveAt,
      status: v.status,
    });
  }
  async pushTile(accountId: string, t: TileDoc): Promise<void> {
    const ownerProfile = (t.ownerId && this.meta.available)
      ? await this.meta.getProfile(t.ownerId).catch(() => null)
      : null;
    await this.gateway.push(accountId, {
      kind: 'tile_update',
      tileId: t._id,
      type: t.type,
      level: t.level,
      ownerPublicId: ownerProfile?.publicId ?? '',
      ownerName: ownerProfile?.displayName ?? '',
      familyId: t.familyId ?? '',
      protectedUntil: t.protectedUntil ?? 0,
    });
  }
  async pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'siege_result',
      siegeId: s._id,
      marchId: s.marchId,
      tile: s.tile,
      outcome: s.outcome,
      lootSummary: lootSummaryStr,
      replayRef: s.replayRef ?? '',
    });
  }
}
