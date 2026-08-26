// worldsvc shared view/response types + service dependency contract.
// Extracted verbatim from service.ts (god-class split, 2026-07-03). No behavior change:
// these are the REST response shapes returned by WorldService and the DI surface it is constructed with.
import type { BuildingKey, TileType, ResourceType, ObstacleKind, MarchKind, SlgShopPriceCache, SiegeOutcome, WordlistCache } from '@nw/shared';
import type { GarrisonEntry, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { WorldCollections, MarchDoc, CardSLGState } from './db';
import type { WorldRedis } from './redis';
import type { WorldGatewayClient } from './gatewayClient';
import type { WorldMetaClient } from './metaClient';
import type { WorldCommercialClient } from './commercialClient';
import type { WorldMailClient } from './mailClient';
import type { WorldSocialsvcClient } from './socialsvcClient';

/**
 * Replayable inputs for a decisive siege (G3-2c): seed + both sides' formations + tile level, persisted
 * to SiegeDoc for client-side replay spectating.
 *
 * 2026-08-12 fix (replay-fidelity gap found alongside the NPC-garrison-blueprint-leak incident, see
 * `combatSiege/occupationBattle.ts` resolveOccupationBattle / `combatSiege/arrival.ts` applySiege): the
 * ACTUAL battle settlement always resolves `unitBlueprints` from `cardInstances`/`equipmentInv`/
 * `siegeAcademy` (buildSiegeBlueprints) whenever the attacker fields a real card team — but this struct
 * used to omit all three, storing only `attackerArmy`'s per-unit initialHp. A card-army replay
 * reconstructed from that alone re-derives every unit's attack/armor/abilities from PLAIN BASELINE
 * blueprints instead of the attacker's actual leveled/equipped stats, so the client's replay is not a
 * faithful reconstruction of what worldsvc actually ran — confirmed to be able to flip the recorded
 * winner outright (a real production case, zihao1's 2026-08-12 occupy loss: replay showed attacker_win,
 * recorded settlement was defender_win). Now always stored alongside seed/attackerArmy/defenderConfig/
 * tileLevel, mirroring the "traceability over cheap storage" decision already made for the
 * cheap-formula/crash-fallback paths (see this field's own history / SLG_DESIGN_LOG.md).
 */
export interface SiegeReplayInputs {
  seed: number;
  attackerArmy: GarrisonEntry[];
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null;
  tileLevel: number;
  /** Attacker's card instances (level/equipment injection) — absent for a flat/synthesized army. */
  cardInstances?: EngineCardInstance[];
  /** Attacker's equipment inventory for gear-slot resolution. Absent when cardInstances is absent, or the attacker had no equipment inventory available at battle time. */
  equipmentInv?: EngineEquipInv;
  /** Attacker's academy seasonal buff (siege path only). Absent = no academy bonus was active. */
  siegeAcademy?: { hp: number; damage: number; siege: number };
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
  /** ADR-051 (P5): player-built structure on this tile (arrowTower / blocker). Rendered map-wide (public);
   * hp/hpMax are intel-gated (omitted out of vision, like garrison/watchtower). */
  structure?: TileStructureView;
  /**
   * G5: this tile is owned by an ally in the same family (not the requester, within vision). The client
   * renders it in "friendly color" — after family vision sharing, ally territory should no longer appear
   * as enemy color (occupation does not write tile.familyId, so the server determines this flag based on
   * the family member set and attaches it here).
   */
  ally?: boolean;
  /**
   * 2026-08-08: this tile is owned by a member of the requester's own sect who is NOT in the requester's
   * family (within vision, not self; family members use `ally` instead, allied-sect members use `allySect`).
   * Does not share vision (only family does, DECISIONS §18.6) — this is purely a third map-colour tag so
   * fellow-sect territory outside your family no longer renders identically to a stranger's.
   */
  sectmate?: boolean;
  /**
   * G5: this tile is owned by a member of an "allied sect" of the player's own sect (within vision, not the
   * requester, not a family member). Alliances do not share vision; they are only distinguished by a yellow
   * border marker on the map (§8.2). Family allies use `ally`; this field is specifically for cross-sect alliances.
   */
  allySect?: boolean;
  /**
   * G5 vision. Since the 2026-07-24 fog-model change this is always `true` on getMap/getTile reads: the static
   * structure layer (location / ownership / base identity / level / occupation) is public map-wide, so fog no
   * longer withholds whole tiles. Fog now gates only the INTEL fields (garrison / hp / maxHp / watchtower),
   * which are simply omitted for out-of-vision tiles (see core/map.gateIntel), and marching troops (getMarches).
   * The field is retained so existing clients keep rendering the map un-dimmed (they darken only on `=== false`).
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
  /** Populated when lod=mid (same-sect member, not family). */
  sectmate?: boolean;
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
  /**
   * ADR-074 P1: the sect this account belongs to (mirrored onto PlayerWorldDoc at joinWorld). Absent when
   * unaffiliated. The client needs it to decide whether a wild city's info panel may offer a siege button —
   * only sect members can besiege a city (decision 1).
   */
  sectId?: string;
  /** Training queue (S8-2, sorted by completeAt ascending); client C4 renders countdowns based on this. */
  trainingQueue?: { qty: number; startAt: number; completeAt: number }[];
  /**
   * S8-8 fix (2026-08-08): train-speedup shop buff end time (ms epoch) — while in the future, the training
   * queue advances at TRAIN_SPEEDUP_BUFF_MULT× real-time speed (see db.ts PlayerWorldDoc.speedupUntil).
   * Present whenever the player has ever bought a speedup, even once expired; client compares against
   * Date.now() itself (same contract as WorldTileView.protectedUntil).
   */
  speedupUntil?: number;
  /**
   * Season battle pass held (S8-8 shop). `getMe` has always returned this (core/map.ts spreads it in)
   * and openapi-world.yml declares it on PlayerWorldView — the TS interface just never listed it, so
   * every reader had to go through `any`. Added 2026-08-19 when the test programs surfaced two shop
   * e2e assertions that could not compile against the declared type.
   */
  hasBattlePass?: boolean;
  /** Home-city building levels (SLG_CITY_DESIGN; desk≥1, others≥0). */
  buildings?: Partial<Record<BuildingKey, number>>;
  /** Build queue (SLG_CITY_DESIGN §4, ordered by completeAt ascending); client CityScene renders countdowns. */
  buildQueue?: { key: BuildingKey; toLevel: number; startAt: number; completeAt: number }[];
  /** CC-4: per-card SLG run-time state (currentTroops / injuredUntil / teamId). Absent when the player has none. */
  cardState?: Record<string, CardSLGState>;
  /** ADR-026 §5: per-team injury state (team granularity). Present only for teams with active state; client renders an injury countdown in the team menu. */
  teamState?: Record<string, { injuredUntil?: number }>;
  /** D-CITY-8: own main base's current persistent durability, same field name/semantics as WorldTileView.hp (wall-level-derived cap, self-regenerating). Absent when mainBaseTile hasn't resolved to a stored tile doc yet. */
  hp?: number;
  /** D-CITY-8: own main base's durability cap (= baseDurabilityMax(wall level)). Client renders the durability bar as hp/maxHp, same contract as WorldTileView. */
  maxHp?: number;
  /**
   * S8-8 UI fix (2026-08-08): mirror of the main base anchor tile's `protectedUntil` (see
   * WorldTileView.protectedUntil / TileDoc.protectedUntil), same rationale as hp/maxHp above — lets the
   * HUD render a shield countdown without depending on the base tile being in the current map viewport.
   * Absent when the player has no resolved main base yet, or the base has never been shielded.
   */
  baseProtectedUntil?: number;
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
  /** March-token art (2026-07-26): the deployed team's leader unit-type, resolved once at dispatch — see MarchDoc.leaderUnitType. Present for own AND enemy marches (server-resolved, no cardInv exposure). Absent on flat-troop marches. */
  leaderUnitType?: string;
  /**
   * Map-token corner badge (family-emblem-art-prompts.md, 2026-08-14): the march owner's family
   * emblem, if they're in a family that picked one — see combatShared.ts's resolveOwnerEmblems.
   * Resolved live per-response from the same read-only ownerId→familyId mirror as familyMemberIds
   * (not frozen at dispatch, unlike leaderUnitType — family identity isn't sensitive the way
   * card/team composition is, so there's no reason to snapshot it).
   */
  emblemKey?: string;
  emblemColor?: number;
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
  /** March-token art (2026-07-26): carried over from the winning MarchDoc.leaderUnitType — see MarchDoc for the resolution rule. */
  leaderUnitType?: string;
  /** Map-token corner badge — see MarchView.emblemKey/emblemColor for the resolution rule (getOccupations is own-holds-only, so this is always the requester's own family badge). */
  emblemKey?: string;
  emblemColor?: number;
}

/** ADR-051 (P5): player-built structure view (arrowTower / blocker). hp/hpMax intel-gated out of vision. */
export interface TileStructureView {
  kind: 'arrowTower' | 'blocker';
  level: number;
  hp?: number;
  hpMax?: number;
  /** Whether the requester built it (client shows Demolish only on own structures). */
  mine?: boolean;
}

/** Stationed-team view (REST response). 2026-07-23 field-stationing; ADR-051 (P4) also returns ENEMY stationed
 * teams within the requester's vision so the client can render enemy field troops + garrison zones. */
export interface StationedView {
  tile: string;
  x: number;
  y: number;
  teamId: string;
  troops: number;
  sinceAt: number;
  /** ADR-051 (P3a): 停留 idle vs 驻扎 garrison (see StationedDoc.mode). Absent → 'idle'. */
  mode?: 'idle' | 'garrison';
  /** ADR-051 (P4): whether this team belongs to the requester (false = enemy stationed team within vision).
   * Absent → treat as own (legacy). teamId is blanked for enemy teams. */
  mine?: boolean;
  /** March-token art (2026-07-26): carried over from the originating MarchDoc.leaderUnitType — see MarchDoc for the resolution rule. Not blanked for enemy teams (unlike teamId) since it reveals no team/card identity, only a unit-type enum already visible on the token's own animation. */
  leaderUnitType?: string;
  /** Map-token corner badge — see MarchView.emblemKey/emblemColor for the resolution rule. Present for own AND enemy stationed teams (family identity isn't sensitive, unlike teamId). */
  emblemKey?: string;
  emblemColor?: number;
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
  /** Content-moderation word list overlay cache (CONTENT_MODERATION_DESIGN.md §3.2); default = built-in REGION_WORDLISTS only. */
  wordlists?: WordlistCache;
  /**
   * Uniform [0,1) source for the non-replay randomness in this service — currently only spawn-point
   * selection (core/spawn.ts: auto-placement dice + family-ring shuffles). Default = `Math.random`.
   * Injectable so tests can pin it: an unseeded auto-placement puts the capital somewhere different
   * on every run, which silently turns any distance-sensitive assertion downstream (march paths,
   * `findCoord(baseX + 30, …)` targets) into a coin flip — that is exactly what made
   * httpApiActionSiegeMapGaps.e2e.test.ts fail on main 2026-08-15 (`PATH_BLOCKED`) after passing on
   * the PR. Tests that care about geometry should place the capital explicitly
   * (`joinWorld(worldId, accountId, x, y)`); this hook covers the ones that must exercise the
   * auto-placement path itself.
   */
  rng?: () => number;
}
