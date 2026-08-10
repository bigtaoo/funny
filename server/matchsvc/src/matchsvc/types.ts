// Matchsvc.ts split (2026-08-10, single-class → independent-classes-plus-composition, ≤500-line convention,
// see claudedocs/server.md "单文件 500 行收敛"): shared types/constants used across the split layers
// (matchStarter/rooms/queue/duel). No behavior here, only declarations — mirrors gateway/types.ts's role
// in the earlier Gateway.ts split.

// RoomPhase enum values mirror contracts/transport.proto (encoding is the gateway's responsibility;
// matchsvc only passes through the integer phase).
export const RoomPhase = {
  WAITING: 0,
  READY: 1,
  COUNTDOWN: 2,
  IN_MATCH: 3,
  OVER: 4,
} as const;

// ── Gateway push interface (matchsvc holds no connections directly; proto-agnostic) ────────────────
export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 9-digit numeric public id (used for player communication / reports; defaults to empty string). */
  publicId: string;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  // Match timeout fallback to AI (feature flag match_bot_fallback). Client opens a local AI match; no ticket/gameUrl.
  // `difficulty` is the AI level 1–10 (engine AISystem.ts) encoded as a decimal string —
  // kept as `string` on the wire (transport.proto field is string) to avoid a proto/codegen
  // change; parse with Number(...) on the receiving end. Rolled by pickBotDifficulty(elo).
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string }
  // Friend-challenge ("切磋") invite, pushed to the invited friend (gateway resolves their publicId
  // → accountId before calling duelInvite). Accepting skips straight to match_found (startMatch) —
  // there is no separate "duel accepted" push.
  | { kind: 'duel_invited'; inviteId: string; fromPublicId: string; fromName: string }
  // Pushed back to the inviter on the unhappy path only. reason: declined | timeout | offline | not_found | lost
  // (the middle two originate at the gateway, before a matchsvc invite record even exists; lost originates
  // at matchsvc rehydrate — see prematch_lost below).
  | { kind: 'duel_cancelled'; inviteId: string; reason: string }
  // ── matchsvc restart-safety (matchsvc-prematch-persist, 2026-07-29) ──────────
  // Pushed to every account whose pre-match state was rehydrated from Redis after a matchsvc restart
  // (see rehydrate()), instead of silently waiting for the client's own much-longer timeout.
  // queue_state: ranked-queue entry survived the restart — a no-op refresh confirming it's still active.
  | { kind: 'queue_state' }
  // prematch_lost: this account's pre-match state (room/queue/duel) could not be recovered (created and
  // lost before ever reaching Redis, or Redis itself was unavailable/flushed at restart time).
  | { kind: 'prematch_lost'; context: 'room' | 'queue' | 'duel' };

/**
 * Push callback. `roomId` is a cross-process correlation id — it is included in logs across
 * matchsvc / gateway / game / meta for the same match, so Grafana can reconstruct the full
 * match timeline with `| json | roomId="X"`. Used for logging only; not included in the
 * client-visible PushMsg. Omitted when there is no room context (e.g. ALREADY_IN_ROOM errors).
 */
export type Push = (accountId: string, msg: PushMsg, roomId?: string) => void;

export interface Slot {
  accountId: string;
  name: string;
  publicId: string;
  /** Equipped title id (from meta /internal/profile; empty string = no title). */
  equippedTitle: string;
  /** Equipped avatar id (from meta /internal/profile; empty string = no avatar). */
  avatarId: string;
  /** Equipped character skin ids (from meta /internal/profile; empty = no skins equipped). */
  equippedSkins: string[];
  /** PvP deck (card ids; validated and resolved by gateway; empty = matchsvc substitutes defaultPvpDeck at startMatch). */
  deck: string[];
  side: 0 | 1;
  ready: boolean;
  connected: boolean;
}
export interface Room {
  roomId: string;
  code: string;
  slots: Slot[];
  phase: number;
  /** Timer that cleans up the room after all players disconnect. Excluded from Redis persistence
   *  (persist.ts's PersistedRoom) — rehydrate re-arms a fresh one if needed (see rooms.ts's hydrateAll). */
  reapTimer: NodeJS.Timeout | null;
}

/** Player identity + loadout carried by a pending duel invite, same shape MatchStarterPort takes for each side. */
export interface DuelPlayer {
  accountId: string;
  name: string;
  publicId: string;
  equippedTitle: string;
  avatarId: string;
  equippedSkins: string[];
  deck: string[];
}
export interface DuelInvite {
  inviteId: string;
  from: DuelPlayer;
  toAccountId: string;
  timer: NodeJS.Timeout;
}

// MUST stay identical to client RoomScene.ts (its keypad can only type these
// chars). 10 digits + 11 letters; letters skip I/O/L so they don't read as 0/1.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKM';
export const CODE_LEN = 6;
export const REAP_MS = 60_000; // grace period to keep the room after all players disconnect
export const DUEL_TIMEOUT_MS = 60_000; // friend-challenge response window (ADR: friends-duel-confirm)

/** Player identity + loadout carried into MatchStarterPort.start — same shape for either side. */
export interface StartMatchPlayer {
  accountId: string;
  name: string;
  publicId: string;
  equippedTitle: string;
  avatarId: string;
  equippedSkins: string[];
  deck: string[];
}

/** Narrow view of matchStarter.ts's MatchStarter — the one method rooms.ts/queue.ts/duel.ts each need to
 *  launch a match once their own admission logic (ready/paired/accepted) decides to. A shared lower-level
 *  dependency, not a sibling-to-sibling call: none of the three ever import each other. */
export interface MatchStarterPort {
  start(mode: 'friendly' | 'ranked', a: StartMatchPlayer, b: StartMatchPlayer): void;
}

/** Narrow read-only view of rooms.ts's RoomRegistry — the one predicate queue.ts's enqueue() needs
 *  ("is this account already committed to a friendly room?") before admitting to the ranked queue.
 *  One-directional (queue.ts → rooms.ts): rooms.ts never imports queue.ts back, so composing the two
 *  stays acyclic. The reverse check ("already queued?" for roomCreate/roomJoin) is instead read by
 *  Matchsvc.ts's shell from queue.ts directly — see its doc comment for why that guard lives there
 *  and not inside rooms.ts. */
export interface RoomLookupPort {
  hasRoom(accountId: string): boolean;
}
