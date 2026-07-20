// Mongo client factory + collection handles (SERVER_API.md §5, META_DESIGN.md §6.3).
// Deploy with a single-node replica set to unlock cross-collection transactions; wallet/delivery use single-document atomic updates.
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type { SaveData, EquipmentInstance, CardInstance } from './types';
import type { StatKey } from './achievements';
import type { LadderSeasonDoc, LadderSeasonSnapshotDoc } from './season';
import type { EventTaskDef, EventRewardDef, EventTaskProgress } from './events';
import type { ChatRegion } from './chatFilter';

// —— Collection document shapes ——
export interface SaveDoc {
  _id: string; // accountId
  save: SaveData;
  rev: number;
}

export interface AccountDoc {
  _id: string; // accountId
  createdAt: number;
  // —— Credentials (each optional, at least one required) ——
  deviceId?: string; // anonymous device (sparse unique)
  openid?: string; // WeChat (sparse unique)
  password?: {
    // email/username password (ACCOUNT_DESIGN §2.2)
    loginId: string; // normalized email/username (sparse unique)
    hash: string; // scrypt (shared/password.ts)
  };
  oauth?: { provider: string; sub: string }[]; // third-party (provider+sub unique, SA-2)
  // —— Profile ——
  displayName?: string;
  /**
   * Whether the player has deliberately chosen their display name — set on password registration with an
   * explicit name, or after any rename. Absent/false means the current `displayName` is a system-assigned
   * default (lazy backfill via {@link ensureDisplayName}, or never set): the player is entitled to one
   * **free** rename (see metaserver profileRename). Once true, renames cost RENAME_COST coins.
   */
  nameChosen?: boolean;
  /** 9-digit numeric public id (globally unique, used for player communication/reports). Lazily generated on first auth. */
  publicId?: string;
  /**
   * Compliance region code (SOC10). Lazily inferred and refreshed from the `Accept-Language` header on auth (best-effort).
   * Private-chat sensitive-word filtering uses the sender's region to select the word list; absent / legacy accounts → `'global'` (basic word list only).
   */
  region?: ChatRegion;
  /** C4 PvE anti-cheat: suspicious attempt count + ban flag (account level, used to block auth). */
  flags?: {
    pveWarnings?: number; // cumulative PvE suspicious attempt count (visibility only, no longer a ban trigger — see AntiCheatReviewDoc pve_reject)
    banned?: boolean;     // set only via ops manual ban (anticheat.action) after human review; auth returns ACCOUNT_BANNED
    gdprConsent?: boolean; // C5-c GDPR consent (must be true to record analytics events)
  };
  /** C5-b soft-delete timestamp; once set, auth returns ACCOUNT_DELETED and data is asynchronously purged after 7 days. */
  deletedAt?: number;
}

/**
 * Whether the account is anonymous: only a device credential attached, no recoverable credentials (password/oauth/wx).
 * Multiplayer/store/recharge require isAnonymous=false (ACCOUNT_DESIGN §2.2). Computed on-the-fly, not persisted, to avoid drift.
 */
export function isAnonymousAccount(doc: AccountDoc): boolean {
  return !doc.openid && !doc.password && !(doc.oauth && doc.oauth.length > 0);
}

// gachaHistory / walletLog / iapReceipts have been moved out of the meta database (S5, COMMERCIAL_DESIGN §8.1):
// wallet/ledger/gacha history/recharge receipts now live in the commercial service's dedicated database `notebook_wars_commercial`
// as wallets/ledger/orders/recharges/gachaHistory. meta no longer owns these collections.

/**
 * Inline replay (S1-RP): seed + config + non-empty frame log, no state.
 * Mirrors `contracts/replay.proto`; `frames[].cmds[].commands` are BSON binary
 * (opaque game.proto bytes — the server never decodes them, M12).
 */
export interface MatchReplayDoc {
  engineVersion: number;
  mode: string;
  seed: string;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: unknown }[] }[];
  meta: { recordedAt: number; winner: number };
  /** Deck loadout at match start (PVP_LOADOUT_DESIGN §6.2); absent when the match had no loadout gating. */
  decks?: { top: string[]; bottom: string[] };
}

export interface MatchDoc {
  roomId: string;
  mode: string;
  seed: string;
  /**
   * Snapshot of each side's identity + ELO settlement result at archive time (used by match history `GET /match/history`).
   * `displayName`/`publicId` are snapshots at the moment of archival (renames are not back-filled); `eloDelta`/`eloAfter`
   * only exist for ranked matches that settled successfully (absent for friendly / voided matches).
   */
  players: {
    side: number;
    accountId: string;
    displayName?: string;
    publicId?: string;
    eloDelta?: number;
    eloAfter?: number;
  }[];
  winner: number;
  reason: string;
  hashOk: boolean;
  /** C3: set to true when hash is inconsistent and the peer judge could not intervene (visible in admin /admin/mismatches). */
  hashMismatch?: boolean;
  /** Pointer to externally-stored replay (large matches); reserved, not yet used. */
  replayRef?: string;
  /**
   * Embedded replay (small matches, gzip-compressed JSON of {@link MatchReplayDoc} — frames[].cmds[].commands
   * are base64 opaque inside, unchanged, M12). Decompress only when the full replay content is actually
   * needed (peer-judge dispute, anti-cheat audit sample) via `@nw/shared`'s decompressReplayDoc — never on
   * the per-match write path (that's the whole point of storing it compressed).
   */
  replayGz?: Buffer;
  /**
   * Peer-judge conviction flag (Phase C): when a ranked hash mismatch is resolved by a third-party headless re-simulation,
   * the side whose result disagrees with the judge is declared the loser and this flag is set. `judgeAccountId` is the re-simulation judge (for auditing).
   */
  cheat?: { side: number; accountId: string; judgeAccountId?: string };
  /**
   * Achievement PvP stat reported values (comparison baseline for S9-7 L2 offline audit, ranked only). Per-side: side number as string key →
   * the kill/cast deltas for that side that were **credited** after L1 sanitisation (i.e. the value computed by `statDeltaForSide` and accrued).
   * `pvp.wins` excluded (server-computed, not audited). Server-side read-only, not included in wire schema, not sent to clients.
   */
  reportedStats?: Record<string, Partial<Record<StatKey, number>>>;
  /**
   * Achievement PvP stat offline audit result (S9-7 L2, §4.4). **Presence acts as an idempotency gate** — audit batches only query matches where `audited` is absent.
   * `verdict`: `clean` = reported matches re-simulation / `overclaim` = a side over-reported (rolled back + suspicion escalated + added to review queue) /
   * `skipped` = no judge available / re-simulation failed / old engine (benefit-of-doubt, no conviction). `overclaim` records the actual per-side rollback amount.
   */
  audited?: {
    ts: number;
    verdict: 'clean' | 'overclaim' | 'skipped';
    judgeAccountId?: string;
    overclaim?: Record<string, Partial<Record<StatKey, number>>>;
  };
  ts: number;
  /**
   * TTL auto-expiry anchor (7 days, storage cleanup — Atlas ran near capacity at 39K docs / 296MB with no cleanup;
   * bots have only been live a week so a longer window bought no headroom).
   * Only set for non-disputed matches (no `hashMismatch`, no `cheat`); disputed matches are kept indefinitely for ops
   * review / anti-cheat audit trail. Absent on old pre-migration docs until the one-off backfill script runs.
   */
  expireAt?: Date;
}

/**
 * Deck-composition-level PvP win-rate counter (BALANCE data pipeline P1): one row per card per UTC day per mode.
 * Incremented at match-report time from `MatchDoc.replay.decks` (only present for restricted-deck-pool matches) — every card in a
 * side's deck gets `games` credited, and `wins` too if that side won. Disputed matches (hashMismatch/cheat) are excluded rather than
 * counted, matching the existing "auto-clean, don't hard-reject" data hygiene approach. Deck-level only — this cannot tell you how a
 * card was actually played, only whether the deck holding it won; see `pvpPlaySequences` (P2, sampled replay decode) for play-by-play.
 * `_id = `${day}:${cardId}:${mode}``, naturally idempotent for the bulkWrite upsert.
 */
export interface PvpCardStatDoc {
  _id: string;
  day: string; // UTC YYYYMMDD
  cardId: string;
  mode: string; // matches MatchDoc.mode ('ranked' | 'friendly'), kept separate so casual play doesn't dilute ranked signal
  games: number;
  wins: number;
}

/**
 * Sampled replay decode (BALANCE data pipeline P2, `server/metaserver/scripts/samplePvpReplays.ts`): for a small
 * sample of matches (upsets + a random baseline — never the full volume, decoding re-simulates the whole match),
 * the per-side card-type play sequence, for spotting playstyles the offline equal-ink simulator can't model
 * (timing, combos, positioning-driven value). `_id = roomId` (one entry per sampled match, idempotent re-run).
 */
export interface PvpPlaySequenceDoc {
  _id: string; // roomId
  ts: number;
  mode: string;
  sampleReason: 'upset' | 'random';
  winnerSide: number;
  plays: { side: number; frame: number; cardType: string }[];
}

/** Daily ad cap counter (S5-5, authoritative in meta, not surfaced to client sync segment to prevent abuse). _id = `${accountId}:${dayKey}`. */
export interface AdsDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string;
  count: number;
  ts: number;
  lastAdAt?: number; // timestamp of the last ad (30-min cooldown gate)
}

/** Ad token uniqueness (C2): SHA-256 hash of adToken, TTL 48h auto-expiry. _id = tokenHash. */
export interface AdsTokenDoc {
  _id: string;   // SHA-256(adToken) hex
  accountId: string;
  ts: number;
  expireAt: Date; // TTL anchor (48h)
}

/**
 * External replay storage for large matches (S1-RP): when the embedded frame log exceeds the size threshold, the replay is stored in this
 * separate collection and `MatchDoc.replayRef = roomId` points here, keeping `matches` documents compact and list/history queries fast.
 * `GET /match/{roomId}/replay` checks `MatchDoc.replay` (embedded) first and falls back to this collection if absent.
 * (Still Mongo BSON binary, not an external object store / S3 — that is a future infra decision, see META_TASKS S1-RP.)
 */
export interface ReplayBlobDoc {
  _id: string; // roomId
  /** gzip-compressed JSON of {@link MatchReplayDoc}, same encoding as MatchDoc.replayGz. */
  replayGz: Buffer;
  ts: number;
  /** TTL auto-expiry anchor, mirrors the owning MatchDoc.expireAt (absent for disputed matches — see there). */
  expireAt?: Date;
}

/** PvE daily material-rewarding clear count (server-authoritative, anti-abuse). _id = `${accountId}:${dayKey}`. */
export interface PveDailyDoc {
  _id: string;
  accountId: string;
  dayKey: string;
  rewardedClears: number;
  ts: number;
}

/**
 * PvE clear replay spot-check re-simulation record (PVE_INTEGRITY §8.6 L1). Sampled clears are recorded here first (materials not yet granted,
 * progress/stars already written); the client then uploads the replay → third-party headless re-simulation via gateway → materials are granted
 * only if the re-simulated star count is >= the claimed count. status:
 * `pending` = awaiting replay, `verified` = re-simulation passed and materials granted, `unverified` = no judge available (benefit-of-doubt, materials granted),
 * `rejected` = re-simulation mismatch, materials not granted (suspicious). `pveUpgrades` is the server-authoritative blueprint snapshot at settlement time (used for re-simulation, prevents drift).
 */
export interface PveVerificationDoc {
  _id: string; // verifyId（uuid）
  accountId: string;
  levelId: string;
  /** Star count claimed by the client (pending re-simulation verification). */
  claimedStars: number;
  /** @deprecated S3-2 snapshot, replaced by unitLevels from S12 onwards (kept for backward compatibility with old records). */
  pveUpgrades: Record<string, number>;
  /** S12 server-authoritative unitLevels snapshot at settlement time (re-simulation blueprint). */
  unitLevels?: Record<string, number>;
  /** Trigger reason (audit): first | anomaly | sample. */
  reason: string;
  status: 'pending' | 'verified' | 'unverified' | 'rejected';
  /** Achievement stats reported by the client for this match (S9-3b): kill/cast counts by type, baseline for audit comparison. */
  reportedStats?: Record<string, number>;
  /** Star count from re-simulation (present when verified or rejected). */
  judgedStars?: number;
  judgeAccountId?: string;
  /**
   * Raw replay frames submitted to `/pve/verify`, archived only when the re-simulation came back `rejected`
   * (PVE_INTEGRITY_PLAN §8.6 待办) — lets ops re-examine a disputed clear after the fact instead of only
   * having the judge's verdict to go on. Absent for `verified`/`unverified` docs to keep the collection lean.
   */
  frames?: { frame: number; cmds: { side: number; commands: string }[] }[];
  endFrame?: number;
  ts: number;
}

/**
 * PvE replay re-simulation rejection audit record (S4-4): one entry written for every pveVerify judged as rejected.
 * Used by the ops admin to review suspicious account history + pveRejectCount three-strike ban audit. _id = verifyId (1-to-1 with pveVerifications).
 */
export interface PveRejectDoc {
  _id: string; // verifyId
  accountId: string;
  levelId: string;
  claimedStars: number;
  judgedStars: number;
  rejectCountAfter: number; // pveRejectCount after this increment
  banned: boolean; // whether this rejection pushed the account over the ban threshold
  ts: number;
}

/**
 * Replay share link (S1-RP): any player can fetch a match replay using a shareId (no login required).
 * `expiresAt` triggers TTL auto-expiry; GET /share/replay/:shareId returns 404 after expiry.
 */
export interface ReplayShareDoc {
  _id: string; // shareId（uuid）
  roomId: string;
  accountId: string; // creator (the side that initiated the share)
  expiresAt: Date; // BSON Date, TTL anchor (7 days)
  ts: number;
}

/**
 * State-stream replay share (public share outside the game, REPLAY_SHARE_DESIGN §3). **Orthogonal** to {@link ReplayShareDoc} (input-stream,
 * references roomId→replayBlobs, shareable only by a participant): the state-stream blob is produced by the client and uploaded directly
 * with the share request; anyone can retrieve it anonymously via shareCode. **Untrusted** — for viewing only, never fed into anti-cheat/settlement.
 * `expiresAt` triggers TTL auto-expiry; `GET /r/{shareCode}` returns 404 if expired or not found.
 */
export interface StateReplayShareDoc {
  _id: string; // shareCode (unguessable random string, ≥128bit)
  /** Delta-encoded state-stream replay (EncodedStateReplay); opaque blob — meta does not interpret its internal structure. */
  blob: unknown;
  createdBy: string; // creator accountId
  createdAt: number;
  expireAt: Date; // BSON Date, TTL anchor
  viewCount: number;
  sizeBytes: number;
}

/**
 * Anti-cheat review queue (S9-7 L2/L3, ACHIEVEMENT_DESIGN §4.4; PvE side added 2026-07-18, PVE_INTEGRITY_PLAN §8.6).
 * Two kinds share one collection/queue: `kind` is absent on pre-existing rows, which are implicitly `'pvp_overclaim'`.
 * - `pvp_overclaim`: an offline audit re-simulation conclusively confirms a side over-reported kill/cast → roll back
 *   the over-reported stats + escalate statSuspicion + write this entry for ops manual review/ban.
 *   `_id = `${roomId}:${accountId}``: one entry per cheating side per match, naturally idempotent (prevents double rollback).
 * - `pve_reject`: a PvE replay spot-check re-simulation yields fewer stars than claimed (`pveVerify`, no automatic ban
 *   as of 2026-07-18 — a legitimate, over-leveled account can clear early content passively with zero input, which is
 *   indistinguishable from a forged empty replay without human judgment). `_id = `pve:${verifyId}``.
 * Lives in the business database (meta), proxied by admin via `GET /internal/anticheat/reviews` (admin database is
 * physically isolated); resolved (dismiss/ban) via `POST /internal/anticheat/reviews/:id/resolve`.
 */
export interface AntiCheatReviewDoc {
  _id: string; // `${roomId}:${accountId}` (pvp_overclaim) | `pve:${verifyId}` (pve_reject)
  kind?: 'pvp_overclaim' | 'pve_reject'; // absent = 'pvp_overclaim' (pre-existing rows, back-compat)
  accountId: string;
  publicId?: string; // snapshot at archive time (for OPS display)
  status: 'open' | 'reviewed';
  ts: number;
  // —— pvp_overclaim fields ——
  roomId?: string;
  side?: number;
  reported?: Partial<Record<StatKey, number>>; // values reported by this side
  authoritative?: Partial<Record<StatKey, number>>; // authoritative values from judge re-simulation
  overclaim?: Partial<Record<StatKey, number>>; // theoretical over-report (reported - authoritative)
  rolledBack?: Partial<Record<StatKey, number>>; // actual rollback amount (clamped to 0 floor)
  suspicionAfter?: number; // statSuspicion for this account after escalation
  judgeAccountId?: string; // re-simulation judge (for auditing)
  // —— pve_reject fields ——
  levelId?: string;
  claimedStars?: number;
  judgedStars?: number;
  rejectCountAfter?: number;
  severity?: 'normal' | 'high'; // 'high' once rejectCountAfter crosses the old auto-ban threshold — triage signal only
  // —— resolution (both kinds) ——
  resolvedBy?: string; // admin id
  resolvedAt?: number;
  resolution?: 'dismissed' | 'banned';
}

// Friend/private-chat/block collections (FriendEdgeDoc / FriendRequestDoc / BlockDoc / ConversationDoc / ChatMessageDoc)
// have been migrated to socialsvc's nw_social database (P2, SOCIAL_SVC_DESIGN §6 P2); metaserver no longer owns these collections.

export interface MailAttachmentDoc {
  // 'material' → SaveData.materials unified progression pool (SLG8); 'item' → inventory.items general-purpose bucket.
  // 'equipment'/'card' → auction escrow-out return/delivery: carries the full instance snapshot (affixes/level/gear are
  //   an inseparable part of the instance), written back to equipmentInv/cardInv by instance.id on claim (AUCTION_DESIGN escrow-out).
  kind: 'coins' | 'item' | 'skin' | 'material' | 'equipment' | 'card';
  id?: string;
  count?: number;
  // Present (required) only for kind 'equipment' | 'card': the traded instance snapshot.
  instance?: EquipmentInstance | CardInstance;
}

/** Mail (SOC5): one document per recipient; attachment claiming goes through commercial idempotency (claimOrderId). */
export interface MailDoc {
  _id: string; // uuid
  to: string; // accountId (recipient)
  from: 'system' | string; // 'system' or sender accountId
  fromName?: string;
  subject: string;
  body: string;
  attachments?: MailAttachmentDoc[];
  createdAt: number;
  // BSON Date (not an epoch number): Mongo TTL only expires Date fields, absolute expiry time (expireAfterSeconds:0).
  // Writers store new Date(createdAt + MAIL_DEFAULT_TTL_SEC*1000); readers convert to number when building MailView.
  expireAt: Date;
  readAt?: number;
  claimedAt?: number;
  claimOrderId?: string; // claim idempotency key (commercial orderId)
}

/**
 * Card operation idempotency ledger (CC-2, CHARACTER_CARDS_DESIGN §3): prevents double-consumption of material cards
 * when the client retries a /cards/fuse request. _id = idempotencyKey. TTL auto-expiry (7 days).
 */
export interface CardIdemDoc {
  _id: string; // idempotencyKey
  accountId: string;
  op: 'fuse';
  result: unknown; // { targetId: string }
  expireAt: Date;
}

/**
 * Equipment operation idempotency ledger (E2, EQUIPMENT_DESIGN §18.2): for "consume materials + produce/move instance" operations such as
 * crafting/escrow, repeated requests replay the first result (no double deduction, no double roll). _id = idempotencyKey (craft) / orderId (escrow).
 * TTL auto-expiry (retained for N days, long enough to cover client retries + worldsvc return window).
 */
export interface EquipmentIdemDoc {
  _id: string; // idempotencyKey / orderId
  accountId: string;
  op: 'craft' | 'escrow' | 'enhance' | 'salvage' | 'reforge' | 'skin_escrow';
  /**
   * Snapshot of the first execution result, replayed verbatim on retry:
   *   craft       → produced instance (EquipmentInstance)
   *   escrow      → snapshot of the escrowed instance
   *   enhance     → { success, instance } (dice roll result + enhanced instance, E3)
   *   salvage     → { refunded } (total materials returned, E3)
   *   skin_escrow → { skinId } (auction task2, AUCTION_DESIGN §2.1/§9)
   */
  result: unknown;
  expireAt: Date; // BSON Date, TTL anchor
}

/** Stamina real-time state (A4). _id = accountId. Whole-row atomic findOneAndUpdate deduction, no rev lock. */
export interface StaminaDoc {
  _id: string; // accountId
  current: number; // current stamina (0..120)
  regenAt: number; // timestamp (ms) of the next +1 regen tick; 0 when already full
}

/**
 * Time-limited event definition (B6, ADR-014). _id = eventId (written by admin).
 * Written by admin via POST /admin/events; no admin UI openapi (pure ops backend, out of scope here).
 */
export interface EventDoc {
  _id: string; // eventId (UUID or ops-defined string)
  title: string; // event name (display)
  description?: string; // short description (optional)
  windowStart: number; // event start timestamp ms (inclusive)
  windowEnd: number;   // event end timestamp ms (exclusive)
  tasks: EventTaskDef[];
  rewards: EventRewardDef[];
  createdAt: number;
}

/**
 * Event participation record (B6). _id = `${eventId}:${accountId}`, naturally idempotent.
 * points can only increase; claimedRewards is a list of rewardIds (same id may appear multiple times for multi-claim rewards).
 */
export interface EventParticipantDoc {
  _id: string; // `${eventId}:${accountId}`
  eventId: string;
  accountId: string;
  points: number; // accumulated event points (atomic $inc)
  taskProgress: EventTaskProgress[]; // completion progress for each task
  /** List of claimed rewardIds (push duplicate entries for multi-claim, count by length). */
  claimedRewards: string[];
  updatedAt: number;
}

export interface Collections {
  saves: Collection<SaveDoc>;
  accounts: Collection<AccountDoc>;
  matches: Collection<MatchDoc>;
  adsDaily: Collection<AdsDailyDoc>;
  replayBlobs: Collection<ReplayBlobDoc>;
  pveDaily: Collection<PveDailyDoc>;
  pveVerifications: Collection<PveVerificationDoc>;
  antiCheatReviews: Collection<AntiCheatReviewDoc>;
  // PvE anti-cheat (S4-4)
  pveRejections: Collection<PveRejectDoc>;
  // replay shares (S1-RP)
  replayShares: Collection<ReplayShareDoc>;
  // state-stream replay public shares outside the game (REPLAY_SHARE_DESIGN)
  stateReplayShares: Collection<StateReplayShareDoc>;
  // mail (S6-3, system mail still written by metaserver; player mail CRUD migrated to socialsvc)
  mail: Collection<MailDoc>;
  // card roster (CC-2)
  cardIdem: Collection<CardIdemDoc>;
  // equipment (E2)
  equipmentIdem: Collection<EquipmentIdemDoc>;
  // ladder seasons (S11): single global document (_id='current')
  ladderSeasons: Collection<LadderSeasonDoc>;
  // ladder season settlement snapshots (L2-1): one entry per account per season, written at season close, also serves as idempotency ledger
  ladderSeasonSnapshots: Collection<LadderSeasonSnapshotDoc>;
  // ad token uniqueness (C2)
  adsTokens: Collection<AdsTokenDoc>;
  // stamina (A4): real-time deduction; _id = accountId
  pveStamina: Collection<StaminaDoc>;
  // time-limited events (B6)
  events: Collection<EventDoc>;
  eventParticipants: Collection<EventParticipantDoc>;
  // PvP balance data pipeline (BALANCE §11): deck-composition win-rate counters
  pvpCardStats: Collection<PvpCardStatDoc>;
  // PvP balance data pipeline P2: sampled replay decode (play sequences)
  pvpPlaySequences: Collection<PvpPlaySequenceDoc>;
}

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  collections: Collections;
  /** Create indexes (called once at startup, idempotent). */
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

/** Strip userinfo (user:pass@) from a Mongo URI so it's safe to log. */
function sanitizeMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
}

export async function createMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<MongoHandle> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    // Surface a clear, credential-free message before rethrowing, so a failed
    // DB connection at startup is never a silent/opaque crash regardless of caller.
    console.error(
      `[mongo] Failed to connect to MongoDB (uri=${sanitizeMongoUri(uri)}, db=${dbName}): ` +
        `${(err as Error).message}. Please verify the database is running and the connection config (NW_MONGO_URI) is correct.`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: Collections = {
    saves: db.collection<SaveDoc>('saves'),
    accounts: db.collection<AccountDoc>('accounts'),
    matches: db.collection<MatchDoc>('matches'),
    adsDaily: db.collection<AdsDailyDoc>('adsDaily'),
    replayBlobs: db.collection<ReplayBlobDoc>('replayBlobs'),
    pveDaily: db.collection<PveDailyDoc>('pveDaily'),
    pveVerifications: db.collection<PveVerificationDoc>('pveVerifications'),
    antiCheatReviews: db.collection<AntiCheatReviewDoc>('antiCheatReviews'),
    pveRejections: db.collection<PveRejectDoc>('pveRejections'),
    replayShares: db.collection<ReplayShareDoc>('replayShares'),
    stateReplayShares: db.collection<StateReplayShareDoc>('stateReplayShares'),
    mail: db.collection<MailDoc>('mail'),
    cardIdem: db.collection<CardIdemDoc>('cardIdem'),
    equipmentIdem: db.collection<EquipmentIdemDoc>('equipmentIdem'),
    ladderSeasons: db.collection<LadderSeasonDoc>('ladderSeasons'),
    ladderSeasonSnapshots: db.collection<LadderSeasonSnapshotDoc>('ladderSeasonSnapshots'),
    adsTokens: db.collection<AdsTokenDoc>('adsTokens'),
    pveStamina: db.collection<StaminaDoc>('pveStamina'),
    events: db.collection<EventDoc>('events'),
    eventParticipants: db.collection<EventParticipantDoc>('eventParticipants'),
    pvpCardStats: db.collection<PvpCardStatDoc>('pvpCardStats'),
    pvpPlaySequences: db.collection<PvpPlaySequenceDoc>('pvpPlaySequences'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.accounts.createIndex({ openid: 1 }, { sparse: true, unique: true });
    await collections.accounts.createIndex({ deviceId: 1 }, { sparse: true, unique: true });
    // password login loginId uniqueness (SA-1); oauth provider+sub uniqueness (SA-2, pre-built).
    await collections.accounts.createIndex(
      { 'password.loginId': 1 },
      { sparse: true, unique: true },
    );
    await collections.accounts.createIndex(
      { 'oauth.provider': 1, 'oauth.sub': 1 },
      { sparse: true, unique: true },
    );
    // 9-digit numeric public id globally unique (sparse, lazily back-filled for legacy accounts).
    await collections.accounts.createIndex({ publicId: 1 }, { sparse: true, unique: true });
    await collections.matches.createIndex({ ts: -1 });
    // storage cleanup TTL (non-disputed matches only, see MatchDoc.expireAt doc comment): 296MB/39K docs with no
    // cleanup was the sole driver of Atlas storage alerts at 3 real players + 100 bots.
    await collections.matches.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    await collections.replayBlobs.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // roomId idempotency: gameserver end-of-match report retries must not trigger duplicate settlement/archival (meta /internal/match/report).
    await collections.matches.createIndex({ roomId: 1 }, { unique: true });
    // lookup match/replay history by player (S1-RP sharing, ranked match record).
    await collections.matches.createIndex({ 'players.accountId': 1, ts: -1 });
    // achievement anti-cheat offline audit (S9-7): fetch unaudited ranked matches, oldest first to drain the backlog.
    await collections.matches.createIndex({ mode: 1, audited: 1, ts: 1 });
    // PvE spot-check records: query by account + time (audit / clean up pending settlements).
    await collections.pveVerifications.createIndex({ accountId: 1, ts: -1 });
    // achievement anti-cheat review queue (S9-7): query history by account + open queue.
    await collections.antiCheatReviews.createIndex({ accountId: 1, ts: -1 });
    await collections.antiCheatReviews.createIndex({ status: 1, ts: -1 });
    // —— PvE anti-cheat (S4-4) ——
    await collections.pveRejections.createIndex({ accountId: 1, ts: -1 });
    // —— replay shares (S1-RP) ——
    // TTL auto-expiry (expiresAt with expireAfterSeconds:0 → Mongo deletes on schedule).
    await collections.replayShares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await collections.replayShares.createIndex({ roomId: 1 });
    // state-stream shares: expireAt triggers TTL auto-expiry; index by creator for rate-limiting/audit queries.
    await collections.stateReplayShares.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    await collections.stateReplayShares.createIndex({ createdBy: 1, createdAt: -1 });
    // mail (friend/private-chat collections migrated to socialsvc; metaserver only retains mail for system messages)
    // inbox (reverse chronological order).
    await collections.mail.createIndex({ to: 1, createdAt: -1 });
    // mail TTL auto-expiry (expireAt is an absolute expiry timestamp → expireAfterSeconds:0, SOC5).
    await collections.mail.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // card operation idempotency ledger TTL auto-expiry (CC-2, expireAt is an absolute expiry time → expireAfterSeconds:0).
    await collections.cardIdem.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // equipment idempotency ledger TTL auto-expiry (E2, expireAt is an absolute expiry time → expireAfterSeconds:0).
    await collections.equipmentIdem.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // ad token uniqueness TTL auto-expiry (C2, 48h).
    await collections.adsTokens.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    // ladder leaderboard: server-wide Top100 + my rank count (S11-SE-5).
    // filter by pvp.seasonNo for the current season, then take the top 100 sorted by elo descending.
    await collections.saves.createIndex(
      { 'save.pvp.seasonNo': 1, 'save.pvp.elo': -1 },
      { name: 'pvp_season_elo' },
    );
    // ladder season settlement snapshots (L2-1): fetch the season's settlement roster by season (_id is already the ${seasonNo}:${accountId} idempotency key).
    await collections.ladderSeasonSnapshots.createIndex({ seasonNo: 1 });
    await collections.ladderSeasonSnapshots.createIndex({ accountId: 1, seasonNo: -1 });
    // stamina (A4): _id = accountId, single-document collection, no additional indexes.
    // time-limited events (B6): find active events by event window.
    await collections.events.createIndex({ windowStart: 1, windowEnd: 1 });
    // participation records: point-query by event + account (_id is already composite); additional index by accountId to fetch all events a player participates in.
    await collections.eventParticipants.createIndex({ accountId: 1, eventId: 1 });
    // PvP balance card stats: query by card across days for the aggregate report (_id is already the composite upsert key).
    await collections.pvpCardStats.createIndex({ cardId: 1, day: 1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
