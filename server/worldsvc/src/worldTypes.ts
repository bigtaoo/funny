// worldsvc shared view/response types + service dependency contract.
// Extracted verbatim from service.ts (god-class split, 2026-07-03). No behavior change:
// these are the REST response shapes returned by WorldService and the DI surface it is constructed with.
import type { BuildingKey, TileType, ResourceType, ObstacleKind, MarchKind, SlgShopPriceCache, SiegeOutcome } from '@nw/shared';
import type { GarrisonEntry } from '@nw/engine';
import type { WorldCollections, MarchDoc, CardSLGState } from './db';
import type { WorldRedis } from './redis';
import type { WorldGatewayClient } from './gatewayClient';
import type { WorldMetaClient } from './metaClient';
import type { WorldCommercialClient } from './commercialClient';
import type { WorldMailClient } from './mailClient';
import type { WorldSocialsvcClient } from './socialsvcClient';

/** Replayable inputs for a decisive siege (G3-2c): seed + both sides' formations + tile level, persisted to SiegeDoc for client-side replay spectating. */
export interface SiegeReplayInputs {
  seed: number;
  attackerArmy: GarrisonEntry[];
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null;
  tileLevel: number;
}

/**
 * Compact battle-report row for the "recent sieges" list (last-100 replay browser). Returned by listSieges;
 * one entry per SiegeDoc the requester took part in, newest first. `role` is relative to the requester
 * (attacker/defender), and `hasReplay` reflects whether the persisted record can be headless-replayed
 * (seed + attackerArmy present — cheap-settle / NPC-sweep reports degrade to a non-replayable outcome row).
 */
export interface SiegeSummaryView {
  siegeId: string;
  tile: string;
  tileLevel?: number;
  outcome: SiegeOutcome;
  role: 'attacker' | 'defender';
  ts: number;
  hasReplay: boolean;
}

/** Single-tile view in the viewport (REST response). `mine` indicates whether the tile belongs to the requester; `ownerPublicId`/`ownerName` are the nickname of another player's territory (requires meta to be available). */
export interface WorldTileView {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /**
   * §24: for type=obstacle only — river vs mountain art. Carried from the per-world terrain baseline
   * (mapBaselines) or proceduralTile, so map-editor-painted rivers/mountains render correctly instead of
   * the client re-deriving a possibly-different kind from proceduralTile locally.
   */
  obstacleKind?: ObstacleKind;
  /** Whether occupied by any player (neutral/unoccupied = false or omitted). */
  occupied?: boolean;
  /** Whether owned by the requester. */
  mine?: boolean;
  /** Main-base anchor only: owner's `desk` building level (1-10), for the player-base art frame. Absent = level 1. */
  deskLevel?: number;
  /** Another player's territory: occupier's 9-digit public id (populated when meta is available). */
  ownerPublicId?: string;
  /** Another player's territory: occupier's display name (populated when meta is available). */
  ownerName?: string;
  familyId?: string;
  garrison?: number;
  /** ADR-026 §1: current building HP (base/territory/stronghold). Omitted = full HP; client falls back to maxHp. */
  hp?: number;
  /** ADR-026 §1: building max HP = level × SLG_BASE_HP_PER_LEVEL. Client renders the HP bar as hp/maxHp. */
  maxHp?: number;
  protectedUntil?: number;
  /**
   * ADR-037 (§5.4): this tile is mid occupation-hold — an occupy march won its PvE battle but the hold countdown
   * has not yet elapsed (no `ownerId` yet). ms epoch when the hold resolves into ownership (or is expelled first).
   */
  contestedUntil?: number;
  /** ADR-037 (§5.4): the pending occupier (contestedBy) is the requester themself — client distinguishes "I'm holding" from "someone else is holding". */
  contestedByMe?: boolean;
  /** §18 G5 V2: this tile has a watchtower (only exposed for tiles visible to the player) — large-radius persistent vision source; client renders the tower marker. */
  watchtower?: boolean;
  /**
   * G5: this tile is owned by an ally in the same family (not the requester, within vision). The client
   * renders it in "friendly color" — after family vision sharing, ally territory should no longer appear
   * as enemy color (occupation does not write tile.familyId, so the server determines this flag based on
   * the family member set and attaches it here).
   */
  ally?: boolean;
  /**
   * G5: this tile is owned by a member of an "allied sect" of the player's own sect (within vision, not the
   * requester, not a family member). Alliances do not share vision; they are only distinguished by a yellow
   * border marker on the map (§8.2). Family allies use `ally`; this field is specifically for cross-sect alliances.
   */
  allySect?: boolean;
  /**
   * G5 vision: whether this tile is within the requester's current vision.
   * - true: the dynamic layer (ownership/garrison/defense/protection shield) is returned as-is;
   * - false: outside vision — only the procedural base terrain (type/level/resType) is returned;
   *   all dynamic layers are hidden (not even "occupied" is leaked — type falls back to base terrain rather than 'territory').
   * Populated only by getMap viewport reads; single-tile responses like getTile/occupy do not include this field.
   */
  visible?: boolean;
}

export interface WorldMapView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  tiles: WorldTileView[];
}

/**
 * Sparse occupied-tile view (zoom 2/3 bird's-eye layer).
 * Contains only occupied tiles (ownerId present); unoccupied tiles are rendered locally by the client from proceduralTile.
 * No profile RPC / no vision computation → an order of magnitude faster than WorldTileView.
 */
export interface WorldTileSparseView {
  x: number;
  y: number;
  type: TileType;
  mine?: boolean;
  /** Populated when lod=mid (same-family ally). */
  ally?: boolean;
  /** Populated when lod=mid (allied sect member, not family). */
  allySect?: boolean;
}

export interface WorldMapSparseView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  lod: 'thin' | 'mid';
  /** Occupied tiles only, sparse array. Tiles not listed here are rendered by the client via proceduralTile. */
  tiles: WorldTileSparseView[];
}

export interface PlayerWorldView {
  joined: boolean;
  /** shard worldId the player is in (G6/§20 R3: join-season resolution result returned to client as basis for entering the map). */
  worldId?: string;
  troops?: number;
  troopCap?: number;
  resources?: Record<ResourceType, number>;
  yieldRate?: Record<ResourceType, number>;
  mainBaseTile?: string;
  territoryCount?: number;
  familyId?: string;
  /** Training queue (S8-2, sorted by completeAt ascending); client C4 renders countdowns based on this. */
  trainingQueue?: { qty: number; startAt: number; completeAt: number }[];
  /** Home-city building levels (SLG_CITY_DESIGN; desk≥1, others≥0). */
  buildings?: Partial<Record<BuildingKey, number>>;
  /** Build queue (SLG_CITY_DESIGN §4, ordered by completeAt ascending); client CityScene renders countdowns. */
  buildQueue?: { key: BuildingKey; toLevel: number; startAt: number; completeAt: number }[];
  /** CC-4: per-card SLG run-time state (currentTroops / injuredUntil / teamId). Absent when the player has none. */
  cardState?: Record<string, CardSLGState>;
  /** CC-4: base troop pool available to distribute to card slots. */
  baseTroopStock?: number;
  /** ADR-026 §5: per-team injury state (team granularity). Present only for teams with active state; client renders an injury countdown in the team menu. */
  teamState?: Record<string, { injuredUntil?: number }>;
  /** D-CITY-8: own main base's current persistent durability, same field name/semantics as WorldTileView.hp (wall-level-derived cap, self-regenerating). Absent when mainBaseTile hasn't resolved to a stored tile doc yet. */
  hp?: number;
  /** D-CITY-8: own main base's durability cap (= baseDurabilityMax(wall level)). Client renders the durability bar as hp/maxHp, same contract as WorldTileView. */
  maxHp?: number;
}

/** March view (REST response / push payload source). */
export interface MarchView {
  marchId: string;
  kind: MarchKind;
  fromTile: string;
  toTile: string;
  troops: number;
  departAt: number;
  arriveAt: number;
  status: MarchDoc['status'];
  /** G5: whether this is the requester's own march (getMarches distinguishes own vs. enemy marches in vision; not included in push payloads). */
  mine?: boolean;
  /** ADR-026: which team slot ('t1'..'t5') this march deployed, if any (own marches only). */
  teamId?: string;
}

/** Occupation-hold view (REST response — own holds only; 2026-07-15 team-management cancel feature). */
export interface OccupationView {
  tile: string;
  x: number;
  y: number;
  level: number;
  garrison: number;
  dueAt: number;
  /** Which team slot ('t1'..'t5') is tied up holding this tile, if the march was dispatched with one. */
  teamId?: string;
}

/** Maximum viewport radius (prevents fetching too many tiles at once; hard cap before P9 viewport subscription model scales up). */
export const MAP_VIEW_MAX_RADIUS = 40;

export interface WorldServiceDeps {
  cols: WorldCollections;
  redis: WorldRedis | null;
  mapW: number;
  mapH: number;
  now: () => number;
  /** Real-time event push (march_update/tile_update); default = no gateway, push is no-op (REST polling). */
  gateway?: WorldGatewayClient;
  /** Resolve player profile (publicId/displayName); default = display names are not populated. */
  meta?: WorldMetaClient;
  /** Coin deduction (troop training speedup / SLG shop); default = coin operations unavailable. */
  commercial?: WorldCommercialClient;
  /** System mail (season settlement reward dispatch, §17.5); default = no rewards sent (best-effort). */
  mail?: WorldMailClient;
  /** socialsvc internal client (SS7: syncs familyId read-only mirror on joinWorld); default = familyId not populated. */
  socialsvc?: WorldSocialsvcClient;
  /** SLG shop price/effect override cache (polls admin, no DB connection; default = always uses SLG_SHOP_ITEMS code defaults). */
  shopPrices?: SlgShopPriceCache;
}
