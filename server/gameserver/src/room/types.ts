// Room domain split (2026-08-11, independent function modules form, claudedocs/server.md's "拆分形态的
// 优先级" 形态①) — public interfaces + the per-room mutable-state bag (`RoomCtx`) shared by every
// room/*.ts free-function module and built once by Room.ts's constructor. See Room.ts's header for the
// full split rationale and the base → metronome → settlement → connections dependency DAG.
import type { Connection } from '../Connection';
import type { FrameCmds, MatchModeVal, SideCmd } from '../proto/transport';

/**
 * Embedded replay (S1-RP) — the non-empty frame log retained for reconnection serves as the replay;
 * it is persisted at zero cost alongside the end-of-match report (meta writes to matches).
 * `commands` remain game.proto opaque bytes (server does not decode them, M12).
 */
export interface MatchReplay {
  engineVersion: number; // irrelevant to server logic → 0; client validates on playback
  mode: string;
  seed: number;
  endFrame: number;
  frames: { frame: number; cmds: { side: number; commands: Uint8Array }[] }[];
  meta: { recordedAt: number; winner: number };
  /** Deck loadouts the match was built with (PVP_LOADOUT §6.2) — without this, playback rebuilds against the full card pool. */
  decks?: { top: string[]; bottom: string[] };
}

/** Per-side ELO settlement result (returned by meta to game, forwarded as match_over.elo). */
export interface EloResult {
  delta: number;
  after: number;
  rankAfter: string;
}
/** side → ELO delta (returned by meta after ranked settlement). */
export type EloBySide = Record<number, EloResult>;

/** Payload reported to meta at end of match (M19, §8.3). */
export interface MatchReport {
  roomId: string;
  seed: number;
  mode: string; // friendly | ranked
  reason: string; // base | disconnect | mismatch
  winnerSide: number; // -1 = unknown
  hashOk: boolean;
  players: { side: number; accountId: string }[];
  results: { side: number; stateHash: string; winnerSide: number; stats?: Record<string, number> }[];
  replay: MatchReplay;
}

export interface RoomDeps {
  /** Callback when the room is destroyed (clears the manager mapping). */
  onDestroy: (roomId: string) => void;
  /**
   * Report end-of-match to meta (settlement + archival). Returns per-side ELO deltas
   * (on successful ranked settlement) or null.
   * friendly does not block match_over (fire-and-forget); ranked awaits result before dispatching elo.
   */
  report: (r: MatchReport) => Promise<EloBySide | null>;
}

export interface Slot {
  side: 0 | 1;
  accountId: string;
  name: string; // opponent display name (from the other ticket's ticket.opponent, which is actually this slot's name; for UI)
  publicId: string; // opponent 9-digit public id (for UI display only)
  opponentTitle: string; // opponent's equipped title id (empty string = no title; S10)
  opponentAvatarId: string; // opponent's equipped avatar id (empty string = no avatar)
  opponentSkins: string[]; // opponent's equipped character skin ids (empty = no skins equipped, incl. bots)
  /** Both players' decks from the ticket (PVP_LOADOUT §6.2). All slots carry the same decks object; either slot's value is authoritative. */
  decks?: { top: string[]; bottom: string[] };
  conn: Connection | null;
}

/**
 * The full per-room mutable state, formerly private fields directly on the `Room` class. Built once in
 * Room.ts's constructor and threaded through every room/*.ts free function by reference (plain object,
 * not a class — mutation via `ctx.slots.push(...)`/`ctx.phase = ...` etc. is visible to every function
 * holding the same reference, same as a class's `this` would be).
 */
export interface RoomCtx {
  readonly roomId: string;
  readonly seed: number;
  readonly mode: MatchModeVal;
  readonly deps: RoomDeps;
  phase: number;
  slots: Slot[];
  /**
   * Immutable identity roster (side -> accountId), captured once per side in addPlayer and never
   * shrunk. `slots` is mutated by onDisconnect's "already reported -> removeSlot" path (a same-tick
   * finish racing its own socket teardown is normal, not abnormal) — endMatch's report to meta must
   * not read `slots` for player identities, or the side that disconnected right after reporting its
   * result silently vanishes from the report and ranked settlement gets skipped with no error (the
   * `if (winner && loser)` guard in meta's matchReport.ts just no-ops).
   */
  readonly roster: { side: number; accountId: string }[];
  curFrame: number;
  pending: SideCmd[];
  readonly log: FrameCmds[];
  batchTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  launchTimer: NodeJS.Timeout | null;
  results: Map<number, { hash: string; winner: number; stats?: Record<string, number> }>;
  settled: boolean;
}
