// Split from matchReport.ts (2026-08-10, independent function module range 6, part 1/6).
// Shared constants + the request/result shapes every sibling in this split touches.

/**
 * Maximum byte size for the inline (already gzip-compressed) replay; if exceeded, it is stored
 * externally in replayBlobs + replayRef (keeps matches documents compact). Measured post-compression
 * (2026-07-20) — the constant value is unchanged (256KB) but it now bounds compressed bytes, not the
 * raw JSON frame log, so effectively far more raw replay content fits inline than before.
 */
export const REPLAY_INLINE_MAX_BYTES = 256 * 1024;

/** Storage cleanup TTL for non-disputed matches (7 days — bots have only been live a week, so 30d bought no headroom; see MatchDoc.expireAt). */
export const MATCH_RETENTION_MS = 7 * 24 * 3600 * 1000;
// How long a settlement reservation (see the reservation block below) may sit before a retry is
// allowed to assume the previous owner crashed and settle in its place. Must comfortably exceed
// the worst-case in-flight settlement (20s judge round-trip + Mongo/commercial writes).
export const MATCH_SETTLING_TAKEOVER_MS = 2 * 60_000;

export interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}

export interface ReportBody {
  room_id: string;
  seed: string;
  mode: string; // friendly | ranked
  reason: string; // base | disconnect | mismatch
  winner_side: number;
  hash_ok: boolean;
  players: { side: number; accountId: string }[];
  results: { side: number; state_hash: string; winner_side: number; stats?: Record<string, number> }[];
  /** base64(gzip(JSON.stringify(replayDoc))) — see @nw/shared replayCodec. Never decoded on the hot per-match path (M12); only judgeMismatch/anticheatAudit decompress it. */
  replay_gz: string;
}
