// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Match/replay domain: PvP match archives + their embedded/external/share replay variants.
import type { Collection } from 'mongodb';
import type { StatKey } from '../achievements';

/**
 * Inline replay (S1-RP): seed + config + non-empty frame log, no state.
 * Mirrors `contracts/replay.proto`, where `commands` is `bytes` — but this doc is **never** written
 * to Mongo as BSON. Since the 2026-07-20 storage-cost fix it exists only as JSON inside a gzip blob
 * (`compressReplayDoc` → `MatchDoc.replayGz` / `ReplayBlobDoc.replayGz`), and JSON has no byte type:
 * `frames[].cmds[].commands` is the **base64** of those opaque game.proto bytes, produced that way at
 * the single source (gameserver `metaReport.ts`) and passed through undecoded end to end (M12).
 * Typed `string` since 2026-08-20 — it was `unknown` (a leftover of the pre-gzip BSON-binary shape),
 * which made every consumer coerce it back with `String(...)`.
 */
export interface MatchReplayDoc {
  engineVersion: number;
  mode: string;
  seed: string;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: string }[] }[];
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
  /**
   * Settlement reservation (comm-audit-internal-2026-07-28 P0-1). Set on the placeholder doc that
   * /internal/match/report upserts ATOMICALLY (unique roomId index) before running settleElo, so a
   * gameserver retry racing a still-running first settlement dedups instead of double-crediting
   * ELO/coins. Cleared (via replaceOne) when the real archive doc lands; a crashed settlement
   * leaves a stale reservation that a retry may take over after MATCH_SETTLING_TAKEOVER_MS.
   */
  settling?: boolean;
  /** Timestamp of the (latest) settlement attempt owning the reservation; see `settling`. */
  settlingAt?: number;
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
 * External replay storage for large matches (S1-RP): when the embedded frame log exceeds the size threshold, the replay is stored in this
 * separate collection and `MatchDoc.replayRef = roomId` points here, keeping `matches` documents compact and list/history queries fast.
 * `GET /match/{roomId}/replay` checks `MatchDoc.replayGz` (embedded) first and falls back to this collection if absent.
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

/** Match/replay-domain indexes. */
export async function ensureMatchIndexes(
  matches: Collection<MatchDoc>,
  replayBlobs: Collection<ReplayBlobDoc>,
  replayShares: Collection<ReplayShareDoc>,
  stateReplayShares: Collection<StateReplayShareDoc>,
): Promise<void> {
  await matches.createIndex({ ts: -1 });
  // storage cleanup TTL (non-disputed matches only, see MatchDoc.expireAt doc comment): 296MB/39K docs with no
  // cleanup was the sole driver of Atlas storage alerts at 3 real players + 100 bots.
  await matches.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  await replayBlobs.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // roomId idempotency: gameserver end-of-match report retries must not trigger duplicate settlement/archival (meta /internal/match/report).
  await matches.createIndex({ roomId: 1 }, { unique: true });
  // lookup match/replay history by player (S1-RP sharing, ranked match record).
  await matches.createIndex({ 'players.accountId': 1, ts: -1 });
  // achievement anti-cheat offline audit (S9-7): fetch unaudited ranked matches, oldest first to drain the backlog.
  await matches.createIndex({ mode: 1, audited: 1, ts: 1 });
  // —— replay shares (S1-RP) ——
  // TTL auto-expiry (expiresAt with expireAfterSeconds:0 → Mongo deletes on schedule).
  await replayShares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await replayShares.createIndex({ roomId: 1 });
  // state-stream shares: expireAt triggers TTL auto-expiry; index by creator for rate-limiting/audit queries.
  await stateReplayShares.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  await stateReplayShares.createIndex({ createdBy: 1, createdAt: -1 });
}
