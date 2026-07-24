// worldsvc dedicated database factory (S8-0, SLG_DESIGN §14.3). Database name notebook_wars_world, physically isolated from meta/commercial/admin.
// 7 collections: worlds / tiles / playerWorld / marches / sieges / sects / nations. Family identity/roster lives in socialsvc (see db.ts note above SectDoc);
// auction collections moved to auctionsvc's own database (§9 task 6).
// Write pattern reuses single-document atomics + rev optimistic locking (META_DESIGN §6.3). Sparse storage: only occupied/modified tiles are persisted;
// neutral tiles are computed on-the-fly by shared proceduralTile() and not stored (key to §14.2 scale).
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type {
  TileType,
  ResourceType,
  ObstacleKind,
  MarchKind,
  WorldStatus,
  SiegeOutcome,
  SettleTier,
  BuildingKey,
} from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC, troopCapFor } from '@nw/shared';
import type { Filter } from 'mongodb';

/** Defense configuration: a restricted subset of the engine LevelDefinition (P2/P5, embedded rather than a separate collection). Opaque placeholder until S8-3 wires up the engine. */
export type DefenseConfig = Record<string, unknown>;

/**
 * SLG run-time state for a single card instance in a world season (CHARACTER_CARDS_DESIGN §8.4).
 * Stored in PlayerWorldDoc.cardState; cleared on season reset with the playerWorld document.
 */
export interface CardSLGState {
  /** Current card troop count (0 ~ troopCap). Derived from base-pool (playerWorld.troops) allocation + battle casualties. */
  currentTroops: number;
  /** Injury lock expiry (ms). Card cannot be added to a team until this timestamp passes. Absent = healthy. */
  injuredUntil?: number;
  /** Team slot this card belongs to (t1..t5). Absent = not in any team. */
  teamId?: string;
}

/**
 * Army placement unit. Two shapes share this type depending on where it's stored:
 * - `TeamTemplate.army` (player-authored): `cardInstanceId` only — `unitType`/`initialHp` are derived by
 *   `resolveCardArmy` from CARD_DEFS + `cardState[cardInstanceId].currentTroops` at siege time. An entry
 *   without a resolvable `cardInstanceId` is invalid and never persisted (`sanitizeCardArmy` drops it on
 *   save/read — no raw unitType format is accepted here).
 * - `MarchDoc.army` / `SiegeDoc.attackerArmy` (resolved snapshots): `unitType`/`initialHp` populated directly
 *   by `synthesizeArmy` for flat-troop marches that never attached a team (no `cardInstanceId` involved).
 */
export interface ArmyEntry {
  /** Card instance id. When present, unitType is derived from CARD_DEFS at siege time. */
  cardInstanceId?: string;
  /** Unit type string; populated on synthesized (flat-troop) army snapshots, absent on card-based entries. */
  unitType?: string;
  col: number;
  row: number;
  /** Troop allocation; populated on synthesized army snapshots. On card-based entries, derived from cardState at siege time. */
  initialHp?: number;
}

/** Attack formation template (team, §16.2). Up to SIEGE_TEAM_CAP teams; one team is attached on march → army snapshot goes into MarchDoc. */
export interface TeamTemplate {
  id: string;   // slot id ('t1'..'t5')
  name: string;
  army: ArmyEntry[];
  /**
   * 'move' / occupy post-battle disposition (2026-07-23): when FALSE or absent (default), a team that arrives
   * on a tile — via a 'move' order, or by winning an occupy hold — STAYS stationed on that tile (idle in the
   * field). When TRUE, the team instead marches home after the objective completes (a 'return' leg refunds its
   * troops to the pool and frees the slot). Default off because "stay in place" is the more natural 三国-style
   * behavior (user decision 2026-07-23).
   */
  autoReturn?: boolean;
}

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
  rev: number;
}

/** Occupied or modified tiles (neutral default tiles are not persisted; computed by proceduralTile). */
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
  garrison?: number;
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

/** Training queue entry (S8-2). Each batch queues independently; scheduler converts to troop strength when completeAt is reached. */
export interface TrainingEntry {
  qty: number;       // quantity trained in this batch
  inkCost: number;   // ink already deducted (no refund needed on dequeue)
  startAt: number;   // ms epoch
  completeAt: number; // ms epoch (scheduler adds troops to troops and removes entry when reached)
}

/** Build queue entry (SLG_CITY_DESIGN §4). Mirrors TrainingEntry: chained scheduling, scheduler applies the level when completeAt is reached. */
export interface BuildQueueEntry {
  key: BuildingKey;   // which building is being upgraded
  toLevel: number;    // target level after this upgrade completes
  startAt: number;    // ms epoch
  completeAt: number; // ms epoch (scheduler $inc buildings[key] and removes entry when reached)
}

/** Player state in a given world (lazy resource settlement: stores aggregate yieldRate + lastTickAt, computes delta on read, no per-tile tick). */
export interface PlayerWorldDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  troops: number;
  troopCap: number;
  resources: Record<ResourceType, number>;
  yieldRate: Record<ResourceType, number>; // hourly yield rate (updated on tile capture/loss)
  lastTickAt: number; // ms, lazy settlement anchor
  mainBaseTile?: string;
  defense?: DefenseConfig; // main base defense (P5, embedded)
  teams?: TeamTemplate[];  // attack formation templates (G3-2c, ≤ SIEGE_TEAM_CAP teams)
  /**
   * ADR-026: per-team defence run-time state. A team that loses a defensive wave is marked injured (injuredUntil = now + SLG_TEAM_INJURY_MS)
   * and never defends until healed. Keyed by team id ('t1'..'t5'). Distinct from CC-3 card-level cardState[].injuredUntil.
   */
  teamState?: Record<string, { injuredUntil?: number }>;
  familyId?: string;
  trainingQueue?: TrainingEntry[]; // training queue (S8-2, ≤ TROOP_TRAIN_QUEUE_MAX entries)
  hasBattlePass?: boolean;         // current season battle pass (S8-8, cleared on season reset)
  /** Home-city building levels (SLG_CITY_DESIGN; desk defaults to 1, others to 0 when absent). Season-scoped — cleared with the doc on resetSeason. */
  buildings?: Partial<Record<BuildingKey, number>>;
  /** Build queue (SLG_CITY_DESIGN §4, ≤ BUILD_QUEUE_SLOTS entries; chained by completeAt). */
  buildQueue?: BuildQueueEntry[];
  /** CC-3: per-card SLG run-time state (currentTroops / injuredUntil / teamId). Cleared on season reset. */
  cardState?: Record<string, CardSLGState>;
  /** Per-shop-item daily purchase counter (SLG_DESIGN §7.2, 2026-07-15). day = UTC calendar day number (floor(ms / 86400000)); count resets whenever day advances. Absent = 0 purchases so far. */
  shopPurchaseCounts?: Record<string, { day: number; count: number }>;
  rev: number;
}

export interface MarchDoc {
  _id: string; // marchId
  worldId: string;
  ownerId: string;
  fromTile: string;
  toTile: string;
  kind: MarchKind;
  troops: number;
  /** Attacker formation snapshot (G3-2c, copied from TeamTemplate.army when attaching a team; the team can be edited after marching without affecting troops already en route). */
  army?: ArmyEntry[];
  /** ADR-026: which team slot ('t1'..'t5') this march deployed. A team referenced by an active (non-recalled) march is "out" and skipped as a defender. */
  teamId?: string;
  /** Remaining morale (0..MARCH_MORALE_MAX) computed once at departure from path length (1 lost per tile moved). Bound to this march instance only; scales combat power on arrival (moraleCombatMultiplier). Absent on legacy docs → treated as full (MARCH_MORALE_MAX). */
  morale?: number;
  departAt: number;
  arriveAt: number;
  status: 'marching' | 'arrived' | 'recalled';
  rev: number;
}

/**
 * NOTE (P4 follow-up, SLG_DESIGN §8.2): worldsvc used to keep its own `families`/`familyMembers` mirror
 * (world-scoped FamilyDoc/FamilyMemberDoc). That mirror's writer (worldsvc's familyService.ts) was deleted
 * in the P4 family→socialsvc migration and never replaced — the collections were 100% dead (never populated),
 * silently breaking sect create/join/message and family-vision-sharing for every real player. Removed here;
 * family identity/roster now comes from socialsvc (WorldSocialsvcClient), per-world membership comes from
 * PlayerWorldDoc.familyId (already mirrored once at joinWorld, SS7), and sectId is mirrored onto socialsvc's
 * FamilyDoc (worldsvc remains the authoritative writer via WorldSocialsvcClient.setSect).
 */

/** Sect (S8-4b, §2.1/§8.2): a faction organisation composed of families within a region. Members = families whose sectId (mirrored on socialsvc's FamilyDoc) points to this sect. */
export interface SectDoc {
  _id: string; // sectId = `s:{worldId}:{TAG}`
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string; // sect-leader family
  leaderId: string;       // sect-leader account (= leader of the sect-leader family), used for permission checks
  memberFamilyCount: number;
  allySectIds: string[];  // allied sects (≤ SECT_ALLY_CAP)
  prosperity: number;     // prosperity = sum of member family prosperity (G2/§17.4, aggregated and refreshed on settle/sect-creation/G6 allocation)
  /** Vote to remove the sect leader (§8.2, requires >2/3 family-leader agreement + nomination). Cleared after a leadership change or resolution. */
  removalVote?: { nomineeFamilyId: string; voterFamilyIds: string[] };
  rev: number;
}

/**
 * Family channel message (S8-4).
 * ★ ts must be stored as BSON Date (not epoch number) — MongoDB TTL only works on Date fields.
 * Convert to epoch number when reading out to the client.
 */
export interface FamilyMessageDoc {
  _id: string; // `fm:{familyId}:{ts_epoch}:{seq}`
  worldId: string;
  familyId: string;
  senderId: string;
  /** Sender nickname snapshot at send time (prevents history distortion after a name change). */
  senderName: string;
  body: string;
  /** BSON Date, TTL anchor field (must be Date not epoch, see CLAUDE.md note). */
  ts: Date;
}

/** Sect channel message (S8-4b). Same as FamilyMessageDoc: ts must be BSON Date (TTL anchor field). */
export interface SectMessageDoc {
  _id: string; // `sm:{sectId}:{ts_epoch}:{seq}`
  worldId: string;
  sectId: string;
  senderId: string;
  senderName: string;
  /** Sender's equipped title snapshot at send time (称号); absent if the sender had none. */
  title?: string;
  /** Sender's sect name snapshot at send time (宗门 — the sect itself, since the channel is sect-scoped). */
  sectName?: string;
  /** Sender's family name snapshot at send time (家族). */
  familyName?: string;
  body: string;
  ts: Date;
}

/** Nation/world public channel message (B7, §6.4). ts must be BSON Date (TTL anchor field, auto-cleared after 7 days). */
export interface NationMessageDoc {
  _id: string; // `nm:{worldId}:{ts_epoch}:{seq}`
  worldId: string;
  senderId: string;
  senderName: string;
  /** Sender's 9-digit public id snapshot (meta lookup at send time); empty if meta was unavailable. */
  senderPublicId: string;
  /** Sender's equipped title snapshot at send time (称号); absent if the sender had none. */
  title?: string;
  /** Sender's sect name snapshot at send time (宗门); absent if the sender isn't in a sect. */
  sectName?: string;
  /** Sender's family name snapshot at send time (家族); absent if the sender isn't in a family. */
  familyName?: string;
  body: string;
  ts: Date;
}

export interface SiegeDoc {
  _id: string; // siegeId
  worldId: string;
  /** Attacking march's _id — lets the client correlate the resolved siege back to its march
   * token (e.g. to play an attack animation before tearing the token down). */
  marchId: string;
  attackerId: string;
  defenderId?: string;
  tile: string;
  outcome: SiegeOutcome;
  replayRef?: string;
  recomputed: boolean;
  ts: number;
  /**
   * G3-2c replay spectator: persists the inputs of the authoritative battle (seed + both sides' formations + tile level).
   * The client uses this to reconstruct buildSiegeBattle and headless-replay with the same seed → exactly reproduces
   * the battle worldsvc ran (pure presentation, not authoritative).
   * May be absent for legacy battle reports / cheap-settle fallback paths (replay degrades to unavailable).
   */
  seed?: number;
  attackerArmy?: ArmyEntry[];
  defenderConfig?: DefenseConfig | null;
  tileLevel?: number;
}

/**
 * ADR-026: pending delayed building-HP hit. Written when an attacker clears a building's garrison (wave battle won, or no defenders present);
 * the scheduler settles it at `dueAt` (= win time + SLG_SIEGE_DAMAGE_DELAY_MS), deducting `damage` from the target building's HP and capturing it at HP≤0.
 * Idempotent by _id (siegeId of the winning siege). Deleted after settlement.
 */
export interface SiegeDamageDoc {
  _id: string;          // = siegeId of the victorious siege (idempotency key)
  worldId: string;
  attackerId: string;
  defenderId?: string;  // building owner (absent for ownerless PvE buildings)
  tile: string;         // target building tile (anchor for a main base)
  isBase: boolean;      // true → main base (HP≤0 triggers passiveRelocate); false → territory/level tile (HP≤0 → hand over)
  damage: number;       // attacking team's siege value to subtract from building HP
  attackerSurvivors: number; // attacker surviving troops, refunded / used as new garrison on capture
  familyId?: string;    // attacker family (activity/nation bookkeeping at settlement)
  dueAt: number;        // ms; scheduler settles when now ≥ dueAt
}

/**
 * ADR-037 (§5.4): pending occupation hold. Written when an occupy (or expelling attack/occupy) march wins its PvE
 * battle against a neutral tile's system garrison; the scheduler finalizes ownership at `dueAt` (= win time +
 * OCCUPY_HOLD_SEC*1000) via `processDueOccupations`. `_id` = the target tileId (mirrors the tile 1:1 — at most one
 * pending hold per tile at a time; an expelling march deletes/replaces this doc atomically instead of stacking).
 * Idempotency/race-safety mirrors SiegeDamageDoc: claimed via findOneAndDelete, re-validated against the tile's
 * current `contestedBy` before writing ownership.
 */
export interface OccupationDoc {
  _id: string;          // = tileId (one pending hold per tile)
  worldId: string;
  ownerId: string;       // pending occupier accountId
  familyId?: string;
  tile: string;          // same value as _id, kept for readability/parity with SiegeDamageDoc.tile
  x: number;
  y: number;
  level: number;
  resType?: ResourceType;
  garrison: number;      // surviving troops; becomes the tile's garrison on settlement
  dueAt: number;         // ms; scheduler settles when now >= dueAt
  /** ADR-026 §2 / idle-team gate (2026-07-15): team slot that won this hold, carried over from MarchDoc.teamId so the team stays "out" through the occupation countdown, not just in transit. */
  teamId?: string;
}

/**
 * Stationed team (2026-07-23): a team parked on a tile, standing idle "out in the field" until the owner
 * moves or recalls it. Written when a 'move' march arrives (combatMarch.applyMove) or when an occupy hold
 * settles for a team whose `autoReturn` is off (occupation.settleOccupation). Keyed by tileId (one stationed
 * team per tile). Keeps the team "busy" via the same partial-unique {worldId,ownerId,teamId} index the march
 * idle-gate relies on, so a stationed team can't accept a fresh order until recalled. The tile's own ownership
 * is orthogonal — a team may stand on its own territory OR on an unclaimed neutral tile it does not own.
 */
export interface StationedDoc {
  _id: string;          // = tileId (one stationed team per tile)
  worldId: string;
  ownerId: string;      // the team's owner accountId
  familyId?: string;
  tile: string;         // same value as _id (parity with OccupationDoc.tile)
  x: number;
  y: number;
  teamId: string;       // team slot ('t1'..'t5') parked here
  army: ArmyEntry[];    // army snapshot (card entries; strength lives in cardState.currentTroops)
  troops: number;       // committed troop count carried when the team arrived (display / recall refund for flat armies)
  sinceAt: number;      // ms the team arrived and became stationed
}

/** Nation document (S8-6.5). One record per capital; ownerId/nationName absent when unclaimed. */
export interface NationDoc {
  _id: string;            // `nation:{worldId}:{capitalIdx}`
  worldId: string;
  capitalIdx: number;     // 0~9, province index (6 outer + 3 resource + 1 core, ADR-034)
  x: number;              // capital tile x (computed by provinceCapitalPositions, written at season open)
  y: number;
  ownerId?: string;       // occupying accountId
  familyId?: string;      // occupying family
  nationName?: string;    // player-given name when founding the nation
  foundedAt?: number;     // ms
  rev: number;
}

/**
 * Season settlement history (C2/§17.2). settleSeason persists this season's ranking + prosperity snapshot, used as G6 allocation input for the next season.
 * `_id = `${worldId}:s${season}`` = idempotency key (re-entering the same season with $setOnInsert does not overwrite).
 */
export interface SeasonResultDoc {
  _id: string;
  worldId: string;
  season: number;
  settledAt: number;
  ranking: Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    id: string;                // sectId / familyId / ownerId
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
    prosperity?: number;       // prosperity snapshot at settlement (meaningful only for sect scope)
    memberFamilyIds?: string[]; // member family list (recorded only for sect scope; G6 next-season familyShard expansion input, §20 R2)
    tier: SettleTier;
  }>;
}

/**
 * G6 multi-shard season allocation (§20.2). On settle, distributes in a snake-draft order by last season's sect strength, persisting familyId→shardIndex for this season;
 * when players join next season, they are routed by looking up their account's last-season family (sect > family > random).
 * `_id = `s${season}`` (current season). shardCount can be incremented via $inc when population overflows.
 */
export interface ShardAllocationDoc {
  _id: string;        // `s${season}`
  season: number;
  shardCount: number;
  capacity: number;
  familyShard: Record<string, number>; // last-season familyId → this-season shardIndex
  createdAt: number;
}

/** G6 mid-season shard transfer cooldown tracker (§27). `_id` = accountId — one doc per account, independent
 *  of any world (survives the source shard's playerWorld doc being purged on transfer). */
export interface ShardTransferDoc {
  _id: string; // accountId
  lastTransferAt: number;
  /** Season the last transfer happened in (cooldown is season-scoped: a new season resets the clock). */
  season: number;
  fromWorldId: string;
  toWorldId: string;
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
}

/** One tile of a map template (§24 Layer A — design-time, edited via the admin map editor, not runtime state). */
export interface MapTemplateTileDoc {
  _id: string; // `${templateId}:${x}:${y}`
  templateId: string;
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** For type=obstacle only: river vs mountain art (§24 art-parity). Same optional field as MapTemplateTile. */
  obstacleKind?: ObstacleKind;
}

/**
 * Per-world terrain baseline, cloned (copied, not referenced) from a template's tiles at world-open time (§24).
 * Consumed by the runtime read path (WorldCoreMap.getMap/getTile): for a tile with no TileDoc override, this
 * baseline is the terrain, falling back to proceduralTile() only when no baseline row exists (no active template
 * at world-open). Same shape as MapTemplateTile — carry any new terrain field added there through here too.
 */
export interface MapBaselineTileDoc {
  _id: string; // `${worldId}:${x}:${y}`
  worldId: string;
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** For type=obstacle only: river vs mountain art (§24 art-parity). Cloned from MapTemplateTileDoc.obstacleKind. */
  obstacleKind?: ObstacleKind;
}

export interface WorldCollections {
  worlds: Collection<WorldDoc>;
  tiles: Collection<TileDoc>;
  playerWorld: Collection<PlayerWorldDoc>;
  marches: Collection<MarchDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
  sects: Collection<SectDoc>;
  sectMessages: Collection<SectMessageDoc>;
  nationMessages: Collection<NationMessageDoc>;
  sieges: Collection<SiegeDoc>;
  siegeDamage: Collection<SiegeDamageDoc>;
  occupations: Collection<OccupationDoc>;
  stationed: Collection<StationedDoc>;
  nations: Collection<NationDoc>;
  seasonResults: Collection<SeasonResultDoc>;
  shardAllocations: Collection<ShardAllocationDoc>;
  shardTransfers: Collection<ShardTransferDoc>;
  mapTemplates: Collection<MapTemplateDoc>;
  mapTemplateTiles: Collection<MapTemplateTileDoc>;
  mapBaselines: Collection<MapBaselineTileDoc>;
}

export interface WorldMongo {
  client: MongoClient;
  db: Db;
  collections: WorldCollections;
  ensureIndexes(): Promise<void>;
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}

export async function createWorldMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<WorldMongo> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    const safeUri = uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
    console.error(
      `[world-mongo] MongoDB connection failed (uri=${safeUri}, db=${dbName}): ` +
        `${(err as Error).message}. Ensure the database is running and NW_WORLD_MONGO_URI/NW_MONGO_URI is correct.`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: WorldCollections = {
    worlds: db.collection<WorldDoc>('worlds'),
    tiles: db.collection<TileDoc>('tiles'),
    playerWorld: db.collection<PlayerWorldDoc>('playerWorld'),
    marches: db.collection<MarchDoc>('marches'),
    familyMessages: db.collection<FamilyMessageDoc>('familyMessages'),
    sects: db.collection<SectDoc>('sects'),
    sectMessages: db.collection<SectMessageDoc>('sectMessages'),
    nationMessages: db.collection<NationMessageDoc>('nationMessages'),
    sieges: db.collection<SiegeDoc>('sieges'),
    siegeDamage: db.collection<SiegeDamageDoc>('siegeDamage'),
    occupations: db.collection<OccupationDoc>('occupations'),
    stationed: db.collection<StationedDoc>('stationed'),
    nations: db.collection<NationDoc>('nations'),
    seasonResults: db.collection<SeasonResultDoc>('seasonResults'),
    shardAllocations: db.collection<ShardAllocationDoc>('shardAllocations'),
    shardTransfers: db.collection<ShardTransferDoc>('shardTransfers'),
    mapTemplates: db.collection<MapTemplateDoc>('mapTemplates'),
    mapTemplateTiles: db.collection<MapTemplateTileDoc>('mapTemplateTiles'),
    mapBaselines: db.collection<MapBaselineTileDoc>('mapBaselines'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.worlds.createIndex({ status: 1 });
    // Auto-settle due scan (§17.14): scheduler finds active worlds whose season clock elapsed (status='active', settleAt ≤ now).
    await collections.worlds.createIndex({ status: 1, settleAt: 1 });
    // Viewport range query (P6: spatial query v1 uses Mongo {worldId,x,y} range query; Redis bucket cache is a later addition).
    await collections.tiles.createIndex({ worldId: 1, x: 1, y: 1 });
    await collections.tiles.createIndex({ ownerId: 1 });
    await collections.tiles.createIndex({ familyId: 1 });
    await collections.playerWorld.createIndex({ worldId: 1, accountId: 1 });
    await collections.playerWorld.createIndex({ familyId: 1 });
    await collections.marches.createIndex({ worldId: 1, ownerId: 1 });
    // On-time scan fallback (primary scheduling uses Redis ZSET, S8-2; degrades to Mongo polling without Redis).
    await collections.marches.createIndex({ arriveAt: 1 });
    // Idle-team invariant (2026-07-22): a team may hold only ONE active state. Team-based marches are the only
    // docs carrying `teamId` (flat-pool marches have none; recall rewrites the SAME doc into a return leg; arrived
    // marches are deleted) — so a partial-unique index on {worldId,ownerId,teamId} atomically forbids a second
    // in-flight march for the same team, closing the check-then-insert race in combatMarch.startMarch that the
    // pre-insert findOne cannot. Wrapped best-effort: if a pre-existing duplicate (from the very bug this fixes)
    // blocks the build, log and continue — marches are transient (arrive within minutes) so a later boot succeeds;
    // startMarch's E11000→TEAM_BUSY catch and the findOne pre-check still guard in the meantime.
    try {
      await collections.marches.createIndex(
        { worldId: 1, ownerId: 1, teamId: 1 },
        { unique: true, partialFilterExpression: { teamId: { $exists: true } } },
      );
    } catch (e) {
      console.warn('[worldsvc] marches team-unique index not built (duplicate active team march?); will retry on next boot:', e);
    }
    await collections.familyMessages.createIndex({ familyId: 1, ts: -1 });
    // TTL: auto-delete after 7 days (ts is a BSON Date field; Mongo TTL only works on Date).
    await collections.familyMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
    // Sect (S8-4b): TAG unique within worldId; listed by worldId; member families queried via socialsvc's family.sectId mirror.
    await collections.sects.createIndex({ worldId: 1, tag: 1 }, { unique: true });
    await collections.sects.createIndex({ worldId: 1 });
    await collections.sectMessages.createIndex({ sectId: 1, ts: -1 });
    await collections.sectMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
    // Nation/world public channel (B7): paginated by worldId + time descending; same 7-day TTL as family/sect channels.
    await collections.nationMessages.createIndex({ worldId: 1, ts: -1 });
    await collections.nationMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
    await collections.sieges.createIndex({ worldId: 1, ts: -1 });
    await collections.sieges.createIndex({ attackerId: 1 });
    // ADR-026: delayed building-HP settlement scan (mirrors marches.arriveAt: due-time polling; Redis ZSET optional later).
    await collections.siegeDamage.createIndex({ dueAt: 1 });
    await collections.siegeDamage.createIndex({ tile: 1 });
    // ADR-037 (§5.4): occupation-hold settlement scan (mirrors siegeDamage.dueAt: due-time polling; Redis ZSET optional wake-up hint).
    await collections.occupations.createIndex({ dueAt: 1 });
    // Stationed teams (2026-07-23): listed per owner (getStationed); the partial-unique {worldId,ownerId,teamId}
    // is the counterpart of the marches team-unique index — together they enforce "a team holds ONE active state"
    // across in-transit marches, occupation holds, and now field stationing. Wrapped best-effort like the marches one.
    await collections.stationed.createIndex({ worldId: 1, ownerId: 1 });
    try {
      await collections.stationed.createIndex(
        { worldId: 1, ownerId: 1, teamId: 1 },
        { unique: true },
      );
    } catch (e) {
      console.warn('[worldsvc] stationed team-unique index not built (duplicate stationed team?); will retry on next boot:', e);
    }
    // Nation: unique by capital index within worldId
    await collections.nations.createIndex({ worldId: 1, capitalIdx: 1 }, { unique: true });
    await collections.nations.createIndex({ ownerId: 1 });
    // Season settlement history (C2/§17.2): query most recent season by worldId; G6 allocation reads last-season ranking.
    await collections.seasonResults.createIndex({ worldId: 1, season: -1 });
    // G6 multi-shard allocation (§20): retrieve this-season allocation table by season (join routing looks up familyShard).
    await collections.shardAllocations.createIndex({ season: 1 });
    // G6 mid-season transfer cooldown (§27): _id is already accountId (unique by definition); no secondary index needed.
    // Map templates (§24): viewport bbox reads scan by templateId + x/y range; active lookup for the "which template do new worlds clone" query.
    await collections.mapTemplateTiles.createIndex({ templateId: 1, x: 1, y: 1 });
    await collections.mapTemplates.createIndex({ active: 1 });
    await collections.mapBaselines.createIndex({ worldId: 1, x: 1, y: 1 });
  }

  /**
   * One-time data migrations run once at boot after ensureIndexes.
   *
   * Troop-pool unification (2026-07-21): the old `baseTroopStock` (card-army reserve, init 10000) and
   * `troops` (map pool, init/cap = troopCapFor) were two disconnected buckets — training filled `troops`
   * while distributeTroops drew from `baseTroopStock`, so trained troops could never reach cards. They are
   * now unified onto `troops` (basecap raised to 10000). Fold any legacy `baseTroopStock` into `troops`
   * (clamped to a freshly-recomputed troopCap, which also picks up the raised TROOP_CAP_BASE for existing
   * docs whose stored troopCap froze at the old 2000) and drop the field. Near-lossless; no back-compat shim.
   */
  async function runMigrations(): Promise<void> {
    const legacyFilter = { baseTroopStock: { $exists: true } } as unknown as Filter<PlayerWorldDoc>;
    const cursor = collections.playerWorld.find(legacyFilter);
    let migrated = 0;
    for await (const doc of cursor) {
      const legacyStock = (doc as { baseTroopStock?: number }).baseTroopStock ?? 0;
      const newCap = troopCapFor(doc.buildings);
      const newTroops = Math.min(newCap, (doc.troops ?? 0) + legacyStock);
      await collections.playerWorld.updateOne(
        { _id: doc._id },
        {
          $set: { troops: newTroops, troopCap: newCap },
          $unset: { baseTroopStock: '' } as never,
          $inc: { rev: 1 },
        },
      );
      migrated++;
    }
    if (migrated > 0) console.log(`[world-mongo] troop-pool unification: folded baseTroopStock into troops for ${migrated} players`);
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    runMigrations,
    close: () => client.close(),
  };
}
