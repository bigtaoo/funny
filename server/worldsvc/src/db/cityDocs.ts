// ADR-074 P1 wild-city siege documents. One `CityDoc` per city siege-point node (~64 per world: the
// world center, 9 province capitals, 54 graded cities), created at season open by
// `CitySiegeService.initCities` from the world's stored node list.
//
// Why a collection of its own rather than fields on the `tiles` rows that make up the plot: a city's
// footprint is 9-81 tiles and indivisible (§4.1), so its durability/ownership/siege log are properties of
// the CITY, not of any one cell. Putting them on the anchor tile would also collide with the tile-scale
// `hp`/`durability` fields the main-base and building paths already own, and would make "who owns this
// city" a scan over city ground.
import type { Collection } from 'mongodb';
import type { CityKind } from '@nw/shared';

/**
 * A wild city as a playable entity (SLG_CITY_SIEGE_DESIGN §4.2). Ownership is by SECT
 * (`ownerSectId`) — never by account or family: ADR-039 connectivity is already sect-scoped, and the
 * account+family attribution the deleted `applyNationChange` used is exactly what let one player take a
 * province (§1.4).
 */
export interface CityDoc {
  /** `city:{worldId}:{nodeId}`. */
  _id: string;
  worldId: string;
  /** `MapEditorCityNode.id` — 'worldCenter' | 'capital-{provinceIdx}' | 'garrison-{n}'. */
  nodeId: string;
  kind: CityKind;
  /** Plot anchor = footprint centre. */
  x: number;
  y: number;
  level: number;
  footprint: number;
  provinceIdx?: number;

  /** Owning sect; absent while the city is still NPC-held. */
  ownerSectId?: string;
  /** Sect display name snapshot at capture time (so the map can label the city without a sect lookup). */
  ownerSectName?: string;
  capturedAt?: number;
  /** Post-capture protection window; a siege landing inside it is voided (§7). */
  protectedUntil?: number;

  /** Current durability. Stored lazily — always read through `regenCityDurability` (see `durabilityRegenAt`). */
  durability: number;
  /** `cityDurabilityMax(level, kind)`, snapshotted so a client view needs no recompute. */
  durabilityMax: number;
  /** Epoch ms the stored `durability` was last settled — the base for lazy regen. */
  durabilityRegenAt: number;
  /** `cityRegenPerHour(level, kind)`, snapshotted alongside `durabilityMax`. */
  regenPerHour: number;

  /**
   * Cumulative durability damage this siege round, by sect (§7). Cleared when the city changes hands or
   * its durability regenerates to full. Ownership goes to the LAST hit (ADR-074 decision 2, user's call
   * over the accumulated-damage alternative); this exists so switching to "highest cumulative damage
   * wins" later needs no data migration, and so the client can show a per-sect contribution panel.
   */
  siegeLog?: Record<string, number>;

  /**
   * P3: `teamId` → epoch ms a defeated owner-stationed defender team is locked out of the wave ladder
   * (`CITY_WAVE_RESPAWN_MS`). The NPC ladder is per-march and never respawns mid-assault, so this is
   * empty for an NPC-held city — see `CITY_WAVE_COUNT`'s doc comment for why a shared, respawning NPC
   * ladder cannot work.
   */
  defenderLock?: Record<string, number>;

  rev: number;
}

/** City-domain indexes. */
export async function ensureCityIndexes(cities: Collection<CityDoc>): Promise<void> {
  await cities.createIndex({ worldId: 1 });
  // §8 sect city-bonus aggregation ("every city this sect holds") + the map's owned-city highlight.
  await cities.createIndex({ worldId: 1, ownerSectId: 1 });
  // Anchor lookup: resolving "which city does this footprint cell belong to" goes through the shared
  // `cityGroundNodeAt` geometry first, so this only needs to find the doc for a known anchor.
  await cities.createIndex({ worldId: 1, x: 1, y: 1 });
}
