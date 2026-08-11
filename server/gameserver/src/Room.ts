// Pure frame relay room + server-authoritative metronome (M14) + non-empty frame log + reconnection + end-of-match report to meta (S1-M2/M3).
//
// After slimming (M16): gameserver does not create rooms / does not matchmake / does not connect to DB.
// Rooms are created on demand via ticket handshake: two tickets for the same roomId (side 0/1, matching seed)
// trigger match start. No ready / room-owner phase (those are handled on the matchsvc control plane).
// At match end, results + replay are POSTed to meta for settlement/archival.
//
// Tick rate: simulation 30Hz; network 10Hz, one frame_batch dispatched every 100ms (covering 3 sim frames).
// cmd_submit lands on "the frame for the current window" = to_frame of the current batch;
// multiple commands in the same frame are sorted deterministically by side in ascending order.
//
// 2026-08-11 (independent function modules form, claudedocs/server.md's "拆分形态的优先级" 形态①): split
// by domain into room/{types,base,metronome,settlement,connections}.ts. `Room` is a single class whose
// mutable state (slots/phase/timers/log/results/etc, now `RoomCtx`) is read or written by virtually
// every method — the same shape as AISystem's ctx split (组 6), not a handful of independent
// operations — so it doesn't fit the "独立类+组合" form: constructor-injected sibling classes would need
// a genuine 3-way circular dependency (connections needs metronome.start/stop + settlement.endMatch;
// settlement needs metronome.stopMetronome; metronome/settlement both need connections' broadcast) that
// composition's constructor-injection can't express without an artificial merge. Free functions sharing
// one `ctx` object sidestep that: modules can call each other in any direction (no instantiation-order
// constraint), so the split instead layers into a one-directional import DAG — base (zero cross-file
// calls) → metronome → settlement → connections, no file imports "upward" — see each file's header for
// its exact incoming/outgoing edges. `Room` itself is the thin shell: builds `ctx` once in the
// constructor and delegates every public method to the matching free function. No behavior change;
// external callers (RoomManager.ts / index.ts / this package's tests) import `{ Room }` from here
// unchanged.
import { Connection } from './Connection';
import {
  addPlayer as addPlayerFn,
  leave as leaveFn,
  onDisconnect as onDisconnectFn,
  resume as resumeFn,
  takeover as takeoverFn,
} from './room/connections';
import { hasAccount as hasAccountFn, hasSide as hasSideFn } from './room/base';
import { submitCmd as submitCmdFn } from './room/metronome';
import { destroy as destroyFn, reportResult as reportResultFn } from './room/settlement';
import { RoomPhase, type MatchModeVal } from './proto/transport';
import type { RoomCtx, RoomDeps } from './room/types';

export type { EloBySide, EloResult, MatchReplay, MatchReport, RoomDeps } from './room/types';

const START_FRAME = 0;

export class Room {
  private readonly ctx: RoomCtx;

  constructor(
    readonly roomId: string,
    /** Seed assigned by the ticket (same for both sides; gameserver no longer generates it). */
    seed: number,
    readonly mode: MatchModeVal,
    deps: RoomDeps,
  ) {
    this.ctx = {
      roomId, seed, mode, deps,
      phase: RoomPhase.WAITING,
      slots: [],
      roster: [],
      curFrame: START_FRAME,
      pending: [],
      log: [],
      batchTimer: null,
      graceTimer: null,
      launchTimer: null,
      results: new Map(),
      settled: false,
    };
  }

  // ───────────────────────── Room management ─────────────────────────

  get phase(): number { return this.ctx.phase; }
  get isFull(): boolean { return this.ctx.slots.length >= 2; }
  /** Snapshot of every accountId that has ever joined this room (immutable roster — see RoomCtx's field doc). Used at gameserver shutdown to notify meta which players' login-reconnect-prompt cache should be cleared since this room is about to vanish with no end-of-match report. */
  get rosterAccountIds(): string[] { return this.ctx.roster.map((r) => r.accountId); }
  /** Room seed (used by RoomManager to cross-check the second ticket). */
  get seedValue(): number { return this.ctx.seed; }

  hasSide(side: number): boolean { return hasSideFn(this.ctx, side); }
  hasAccount(accountId: string): boolean { return hasAccountFn(this.ctx, accountId); }

  addPlayer(conn: Connection, name: string, publicId: string, opponentTitle = '', decks?: { top: string[]; bottom: string[] }, opponentAvatarId = '', opponentSkins: string[] = []): void {
    addPlayerFn(this.ctx, conn, name, publicId, opponentTitle, decks, opponentAvatarId, opponentSkins);
  }

  submitCmd(side: number, commands: Uint8Array): void {
    submitCmdFn(this.ctx, side, commands);
  }

  /** Report end-of-match state hash + client-determined winner side → once both sides report → compare + settle (meta authoritatively computes ELO). */
  reportResult(side: number, stateHash: string, winnerSide: number, stats?: Record<string, number>): void {
    reportResultFn(this.ctx, side, stateHash, winnerSide, stats);
  }

  /** Explicit leave. During a match, treated as a forfeit (opponent wins). */
  leave(side: number): void {
    leaveFn(this.ctx, side);
  }

  // ───────────────────────── Disconnect / reconnect (S1-4) ─────────────────────────

  onDisconnect(side: number, closing: Connection): void {
    onDisconnectFn(this.ctx, side, closing);
  }

  takeover(conn: Connection): void {
    takeoverFn(this.ctx, conn);
  }

  /** Reconnect: rebind connection + send conn_resync to catch up frames + resume metronome. */
  resume(conn: Connection, lastFrame: number): void {
    resumeFn(this.ctx, conn, lastFrame);
  }

  // ───────────────────────── Settlement (report to meta) / destroy ─────────────────────────

  destroy(): void {
    destroyFn(this.ctx);
  }
}
