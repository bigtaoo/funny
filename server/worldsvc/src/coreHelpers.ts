// worldsvc core — free functions & constants shared by the WorldCore layers.
// Peeled out of core.ts (WorldCore god-class split, 2026-07-03). No behavior change.
// core.ts re-exports emptyResources / deleteInBatches / lootSummary / MARCHABLE_KINDS
// so existing `import { ... } from './core'` call sites keep working unchanged.
import {
  buildingMaxHp,
  regenDurability,
  RESOURCE_TYPES,
  VISION_SCOUT_RADIUS,
  VISION_MARCH_RADIUS,
  VISION_WATCHTOWER_RADIUS,
  VISION_BASE_RADIUS,
  VISION_TERRITORY_RADIUS,
  type TileType,
  type ResourceType,
  type MarchKind,
} from '@nw/shared';
import type { TileDoc } from './db';

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
export const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep', 'scout', 'move']);

/** Vision radius of an in-transit march: scout marches see farther (VISION_SCOUT_RADIUS); all others use normal march radius (VISION_MARCH_RADIUS). */
export function marchVisionRadius(kind: MarchKind): number {
  return kind === 'scout' ? VISION_SCOUT_RADIUS : VISION_MARCH_RADIUS;
}

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
