/**
 * Online lockstep input source (S1-7) — the networked sibling of
 * {@link LocalInputSource}, both implementing {@link InputSource}.
 *
 * It bridges the gameserver's server-authoritative metronome (M14) to the
 * deterministic engine:
 *
 *   • OUTBOUND — `submit(cmd)` encodes the *action* (handIndex/col/row or
 *     upgrade) as `game.proto` `PlayerCommands` opaque bytes and fires a
 *     `cmd_submit`. It does NOT pick a frame: the server schedules the command
 *     onto the next batch's `to_frame` and tags it with this connection's side.
 *
 *   • INBOUND — `frame_batch{to_frame, frames}` raises a *confirmed* watermark;
 *     each non-empty `FrameCmds` is decoded back into `PlayerCommand[]` (owner =
 *     `SideCmd.side`, tick = `FrameCmds.frame`) and cached. `take(frame)` then
 *     releases the confirmed set for that frame — or `null` when the frame is
 *     not yet confirmed, which stalls the engine (lockstep; no prediction, no
 *     rollback).
 *
 * Pacing: the server emits 3 sim frames per 100 ms batch; the engine drains
 * them at its 30 Hz wall-clock rate, so the two run at the same average rate.
 * Playback is held one batch (`bufferFrames`, default 3) behind the newest
 * watermark, so network jitter up to one batch interval (<100 ms) never starves
 * playback. When batches stop arriving the watermark freezes and the engine
 * pauses; when a burst (or a `conn_resync` after reconnect) jumps the watermark
 * forward, the engine fast-forwards through the buffered frames to catch up.
 *
 * Single-player / PvE keep using {@link LocalInputSource} unchanged.
 */

import type { OwnerId, PlayerCommand } from '../types';
import type { InputSource } from './InputSource';
import { PlayerCommands, type PlayerCommand as ProtoPlayerCommand } from '../../net/proto/game';
import type {
  ConnResync,
  FrameBatch,
  FrameCmds,
  MatchStart,
  ServerMsg,
} from '../../net/proto/transport';

const EMPTY: readonly PlayerCommand[] = [];

/** Sim frames per network batch (30 Hz sim ÷ 10 Hz net). Mirrors gameserver `Room`. */
const FRAMES_PER_BATCH = 3;

/** Where outbound `cmd_submit` go — satisfied by {@link NetClient}. */
export interface CmdSink {
  submitCmd(commands: Uint8Array): void;
}

/** Captured from `match_start`; the app uses it to build the engine (seed/mode). */
export interface MatchStartInfo {
  roomId: string;
  mode: number;
  seed: number;
  startFrame: number;
  /** Which side this client controls (0 = bottom, 1 = top). */
  localSide: number;
  /** Opponent display name (UI only; empty if unknown). */
  opponentName: string;
  /** Opponent 9-digit public id (UI only; empty if unknown). */
  opponentPublicId: string;
  /** Opponent equipped title id (S10; empty if none). */
  opponentTitle: string;
}

export interface NetInputSourceOptions {
  /**
   * How many frames to keep buffered behind the newest confirmed watermark —
   * the jitter cushion. Default one batch (3 ≈ 100 ms). 0 = play to the edge of
   * the watermark (no cushion).
   */
  bufferFrames?: number;
  /** Fired once when `match_start` arrives, so the app can spin up the engine. */
  onMatchStart?: (info: MatchStartInfo) => void;
}

export class NetInputSource implements InputSource {
  /** Highest `to_frame` confirmed by the server; -1 before `match_start`. */
  private confirmedTo = -1;
  private startFrame = 0;
  /** Non-empty frames only: frame → decoded commands (empty frames are implicit). */
  private readonly cmdsByFrame = new Map<number, PlayerCommand[]>();
  /** Highest frame `take()` has released — reported as `conn_resume{last_frame}`. */
  private lastTaken = -1;
  private matchInfo: MatchStartInfo | null = null;

  private readonly bufferFrames: number;

  constructor(
    private readonly sink: CmdSink,
    private readonly opts: NetInputSourceOptions = {},
  ) {
    this.bufferFrames = opts.bufferFrames ?? FRAMES_PER_BATCH;
  }

  // ─── InputSource ───────────────────────────────────────────────────────────

  /**
   * Relay a locally-produced command to the server (opaque `PlayerCommands`
   * bytes, no frame number). It becomes confirmed when it returns inside a
   * future `frame_batch`. The `owner`/`tick` on `cmd` are placeholders — the
   * server tags the real side, and the frame is assigned by the metronome.
   */
  submit(cmd: PlayerCommand): void {
    const bytes = PlayerCommands.encode(
      PlayerCommands.fromPartial({ commands: [toProto(cmd)] }),
    ).finish();
    this.sink.submitCmd(bytes);
  }

  /**
   * Confirmed command set for `frame`, or `null` to stall the engine.
   *
   * A frame is releasable once it sits at or below the playback head
   * (`confirmedTo - bufferFrames`, floored at `startFrame`). Holding the head
   * one batch behind the watermark is what absorbs sub-batch jitter.
   */
  take(frame: number): readonly PlayerCommand[] | null {
    if (this.confirmedTo < 0) return null; // no match yet
    const playTo = Math.max(this.startFrame, this.confirmedTo - this.bufferFrames);
    if (frame > playTo) return null; // not yet confirmed → engine pauses
    if (frame > this.lastTaken) this.lastTaken = frame;
    return this.cmdsByFrame.get(frame) ?? EMPTY;
  }

  /**
   * Confirmed playback backlog ahead of `frame` (see
   * {@link InputSource.confirmedLead}). Mirrors `take()`'s playback head exactly
   * so the two never disagree about what's releasable: the count is how many
   * frames `take()` would return non-null for, starting at `frame`. A large lead
   * means the watermark raced ahead while this client was paused / backgrounded.
   */
  confirmedLead(frame: number): number {
    if (this.confirmedTo < 0) return 0;
    const playTo = Math.max(this.startFrame, this.confirmedTo - this.bufferFrames);
    return Math.max(0, playTo - frame);
  }

  // ─── Server message intake (wire NetClient.onServerMsg here) ────────────────

  /** Route a decoded server message; ignores everything but the lockstep ones. */
  handleServerMsg(msg: ServerMsg): void {
    if (msg.matchStart) this.onMatchStart(msg.matchStart);
    else if (msg.frameBatch) this.onFrameBatch(msg.frameBatch);
    else if (msg.connResync) this.onConnResync(msg.connResync);
  }

  /** `match_start` info (seed / localSide / mode), or null before it arrives. */
  get matchStartInfo(): MatchStartInfo | null {
    return this.matchInfo;
  }

  /**
   * Frame to put in `conn_resume{last_frame}` on reconnect — the highest
   * watermark we hold. The server replays only non-empty frames beyond it.
   */
  resumeFrame(): number {
    return Math.max(this.startFrame, this.confirmedTo, 0);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private onMatchStart(m: MatchStart): void {
    // Fresh match (incl. a rematch on a reused session): clear any frame state
    // left over from a previous match so stale commands can't bleed into the
    // new engine and break determinism. (Reconnect uses conn_resync, not this.)
    this.cmdsByFrame.clear();
    this.lastTaken = -1;
    this.matchInfo = {
      roomId: m.roomId,
      mode: m.mode,
      seed: m.seed,
      startFrame: m.startFrame,
      localSide: m.localSide,
      opponentName: m.opponentName,
      opponentPublicId: m.opponentPublicId,
      opponentTitle: m.opponentTitle,
    };
    this.startFrame = m.startFrame;
    // The start frame is playable immediately (its command set is empty — the
    // metronome can only schedule commands onto later frames).
    this.confirmedTo = m.startFrame;
    this.opts.onMatchStart?.(this.matchInfo);
  }

  private onFrameBatch(b: FrameBatch): void {
    for (const fc of b.frames) this.ingestFrame(fc);
    // Watermark is monotonic — never retract (no rollback).
    if (b.toFrame > this.confirmedTo) this.confirmedTo = b.toFrame;
  }

  private onConnResync(r: ConnResync): void {
    // Reconnect: merge the replayed non-empty frames (>last_frame) and jump the
    // watermark to cur_frame. Already-held frames (≤ old watermark) are
    // deterministic duplicates — re-ingesting is a no-op in content.
    this.startFrame = r.startFrame;
    for (const fc of r.log) this.ingestFrame(fc);
    if (r.curFrame > this.confirmedTo) this.confirmedTo = r.curFrame;
  }

  private ingestFrame(fc: FrameCmds): void {
    const out: PlayerCommand[] = [];
    // Server already ordered `cmds` (side asc, then arrival) — the sole ordering
    // authority. Preserve it so both clients apply an identical sequence.
    for (const sc of fc.cmds) {
      const decoded = PlayerCommands.decode(sc.commands);
      for (const pc of decoded.commands) {
        out.push(fromProto(pc, sc.side as OwnerId, fc.frame));
      }
    }
    if (out.length > 0) this.cmdsByFrame.set(fc.frame, out);
  }
}

// ─── PlayerCommand ↔ game.proto ────────────────────────────────────────────────

function toProto(cmd: PlayerCommand): ProtoPlayerCommand {
  if (cmd.type === 'upgrade_base') {
    return { upgradeBase: {}, playCard: undefined };
  }
  return {
    playCard: { handIndex: cmd.handIndex, col: cmd.col ?? 0, row: cmd.row ?? 0 },
    upgradeBase: undefined,
  };
}

function fromProto(pc: ProtoPlayerCommand, owner: OwnerId, frame: number): PlayerCommand {
  if (pc.upgradeBase) {
    return { type: 'upgrade_base', owner, tick: frame };
  }
  const card = pc.playCard;
  return {
    type: 'play_card',
    owner,
    tick: frame,
    handIndex: card?.handIndex ?? 0,
    col: card?.col ?? 0,
    row: card?.row ?? 0,
  };
}
