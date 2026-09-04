// worldsvc core — free functions & constants shared by the WorldCore layers.
// Peeled out of core.ts (WorldCore god-class split, 2026-07-03). No behavior change.
// core.ts re-exports emptyResources / deleteInBatches / lootSummary / MARCHABLE_KINDS
// so existing `import { ... } from '../core'` call sites keep working unchanged.
import {
  buildingMaxHp,
  regenDurability,
  regenGarrison,
  tileGarrisonBaseline,
  RESOURCE_TYPES,
  VISION_WATCHTOWER_RADIUS,
  VISION_BASE_RADIUS,
  VISION_TERRITORY_RADIUS,
  type TileType,
  type ResourceType,
  type VisionSource,
} from '@nw/shared';
import type { TileDoc } from '../db';

/** Maximum Chebyshev radius for ring-by-ring empty-tile search around family members' capitals when auto-spawning near the family (§3.4). */
export const SPAWN_NEAR_FAMILY_RADIUS = 6;
/** Auto-spawn outer newbie zone threshold: only spawn randomly in the outer ring where dr (normalized distance to center) > this value, staying away from the central contest zone (§3.4). */
export const SPAWN_OUTER_MIN_DR = 0.6;

/** Tile types that carry building HP (ADR-026 §1): the siege code writes TileDoc.hp on these; other types have no HP bar. */
const HP_BEARING_TILE_TYPES: ReadonlySet<TileType> = new Set(['base', 'territory', 'stronghold'] as TileType[]);

/**
 * ADR-026 §1 / D-CITY-8: HP-bar fields for a tile view. Non-base HP-bearing types (territory/stronghold) emit
 * maxHp (= buildingMaxHp(level)) and current hp, unchanged. Base tiles instead surface `durability`/`durabilityMax`
 * (wall-level-derived, persistent, self-regenerating — see baseDurabilityMax/regenDurability in shared/src/slg/siege.ts)
 * under the same `hp`/`maxHp` view field names, so the client contract is unchanged; the regen is computed live for
 * display only (pure function of stored fields + `now`) and is never persisted here — only an actual siege hit or
 * wall upgrade persists a new value (see settleSiegeDamage / applyDueBuilds). Non-HP-bearing tiles get no HP fields.
 */
export function siegeHpView(o: TileDoc, now: number): { hp?: number; maxHp?: number } {
  if (!HP_BEARING_TILE_TYPES.has(o.type)) return {};
  if (o.type === 'base') {
    const maxHp = o.durabilityMax ?? buildingMaxHp(o.level);
    const hp = regenDurability(o.durability ?? maxHp, maxHp, o.durabilityRegenAt ?? now, now);
    return { maxHp, hp };
  }
  const maxHp = buildingMaxHp(o.level);
  return { maxHp, hp: o.hp ?? maxHp };
}

/**
 * Live garrison of a tile — {@link TileDoc.garrison} healed toward `tileGarrisonBaseline(level)` by the
 * elapsed share of TILE_GARRISON_REGEN_MS (shared/src/slg/garrison.ts). **Every path that decides a
 * battle must go through this**, so that "how strong is this tile right now" has exactly one answer;
 * reading `tile.garrison` raw is correct only where the question is how many troops the owner is owed
 * back (the 放弃 refund).
 *
 * Only OWNED, non-base, non-ring tiles heal. A base anchor's garrison is structurally 0 — the capital
 * defends with in-base teams (ADR-026 §2), and healing it would silently add a second defence layer the
 * design does not have; ring cells hold no garrison at all (ADR-025); an unowned tile's strength is
 * `npcGarrison(level)`, computed procedurally at the point of use and never stored. Pure — no write.
 */
export function liveGarrison(o: TileDoc, now: number): number {
  const stored = Math.max(0, Math.floor(o.garrison ?? 0));
  if (!o.ownerId || o.type === 'base' || o.baseRing) return stored;
  // `o.level ?? 1` mirrors how the siege path reads it (combatSiege/arrival.ts) — TileDoc.level is typed
  // required but is absent on some documents, and defaulting here keeps this helper's answer identical to
  // the tileLevel the same battle is resolved at.
  return regenGarrison(stored, tileGarrisonBaseline(o.level ?? 1), o.garrisonRegenAt ?? 0, now);
}

export const emptyResources = (): Record<ResourceType, number> => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 });

/**
 * Batch deletion (§17.6): a single deleteMany on a collection with tens of thousands of records would hold
 * a lock for a long time and block the event loop. Instead, loop and delete by _id in batches of ≤ batch
 * documents, yielding the event loop between iterations. Idempotent: re-entry on already-deleted docs is a
 * no-op; eventually consistent. Returns the total number of deleted documents.
 */
export async function deleteInBatches(
  col: { find: (f: object) => { project: (p: object) => { limit: (n: number) => { toArray: () => Promise<Array<{ _id: string }>> } } }; deleteMany: (f: object) => Promise<{ deletedCount: number }> },
  filter: object,
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const docs = await col.find(filter).project({ _id: 1 }).limit(batch).toArray();
    if (docs.length === 0) break;
    const ids = docs.map((d) => d._id);
    const r = await col.deleteMany({ _id: { $in: ids } });
    total += r.deletedCount;
    if (docs.length < batch) break;
  }
  return total;
}

/** Player-facing march kinds that are permitted (return is an internal recall leg only; external initiation is prohibited). */
export const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep', 'move']);

/** Vision radius of a static vision source (territory/capital/watchtower): watchtower > capital > normal territory (§18 G5 V2). */
export function tileVisionRadius(t: { type: TileType; watchtower?: boolean }): number {
  if (t.watchtower) return VISION_WATCHTOWER_RADIUS;
  return t.type === 'base' ? VISION_BASE_RADIUS : VISION_TERRITORY_RADIUS;
}

/** Human-readable loot summary (non-zero items only, e.g. "ink+250,metal+40"; empty string if nothing looted). Used directly in siege_result push payloads. */
export function lootSummary(loot: Record<ResourceType, number>): string {
  return RESOURCE_TYPES.filter((rt) => (loot[rt] ?? 0) > 0)
    .map((rt) => `${rt}+${loot[rt]}`)
    .join(',');
}

/**
 * Query-optimization (2026-07-29): bounding box of a march leg's two endpoints, for MarchDoc.minX/maxX/minY/maxY.
 * getMarches' vision math (`marchInterpPos`) always interpolates linearly between fromTile and toTile (never
 * the bent A* `path`), so the true position at any instant during this leg is guaranteed to fall inside this
 * box — it can be computed once at leg-creation and never needs updating while the leg is in flight.
 */
export function legBox(x1: number, y1: number, x2: number, y2: number): { minX: number; maxX: number; minY: number; maxY: number } {
  return { minX: Math.min(x1, x2), maxX: Math.max(x1, x2), minY: Math.min(y1, y2), maxY: Math.max(y1, y2) };
}

/**
 * Query-optimization (2026-07-29): the viewer's territory/vision bounding box, derived from an already-computed
 * `VisionSource[]` (own + family territory/capitals/marches — see core/vision.ts::computeVisionSources), used to
 * push a coarse range filter into the enemy-march/enemy-stationed Mongo queries before the exact per-position
 * `isInVision` check runs in JS. Null when the viewer has no vision sources at all (e.g. not yet joined /
 * no territory) — callers should skip the enemy query entirely in that case, since nothing could possibly be visible.
 */
export function sourcesBoundingBox(sources: readonly VisionSource[]): { loX: number; hiX: number; loY: number; hiY: number } | null {
  if (sources.length === 0) return null;
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
  for (const s of sources) {
    loX = Math.min(loX, s.x - s.radius);
    hiX = Math.max(hiX, s.x + s.radius);
    loY = Math.min(loY, s.y - s.radius);
    hiY = Math.max(hiY, s.y + s.radius);
  }
  return { loX, hiX, loY, hiY };
}
