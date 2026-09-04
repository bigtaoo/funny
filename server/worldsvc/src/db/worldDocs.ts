// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape, same pattern as shared/src/mongo.ts). World/map domain: world metadata, per-tile state
// (including ADR-051 player-built structures), and the §24 map-template/baseline row storage.
import type { Collection } from 'mongodb';
import type { TileType, ResourceType, WorldStatus, TileRun, MapEditorCityNode } from '@nw/shared';

/** Defense configuration: a restricted subset of the engine LevelDefinition (P2/P5, embedded rather than a separate collection). Opaque placeholder until S8-3 wires up the engine. */
export type DefenseConfig = Record<string, unknown>;

export interface WorldDoc {
  _id: string; // worldId = `s{season}-{shard}`
  season: number;
  shard: number;
  status: WorldStatus;
  mapW: number;
  mapH: number;
  openAt: number;
  resetAt?: number;
  /** Season clock (§17.14): openAt + SLG_SEASON_DURATION_MS. When status='active' and now ≥ settleAt, the scheduler auto-settles. Absent = legacy world (never auto-settles). */
  settleAt?: number;
  capacity: number;
  population: number;
  /** Engine version pinned at world open (C7/§17.9, = @nw/engine ENGINE_VERSION); absent means not pinned (legacy world). */
  engineVersion?: number;
  /**
   * City siege-point nodes for this world (ADR-034 §3; ~64 entries), cloned from the active map template
   * at world-open alongside `mapBaselineRows` — the point-node twin of the terrain baseline (§24 "cloned
   * rather than referenced live"). Served to the client on `POST /world/enter` so the world map's city
   * sprite layer draws the cities that are actually on the map instead of recomputing `allCityNodes()`
   * from the world's own seed (which is wrong twice over for an edited template: dragged cities moved,
   * and the template's terrain was generated on the TEMPLATE's seed). Absent = pre-2026-08-19 world with
   * no stored list; the read path falls back to `allCityNodes(worldId)`, exactly the old behavior.
   */
  cities?: MapEditorCityNode[];
  rev: number;
}

/** Occupied or modified tiles (neutral default tiles are not persisted; computed by proceduralTile). */
/** ADR-051 (P5): a player-built structure on a tile. `kind` picks the behavior (arrowTower / blocker); `hp`/`hpMax`
 * are its siege durability (attack-only); `ownerId`/`familyId` gate friend-vs-foe (own & family pass a blocker
 * freely, enemies are chipped by a tower / blocked by a blocker). */
export interface TileStructure {
  kind: 'arrowTower' | 'blocker';
  level: number;
  hp: number;
  hpMax: number;
  ownerId: string;
  familyId?: string;
  builtAt: number;
}

export interface TileDoc {
  _id: string; // tileId = `{worldId}:{x}:{y}`
  worldId: string;
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  ownerId?: string; // occupying accountId
  familyId?: string;
  defense?: DefenseConfig; // territory defense (P5, embedded)
  /**
   * Troops the OWNER paid for on this tile: GARRISON_PER_TILE on an occupy, plus every `reinforce`
   * arrival, minus siege casualties. Refundable to the troop pool on 放弃 (territory.ts).
   *
   * **Not what an attacker fights.** Combat resolves against the LIVE garrison — this value healed up to
   * `tileGarrisonBaseline(level)` over `TILE_GARRISON_REGEN_MS` since `garrisonRegenAt` — which is always
   * >= this field and is never written back into it. Read it through `liveGarrison(tile, now)`
   * (core/helpers.ts), never raw, on any path that decides a battle; read it raw only where the question
   * is "how many troops does the owner get back". See shared/src/slg/garrison.ts for why the two differ.
   */
  garrison?: number;
  /**
   * Last time `garrison` was settled by combat (or the tile founded) — the lazy-regen anchor for the
   * baseline heal, mirroring `durabilityRegenAt`. **Absent means "no recent battle"**, i.e. the tile reads
   * as sitting at its baseline: that is the intended migration for documents written before the regen
   * existed, and the reason every founding/casualty write below stamps it (so a freshly taken tile does
   * not instead read as instantly healed). A `reinforce` arrival deliberately does NOT touch it — see
   * combatMarch/arrival.ts.
   */
  garrisonRegenAt?: number;
  /**
   * ADR-026: building HP. On a main-base anchor this is the whole capital's HP; on territory/level/stronghold tiles it is that building's HP.
   * Absent = full (derive from buildingMaxHp(level) on read/first hit). A successful siege deducts the attacker team's siege value; HP≤0 → captured.
   */
  hp?: number;
  /**
   * D-CITY-8: main-base anchor only. Persistent durability, capped by `durabilityMax` (derived from the
   * owner's `wall` building level via baseDurabilityMax — cached here to avoid an owner lookup per tile-view
   * read; recomputed whenever `wall` finishes a build). Replaces buildingMaxHp(level)/`hp` for base tiles;
   * territory/stronghold tiles are unaffected and keep using `hp` as before. Absent = full (fresh base).
   */
  durability?: number;
  durabilityMax?: number;
  /** D-CITY-8: last time `durability` was settled (siege hit or regen read) — lazy-regen anchor, mirrors resource yield settling. */
  durabilityRegenAt?: number;
  protectedUntil?: number; // ms
  watchtower?: boolean; // watchtower (§18 G5 V2): once built, this tile becomes a large-radius persistent vision source; lost together with TileDoc when tile is lost
  /**
   * ADR-051 (P5): player-built map structure overlaid on this tile (generalizes the boolean `watchtower`; the two
   * coexist for now). arrowTower chips passing enemies over its 3×3 `cover` footprint (no stop); blocker is a hard
   * path obstacle enemies must destroy. `hp` is reduced only by an attack march; 0 → the structure is removed and
   * its cover cleared. Built only on own/family territory (never the base anchor); lost with the TileDoc.
   */
  structure?: TileStructure;
  /** ADR-025: true on the 8 non-anchor cells of a 3×3 main-base footprint (the anchor omits this). Ring cells hold ownerId + protection but no garrison/yield. */
  baseRing?: boolean;
  /** ADR-025: on ring cells only — the tileId of this base's anchor, so a siege landing on a ring cell resolves against the anchor's garrison/defense. Anchor omits this. */
  baseAnchor?: string;
  /**
   * ADR-037 (§5.4): set while this tile is mid occupation-hold — an occupy march won its PvE battle against the
   * system garrison but the hold countdown has not yet elapsed, so `ownerId` is still absent. `contestedBy` is the
   * pending occupier's accountId; `contestedUntil` (ms) is when `processDueOccupations` finalizes ownership;
   * `contestedGarrison` is the surviving troops that will become the tile's garrison on settlement (also the
   * strength an expelling attack/occupy march must beat). Cleared together on settlement or expulsion.
   */
  contestedBy?: string;
  contestedUntil?: number;
  contestedGarrison?: number;
  contestedFamilyId?: string;
  /**
   * Main-base anchor only. Mirrors the owner's `desk` building level (1-10) so the world-map render can
   * pick the player-base art frame (`playerbase_l{n}`) without a separate playerWorld lookup per tile-view
   * read. Set whenever a `desk` upgrade completes (applyDueBuilds); absent = level 1 (fresh base).
   */
  deskLevel?: number;
  rev: number;
}

/** Map template metadata (§24 Layer A). `_id` = templateId. At most one document has `active: true`. */
export interface MapTemplateDoc {
  _id: string;
  width: number;
  height: number;
  version: number;
  tileCount: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * The template's city siege-point nodes (ADR-034 §3), uploaded by tools/map-editor next to the tile
   * diff — the point-node layer the tile rasterization bakes down from (see shared's `rasterizeMapEdits`).
   * Stored inline rather than as rows: ~64 nodes, always read and written whole. Absent = never published
   * a city list (a template generated before 2026-08-19, or one whose cities were never dragged); the
   * clone path then falls back to `allCityNodes(templateId)`, which is what this template's terrain was
   * generated against.
   */
  cities?: MapEditorCityNode[];
}

/**
 * One row of a map template, run-length-encoded (§24 Layer A; storage redesign 2026-07-27 — see
 * shared/src/slg/mapRle.ts header). Replaces the pre-2026-07-27 per-cell `MapTemplateTileDoc`
 * (`${templateId}:${x}:${y}`, one doc per cell — 2.25M docs at SLG_MAP_W×SLG_MAP_H): terrain has long
 * horizontal runs, so one doc per row (height docs, e.g. 1500) with a compact run list covers the same data.
 */
export interface MapTemplateRowDoc {
  _id: string; // `${templateId}:${y}`
  templateId: string;
  y: number;
  runs: TileRun[];
}

/**
 * Per-world terrain baseline row, cloned (copied, not referenced) from a template's rows at world-open time
 * (§24). Consumed by the runtime read path (WorldCoreMap.getMap/getTile): for a tile with no TileDoc
 * override, this baseline is the terrain, falling back to proceduralTile() only when no baseline row exists
 * (no active template at world-open). Same run-length shape as MapTemplateRowDoc, keyed by worldId instead
 * of templateId. Replaces the pre-2026-07-27 per-cell `MapBaselineTileDoc` (see MapTemplateRowDoc above).
 */
export interface MapBaselineRowDoc {
  _id: string; // `${worldId}:${y}`
  worldId: string;
  y: number;
  runs: TileRun[];
}

/** World/map-domain indexes. */
export async function ensureWorldIndexes(
  worlds: Collection<WorldDoc>,
  tiles: Collection<TileDoc>,
  mapTemplates: Collection<MapTemplateDoc>,
  mapTemplateRows: Collection<MapTemplateRowDoc>,
  mapBaselineRows: Collection<MapBaselineRowDoc>,
): Promise<void> {
  await worlds.createIndex({ status: 1 });
  // Auto-settle due scan (§17.14): scheduler finds active worlds whose season clock elapsed (status='active', settleAt ≤ now).
  await worlds.createIndex({ status: 1, settleAt: 1 });
  // Viewport range query (P6: spatial query v1 uses Mongo {worldId,x,y} range query; Redis bucket cache is a later addition).
  await tiles.createIndex({ worldId: 1, x: 1, y: 1 });
  await tiles.createIndex({ ownerId: 1 });
  await tiles.createIndex({ familyId: 1 });
  // computeMarchPath (2026-07-29 audit): every march dispatch/recall does 3 near-full scans of `tiles` —
  // crossings (`type:{$in:['bridge','plankway']}`), enemy-blocked capitals (`type:'base', ownerId:{$nin:...}`),
  // and player-built blockers (`structure.kind:'blocker'`) — none of which had a supporting index beyond
  // {worldId,x,y} (useless without knowing x/y up front). This compound index serves the first two
  // (an equality-narrowed `type:'base'` scan is far smaller than the whole tiles collection even though
  // `$nin` itself isn't index-selective) with a single index.
  await tiles.createIndex({ worldId: 1, type: 1 });
  // Player-built structures (blockers/arrow towers) are rare — most tiles never carry `structure` at all —
  // so sparse keeps this index small while still covering the third computeMarchPath scan.
  await tiles.createIndex({ worldId: 1, 'structure.kind': 1 }, { sparse: true });
  // Vision's `contestedBy` branch of its $or (computeVisionSources) had no supporting index — only the
  // `ownerId` side of the $or could use one. Sparse: most tiles never carry contestedBy (2026-07-27 audit).
  await tiles.createIndex({ contestedBy: 1 }, { sparse: true });
  // Map templates (§24): viewport bbox reads scan by templateId + x/y range; active lookup for the "which template do new worlds clone" query.
  // Row-level range queries (viewport bbox reads decode the needed y-range then filter x in-memory —
  // see mapTemplateService.ts/coreMap.ts); `_id` (`templateId:y` / `worldId:y`) already covers exact-row lookups.
  await mapTemplateRows.createIndex({ templateId: 1, y: 1 });
  await mapTemplates.createIndex({ active: 1 });
  await mapBaselineRows.createIndex({ worldId: 1, y: 1 });
}
