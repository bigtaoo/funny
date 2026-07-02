// worldsvc dedicated database factory (S8-0, SLG_DESIGN §14.3). Database name notebook_wars_world, physically isolated from meta/commercial/admin.
// 8 collections: worlds / tiles / playerWorld / marches / auctions / sieges / sects / nations. Family identity/roster lives in socialsvc (see db.ts note above SectDoc).
// Write pattern reuses single-document atomics + rev optimistic locking (META_DESIGN §6.3). Sparse storage: only occupied/modified tiles are persisted;
// neutral tiles are computed on-the-fly by shared proceduralTile() and not stored (key to §14.2 scale).
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type {
  TileType,
  ResourceType,
  MarchKind,
  WorldStatus,
  AuctionStatus,
  SiegeOutcome,
  SettleTier,
  BuildingKey,
} from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC } from '@nw/shared';

/** Defense configuration: a restricted subset of the engine LevelDefinition (P2/P5, embedded rather than a separate collection). Opaque placeholder until S8-3 wires up the engine. */
export type DefenseConfig = Record<string, unknown>;

/**
 * SLG run-time state for a single card instance in a world season (CHARACTER_CARDS_DESIGN §8.4).
 * Stored in PlayerWorldDoc.cardState; cleared on season reset with the playerWorld document.
 */
export interface CardSLGState {
  /** Current card troop count (0 ~ troopCap). Derived from baseTroopStock allocation + battle casualties. */
  currentTroops: number;
  /** Injury lock expiry (ms). Card cannot be added to a team until this timestamp passes. Absent = healthy. */
  injuredUntil?: number;
  /** Team slot this card belongs to (t1..t5). Absent = not in any team. */
  teamId?: string;
}

/**
 * Army placement unit (CC-3: cardInstanceId replaces unitType; unitType is derived by the engine from CARD_DEFS;
 * initialHp is derived from cardState[cardInstanceId].currentTroops at siege time).
 * Backward-compat: unitType / initialHp are kept optional for legacy replay data in SiegeDoc.attackerArmy.
 */
export interface ArmyEntry {
  /** Card instance id (CC-3). When present, unitType is derived from CARD_DEFS at siege time. */
  cardInstanceId?: string;
  /** Legacy unit type string (pre-CC-3); used when cardInstanceId is absent (synthesized army / replay data). */
  unitType?: string;
  col: number;
  row: number;
  /** Legacy troop allocation (pre-CC-3 / replay snapshot). In CC-3 paths, derived from cardState at siege time. */
  initialHp?: number;
}

/** Attack formation template (team, §16.2). Up to SIEGE_TEAM_CAP teams; one team is attached on march → army snapshot goes into MarchDoc. */
export interface TeamTemplate {
  id: string;   // slot id ('t1'..'t5')
  name: string;
  army: ArmyEntry[];
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
  protectedUntil?: number; // ms
  watchtower?: boolean; // watchtower (§18 G5 V2): once built, this tile becomes a large-radius persistent vision source; lost together with TileDoc when tile is lost
  /** ADR-025: true on the 8 non-anchor cells of a 3×3 main-base footprint (the anchor omits this). Ring cells hold ownerId + protection but no garrison/yield. */
  baseRing?: boolean;
  /** ADR-025: on ring cells only — the tileId of this base's anchor, so a siege landing on a ring cell resolves against the anchor's garrison/defense. Anchor omits this. */
  baseAnchor?: string;
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
  /** CC-3: base troop stock available to distribute to card instances. Initialised to BASE_TROOP_STOCK_INITIAL on joinWorld. */
  baseTroopStock?: number;
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

export interface AuctionDoc {
  _id: string; // auctionId
  worldId: string;
  sellerId: string;
  itemType: string;
  item: Record<string, unknown>;
  qty: number;
  price: number; // fixed-price: unit transaction price; auction: meaningless after bidding starts (use startPrice/topBid), retained for backward-compatible browse sorting
  currency: string;
  designatedBuyerId?: string;
  expireAt: number; // ms (expiry settled by scanner: refund seller escrow / finalize auction bid; not TTL auto-delete, see ensureIndexes note)
  status: AuctionStatus;
  buyerId?: string;
  /** Transaction timestamp ms (written when status→sold). Anomaly auditing (D/G7) windows by this; legacy documents fall back to parsing listing ts from _id. */
  soldAt?: number;
  // ── B Auction bidding (AUCTION_DESIGN §4.B). saleMode defaults to 'fixed' (backward-compatible with existing fixed-price listings) ──
  saleMode?: 'fixed' | 'auction';
  startPrice?: number;   // auction starting total price (whole batch, not per-unit)
  buyoutPrice?: number;  // auction buyout total price (optional)
  topBid?: { bidderId: string; amount: number; ts: number }; // current highest bid (total price, coins already escrowed)
  rev: number;
}

/** C Daily quota counter (AUCTION_DESIGN §4.C). _id = `${worldId}:${accountId}:${dayKey}`, TTL auto-cleared. */
export interface AuctionDailyDoc {
  _id: string;
  worldId: string;
  accountId: string;
  dayKey: string; // server UTC day boundary YYYY-MM-DD
  lists: number;  // new listings created today
  buys: number;   // purchases / bids placed today
  expiresAt: Date; // BSON Date, TTL anchor field
}

/** G Price guardrail sliding window (AUCTION_DESIGN §4.G). _id = `${worldId}:${category}`, stores the last N transaction unit prices. */
export interface AuctionPriceDoc {
  _id: string;
  worldId: string;
  category: string; // material category (material:scrap…); equipment category pending A
  prices: number[]; // last N transaction unit prices (newest at tail, length ≤ AUCTION_PRICE_WINDOW_N)
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
  body: string;
  ts: Date;
}

/** Nation/world public channel message (B7, §6.4). ts must be BSON Date (TTL anchor field, auto-cleared after 7 days). */
export interface NationMessageDoc {
  _id: string; // `nm:{worldId}:{ts_epoch}:{seq}`
  worldId: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: Date;
}

export interface SiegeDoc {
  _id: string; // siegeId
  worldId: string;
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

/** Nation document (S8-6.5). One record per capital; ownerId/nationName absent when unclaimed. */
export interface NationDoc {
  _id: string;            // `nation:{worldId}:{capitalIdx}`
  worldId: string;
  capitalIdx: number;     // 0~9, index into CAPITAL_FRACTIONS
  x: number;              // capital tile x (computed by capitalPositions, written at season open)
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

export interface WorldCollections {
  worlds: Collection<WorldDoc>;
  tiles: Collection<TileDoc>;
  playerWorld: Collection<PlayerWorldDoc>;
  marches: Collection<MarchDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
  sects: Collection<SectDoc>;
  sectMessages: Collection<SectMessageDoc>;
  nationMessages: Collection<NationMessageDoc>;
  auctions: Collection<AuctionDoc>;
  auctionDaily: Collection<AuctionDailyDoc>;
  auctionPrices: Collection<AuctionPriceDoc>;
  sieges: Collection<SiegeDoc>;
  siegeDamage: Collection<SiegeDamageDoc>;
  nations: Collection<NationDoc>;
  seasonResults: Collection<SeasonResultDoc>;
  shardAllocations: Collection<ShardAllocationDoc>;
}

export interface WorldMongo {
  client: MongoClient;
  db: Db;
  collections: WorldCollections;
  ensureIndexes(): Promise<void>;
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
    auctions: db.collection<AuctionDoc>('auctions'),
    auctionDaily: db.collection<AuctionDailyDoc>('auctionDaily'),
    auctionPrices: db.collection<AuctionPriceDoc>('auctionPrices'),
    sieges: db.collection<SiegeDoc>('sieges'),
    siegeDamage: db.collection<SiegeDamageDoc>('siegeDamage'),
    nations: db.collection<NationDoc>('nations'),
    seasonResults: db.collection<SeasonResultDoc>('seasonResults'),
    shardAllocations: db.collection<ShardAllocationDoc>('shardAllocations'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.worlds.createIndex({ status: 1 });
    // Viewport range query (P6: spatial query v1 uses Mongo {worldId,x,y} range query; Redis bucket cache is a later addition).
    await collections.tiles.createIndex({ worldId: 1, x: 1, y: 1 });
    await collections.tiles.createIndex({ ownerId: 1 });
    await collections.tiles.createIndex({ familyId: 1 });
    await collections.playerWorld.createIndex({ worldId: 1, accountId: 1 });
    await collections.playerWorld.createIndex({ familyId: 1 });
    await collections.marches.createIndex({ worldId: 1, ownerId: 1 });
    // On-time scan fallback (primary scheduling uses Redis ZSET, S8-2; degrades to Mongo polling without Redis).
    await collections.marches.createIndex({ arriveAt: 1 });
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
    await collections.auctions.createIndex({ worldId: 1, itemType: 1, status: 1 });
    await collections.auctions.createIndex({ sellerId: 1 });
    await collections.auctions.createIndex({ designatedBuyerId: 1 });
    // Note: auctions.expireAt is intentionally NOT a TTL index — expiry requires settlement (refund seller escrow); handled by the scanner using this index;
    // TTL auto-delete would discard escrowed goods before settlement (U13). The "TTL {expireAt}" entry in §14.3 is changed to a regular index per this implementation decision.
    await collections.auctions.createIndex({ expireAt: 1 });
    // C Daily quota: TTL auto-cleared (expiresAt is BSON Date; Mongo TTL only works on Date).
    await collections.auctionDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // G Price sliding window: _id = `${worldId}:${category}` direct lookup, no additional index needed (primary key sufficient).
    await collections.sieges.createIndex({ worldId: 1, ts: -1 });
    await collections.sieges.createIndex({ attackerId: 1 });
    // ADR-026: delayed building-HP settlement scan (mirrors marches.arriveAt: due-time polling; Redis ZSET optional later).
    await collections.siegeDamage.createIndex({ dueAt: 1 });
    await collections.siegeDamage.createIndex({ tile: 1 });
    // Nation: unique by capital index within worldId
    await collections.nations.createIndex({ worldId: 1, capitalIdx: 1 }, { unique: true });
    await collections.nations.createIndex({ ownerId: 1 });
    // Season settlement history (C2/§17.2): query most recent season by worldId; G6 allocation reads last-season ranking.
    await collections.seasonResults.createIndex({ worldId: 1, season: -1 });
    // G6 multi-shard allocation (§20): retrieve this-season allocation table by season (join routing looks up familyShard).
    await collections.shardAllocations.createIndex({ season: 1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
