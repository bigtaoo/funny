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
import { createLogger } from '@nw/shared';
import { Connection } from './Connection';
import {
  MatchMode,
  RoomPhase,
  type FrameCmds,
  type MatchModeVal,
  type PlayerSlotOut,
  type SideCmd,
} from './proto/transport';

const log = createLogger('game');

const FRAMES_PER_BATCH = 3; // sim 30Hz ÷ net 10Hz
const BATCH_MS = 100;
const GRACE_MS = 60_000; // disconnect grace period (M10)
const START_FRAME = 0;
// Maximum wait time after the first player joins for the second to connect (covers ticket TTL + buffer).
// If no match starts within the timeout, destroy the waiting room to prevent "got a ticket but never connected" room leaks.
const LAUNCH_TIMEOUT_MS = 35_000;

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

interface Slot {
  side: 0 | 1;
  accountId: string;
  name: string; // opponent display name (from the other ticket's ticket.opponent, which is actually this slot's name; for UI)
  publicId: string; // opponent 9-digit public id (for UI display only)
  opponentTitle: string; // opponent's equipped title id (empty string = no title; S10)
  /** Both players' decks from the ticket (PVP_LOADOUT §6.2). All slots carry the same decks object; either slot's value is authoritative. */
  decks?: { top: string[]; bottom: string[] };
  conn: Connection | null;
}

export class Room {
  phase: number = RoomPhase.WAITING;
  private slots: Slot[] = [];
  /**
   * Immutable identity roster (side -> accountId), captured once per side in addPlayer and never
   * shrunk. `slots` is mutated by onDisconnect's "already reported -> removeSlot" path (a same-tick
   * finish racing its own socket teardown is normal, not abnormal) — endMatch's report to meta must
   * not read `slots` for player identities, or the side that disconnected right after reporting its
   * result silently vanishes from the report and ranked settlement gets skipped with no error (the
   * `if (winner && loser)` guard in meta's matchReport.ts just no-ops).
   */
  private readonly roster: { side: number; accountId: string }[] = [];

  private curFrame = START_FRAME;
  private pending: SideCmd[] = [];
  private readonly log: FrameCmds[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private launchTimer: NodeJS.Timeout | null = null;

  private results = new Map<number, { hash: string; winner: number; stats?: Record<string, number> }>();
  private settled = false;

  constructor(
    readonly roomId: string,
    /** Seed assigned by the ticket (same for both sides; gameserver no longer generates it). */
    private readonly seed: number,
    readonly mode: MatchModeVal,
    private readonly deps: RoomDeps,
  ) {}

  // ───────────────────────── Room management ─────────────────────────

  get isFull(): boolean {
    return this.slots.length >= 2;
  }

  /** Room seed (used by RoomManager to cross-check the second ticket). */
  get seedValue(): number {
    return this.seed;
  }

  hasSide(side: number): boolean {
    return this.slots.some((s) => s.side === side);
  }
  hasAccount(accountId: string): boolean {
    return this.slots.some((s) => s.accountId === accountId);
  }

  /** Join the specified side per ticket; match starts when both sides are present. Duplicate side is ignored. */
  addPlayer(conn: Connection, name: string, publicId: string, opponentTitle = '', decks?: { top: string[]; bottom: string[] }): void {
    if (this.phase >= RoomPhase.IN_MATCH) return; // match already started; new connections go through resume
    if (this.hasSide(conn.side)) return;
    this.slots.push({ side: conn.side, accountId: conn.accountId, name, publicId, opponentTitle, decks, conn });
    this.roster.push({ side: conn.side, accountId: conn.accountId });
    if (this.slots.length === 2) {
      this.launch();
    } else if (!this.launchTimer) {
      // First player arrived — start the empty-wait timeout; destroy the room if the second never connects.
      this.launchTimer = setTimeout(() => {
        this.launchTimer = null;
        if (this.phase < RoomPhase.IN_MATCH) this.destroy();
      }, LAUNCH_TIMEOUT_MS);
      this.launchTimer.unref?.();
    }
  }

  private slotOfSide(side: number): Slot | undefined {
    return this.slots.find((s) => s.side === side);
  }

  private playerSlotsOut(): PlayerSlotOut[] {
    return this.slots.map((s) => ({
      side: s.side,
      name: s.name,
      ready: true,
      connected: s.conn !== null,
    }));
  }

  private broadcast(send: (c: Connection) => void): void {
    for (const s of this.slots) if (s.conn) send(s.conn);
  }

  // ───────────────────────── Match start ─────────────────────────

  private launch(): void {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
    this.curFrame = START_FRAME;
    this.phase = RoomPhase.IN_MATCH;
    // Decks are identical across both slots (same ticket payload); use whichever slot has them.
    const decks = this.slots.find((s) => s.decks)?.decks;
    for (const s of this.slots) {
      s.conn?.send({
        case: 'match_start',
        roomId: this.roomId,
        mode: this.mode,
        seed: this.seed,
        startFrame: START_FRAME,
        localSide: s.side,
        opponentName: s.name, // slot.name is this slot's opponent name (sourced from the other ticket's ticket.opponent)
        opponentPublicId: s.publicId,
        ...(s.opponentTitle ? { opponentTitle: s.opponentTitle } : {}),
        ...(decks ? { topDeck: decks.top, bottomDeck: decks.bottom } : {}),
      });
    }
    this.startMetronome();
  }

  submitCmd(side: number, commands: Uint8Array): void {
    if (this.phase !== RoomPhase.IN_MATCH) return;
    if (!this.hasSide(side)) return;
    this.pending.push({ side, commands });
  }

  /** Report end-of-match state hash + client-determined winner side → once both sides report → compare + settle (meta authoritatively computes ELO). */
  reportResult(side: number, stateHash: string, winnerSide: number, stats?: Record<string, number>): void {
    if (this.phase !== RoomPhase.IN_MATCH || this.settled) return;
    if (!this.hasSide(side)) return;
    this.results.set(side, { hash: stateHash, winner: winnerSide, ...(stats ? { stats } : {}) });
    if (this.results.size < this.slots.length) return;

    const reports = [...this.results.values()];
    const hashOk = reports.every((r) => r.hash === reports[0]!.hash);
    if (this.mode === MatchMode.RANKED) {
      const winnersAgree = reports.every((r) => r.winner === reports[0]!.winner);
      if (hashOk && winnersAgree) {
        void this.endMatch({ winnerSide: reports[0]!.winner, reason: 'base', hashOk: true });
      } else {
        void this.endMatch({ winnerSide: -1, reason: 'mismatch', hashOk: false });
      }
      return;
    }
    // friendly: winner is determined authoritatively by client simulation; meta only audits/archives.
    void this.endMatch({ winnerSide: -1, reason: hashOk ? 'base' : 'mismatch', hashOk });
  }

  /** Explicit leave. During a match, treated as a forfeit (opponent wins). */
  leave(side: number): void {
    const slot = this.slotOfSide(side);
    if (!slot) return;
    if (this.phase === RoomPhase.IN_MATCH) {
      const peer = this.slots.find((s) => s.side !== side);
      log.info('explicit leave -> forfeit', { roomId: this.roomId, accountId: slot.accountId, side, curFrame: this.curFrame });
      void this.endMatch({ winnerSide: peer ? peer.side : -1, reason: 'disconnect', hashOk: true });
      return;
    }
    this.removeSlot(side);
  }

  // ───────────────────────── Disconnect / reconnect (S1-4) ─────────────────────────

  onDisconnect(side: number, closing: Connection): void {
    const slot = this.slotOfSide(side);
    if (!slot || slot.conn !== closing) return; // already replaced by a new connection; ignore
    slot.conn = null;

    if (this.phase !== RoomPhase.IN_MATCH) {
      this.removeSlot(side);
      return;
    }
    // This side already reported its own result before closing — a normal same-tick finish racing
    // its own socket teardown, not an abnormal drop. reportResult() will settle the match itself
    // (immediately if the peer already reported too, or once the peer catches up and reports) — no
    // grace timer/forfeit needed, and no false "mid-match disconnect" warning.
    if (this.results.has(side)) {
      this.removeSlot(side);
      return;
    }
    this.stopMetronome();
    const peer = this.slots.find((s) => s.side !== side && s.conn);
    log.warn('WS closed mid-match -> grace period started', {
      roomId: this.roomId,
      accountId: slot.accountId,
      side,
      curFrame: this.curFrame,
      graceMs: GRACE_MS,
    });
    peer?.conn?.send({ case: 'peer_dc', side, graceMs: GRACE_MS });
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      log.warn('grace period expired -> forfeit by disconnect', {
        roomId: this.roomId,
        accountId: slot.accountId,
        side,
        curFrame: this.curFrame,
      });
      void this.endMatch({
        winnerSide: peer ? peer.side : -1,
        reason: 'disconnect',
        hashOk: true,
      });
    }, GRACE_MS);
  }

  /**
   * A new ticket connection claims a side that's already occupied — either the previous connection
   * is stale (new-device login evicting the old one) or this is the same device racing its own
   * reconnect. Evicts the stale socket immediately so it can't linger duplicating frames or block
   * the account from being taken over. Deliberately leaves `slot.conn`/grace-timer/metronome alone:
   * the client's follow-up conn_resume still drives resume() for that, since it carries lastFrame
   * needed to backfill the missed frame log correctly — rebinding here first could let a metronome
   * tick reach the new connection before its resync, if the stale socket hadn't disconnected yet.
   */
  takeover(conn: Connection): void {
    const slot = this.slotOfSide(conn.side);
    if (!slot) return;
    const stale = slot.conn;
    if (stale && stale !== conn) stale.close(4409, 'replaced');
  }

  /** Reconnect: rebind connection + send conn_resync to catch up frames + resume metronome. */
  resume(conn: Connection, lastFrame: number): void {
    const slot = this.slotOfSide(conn.side);
    if (!slot || this.phase !== RoomPhase.IN_MATCH || this.settled) {
      conn.send({ case: 'room_error', code: 'ROOM_NOT_FOUND', message: 'no active match' });
      return;
    }
    slot.conn = conn;
    conn.send({
      case: 'conn_resync',
      seed: this.seed,
      startFrame: START_FRAME,
      log: this.log.filter((f) => f.frame > lastFrame),
      curFrame: this.curFrame,
    });

    if (this.slots.every((s) => s.conn)) {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.startMetronome();
    }
  }

  private removeSlot(side: number): void {
    this.slots = this.slots.filter((s) => s.side !== side);
    if (this.slots.length === 0) this.destroy();
  }

  // ───────────────────────── Metronome (M14) ─────────────────────────

  private startMetronome(): void {
    if (this.batchTimer) return;
    if (!this.slots.every((s) => s.conn) || this.slots.length !== 2) return;
    this.batchTimer = setInterval(() => this.tickBatch(), BATCH_MS);
  }

  private stopMetronome(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private tickBatch(): void {
    this.curFrame += FRAMES_PER_BATCH;
    let frames: FrameCmds[] = [];
    if (this.pending.length > 0) {
      const cmds = [...this.pending].sort((a, b) => a.side - b.side); // stable sort preserves arrival order
      const fc: FrameCmds = { frame: this.curFrame, cmds };
      this.log.push(fc);
      frames = [fc];
      this.pending = [];
    }
    this.broadcast((c) => c.send({ case: 'frame_batch', toFrame: this.curFrame, frames }));
  }

  // ───────────────────────── Settlement (report to meta) / destroy ─────────────────────────

  private async endMatch(opts: {
    winnerSide: number;
    reason: string;
    hashOk: boolean;
  }): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopMetronome();
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.phase = RoomPhase.OVER;

    const report: MatchReport = {
      roomId: this.roomId,
      seed: this.seed,
      mode: this.mode === MatchMode.RANKED ? 'ranked' : 'friendly',
      reason: opts.reason,
      winnerSide: opts.winnerSide,
      hashOk: opts.hashOk,
      players: this.roster,
      results: [...this.results.entries()].map(([side, r]) => ({
        side,
        stateHash: r.hash,
        winnerSide: r.winner,
        ...(r.stats ? { stats: r.stats } : {}),
      })),
      replay: this.buildReplay(opts.winnerSide),
    };

    // ranked: wait for meta to return ELO before dispatching match_over; friendly: dispatch immediately, report fire-and-forget.
    let eloBySide: EloBySide | null = null;
    if (this.mode === MatchMode.RANKED) {
      try {
        eloBySide = await this.deps.report(report);
      } catch (e) {
        console.error('[gameserver] meta report (ranked) failed:', e);
      }
    } else {
      void this.deps.report(report).catch((e) =>
        console.error('[gameserver] meta report (friendly) failed:', e),
      );
    }

    this.broadcast((c) => {
      const elo = eloBySide ? eloBySide[c.side] : undefined;
      c.send({
        case: 'match_over',
        winnerSide: opts.winnerSide < 0 ? 0 : opts.winnerSide,
        reason: opts.reason,
        mismatch: !opts.hashOk,
        ...(elo ? { elo } : {}),
      });
    });

    this.destroy();
  }

  private buildReplay(winnerSide: number): MatchReplay {
    // Decks are identical across both slots (same ticket payload); use whichever slot has them.
    const decks = this.slots.find((s) => s.decks)?.decks;
    return {
      engineVersion: 0,
      mode: 'netplay',
      seed: this.seed,
      endFrame: this.curFrame,
      frames: this.log.map((fc) => ({
        frame: fc.frame,
        cmds: fc.cmds.map((sc) => ({ side: sc.side, commands: Buffer.from(sc.commands) })),
      })),
      meta: { recordedAt: Date.now(), winner: winnerSide },
      ...(decks ? { decks } : {}),
    };
  }

  destroy(): void {
    this.stopMetronome();
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
    this.deps.onDestroy(this.roomId);
  }
}
