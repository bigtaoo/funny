/**
 * State-stream recorder (REPLAY_SHARE_DESIGN §2.1).
 *
 * Output-side recorder, symmetric to the input-side {@link RecordingInputSource}: each time the engine
 * advances a tick (**whether playing live or watching a replay**) it captures the visible entity state for
 * that frame. The hook point is where the render layer already reads `engine.state` every frame
 * ({@link GameRenderer}), so the engine itself is untouched.
 *
 * Single-slot ring: the module-level singleton keeps only the most recent match (analogous to
 * {@link ReplayStore}'s "last N matches" approach, with N=1).
 * Sharing only happens at two moments — "just settled" / "just finished watching a replay" — at which
 * point the state stream is already in memory. Pressing the share button reads it from memory directly;
 * **no re-simulation or server re-computation required**.
 *
 * If what is currently being watched is itself a state stream shared by someone else (dumb-player scenario),
 * {@link adopt} takes ownership of the raw encoded stream directly — no re-capture needed; it is forwarded as-is.
 */

import { BOARD_COLS, BOARD_ROWS, ATTACK_LANES } from '../config';
import { TICK_RATE } from '../math/fixed';
import { sideToOwner } from '../types';
import type { GameState } from '../GameState';
import {
  STATE_SCHEMA_VERSION,
  encodeStateReplay,
  quantizePos,
  quantizeHp,
  type EncodedStateReplay,
  type StateFrame,
  type StateReplayHeader,
  type StateUnit,
  type StateBuilding,
  type StateBase,
} from './StateReplay';

/**
 * Maximum sampled frames per match (size guardrail). At 30 Hz, 18000 frames = 10 minutes; once exceeded,
 * sampling stops and `capped` is flagged, but the already-sampled portion is still shareable.
 * Payload size is no longer the bottleneck (keyframe thinning + gzip means a full 10-minute match with ~50 units
 * measured at only ~367 KB uploaded, well under the server 2 MB limit, §7); this cap mainly constrains
 * **in-memory footprint during recording** (each tick's full frame stays in memory).
 */
const MAX_FRAMES = 18000;

export interface BuildStateReplayOverrides {
  mode?: string;
  /** Display names for both players (HUD labels); defaults to a placeholder based on side. */
  players?: { name: string; side: 0 | 1 }[];
  /** Winning owner (0/1), -1 for draw/unknown; defaults to the value captured from game_over during recording. */
  winner?: number;
}

class StateRecorder {
  private frames: StateFrame[] = [];
  private lastTick = -1;
  private capped = false;
  private winner = -1;
  /** Full-HP baseline for bases (anchored on the first frame), used for crack-ratio calculations. */
  private baseMaxHp: [number, number] = [0, 0];

  /** Raw encoded stream received from someone else's share (dumb-player adopt) — when set, sharing forwards it as-is without reading frames. */
  private adopted: EncodedStateReplay | null = null;

  /** Start of a new match or new replay segment: clear the single slot. Called by GameRenderer.buildSceneGraph. */
  reset(): void {
    this.frames = [];
    this.lastTick = -1;
    this.capped = false;
    this.winner = -1;
    this.baseMaxHp = [0, 0];
    this.adopted = null;
  }

  /** Take ownership of a state stream received from someone else (dumb player), so that re-sharing forwards it as-is. */
  adopt(enc: EncodedStateReplay): void {
    this.adopted = enc;
  }

  /** Record the winner during recording (called by the render layer on game_over / game_draw). */
  setWinner(winner: number): void {
    this.winner = winner;
  }

  /** Whether there is currently shareable content (frames have been sampled, or a stream has been adopted). */
  get hasContent(): boolean {
    return this.adopted !== null || this.frames.length > 0;
  }

  /**
   * Capture one frame. Called after each engine tick advance; repeated calls for the same tick
   * (render frames without an engine advance) are skipped automatically. A backward tick
   * (elapsedTicks resetting to zero) is treated as a new match and triggers an automatic reset.
   */
  capture(state: GameState): void {
    if (this.adopted) return; // do not capture while watching a shared stream
    const tick = state.elapsedTicks;
    if (tick < this.lastTick) this.reset();
    if (tick === this.lastTick && this.frames.length > 0) return;
    if (this.capped) return;

    if (this.frames.length === 0) {
      // Anchor the base full-HP baseline on the first frame.
      this.baseMaxHp = [
        Math.max(1, quantizeHp(state.bottomPlayer.baseHp)),
        Math.max(1, quantizeHp(state.topPlayer.baseHp)),
      ];
    }

    this.lastTick = tick;
    this.frames.push(this.snapshot(state, tick));
    if (this.frames.length >= MAX_FRAMES) this.capped = true;
  }

  /**
   * Encode: pack the in-memory frame sequence into a delta-encoded replay. If a stream has been adopted, returns it as-is.
   * `overrides` fills in the header's mode/players/winner (the recording site doesn't know this context; the share site passes it in).
   */
  build(overrides: BuildStateReplayOverrides = {}): EncodedStateReplay | null {
    if (this.adopted) return this.adopted;
    if (this.frames.length === 0) return null;

    const players: StateReplayHeader['players'] =
      overrides.players ?? [
        { name: '', side: 0 },
        { name: '', side: 1 },
      ];

    const header: StateReplayHeader = {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: overrides.mode ?? 'unknown',
      tickRate: TICK_RATE,
      endTick: this.lastTick,
      winner: overrides.winner ?? this.winner,
      board: { cols: BOARD_COLS, rows: BOARD_ROWS, lanes: [...ATTACK_LANES] },
      players,
    };

    return encodeStateReplay({ header, frames: this.frames });
  }

  // ── Private: capture one full-state frame ─────────────────────────────────────────────────────

  private snapshot(state: GameState, tick: number): StateFrame {
    const units: StateUnit[] = [];
    for (const u of state.board.units.values()) {
      units.push({
        id: u.id,
        type: u.unitType,
        side: sideToOwner(u.side),
        col: quantizePos(u.colExact),
        row: quantizePos(u.rowExact),
        hp: quantizeHp(u.hp),
        maxHp: quantizeHp(u.maxHp),
        state: u.state,
      });
    }

    const buildings: StateBuilding[] = [];
    for (const b of state.board.buildings.values()) {
      buildings.push({
        id: b.id,
        type: b.buildingType,
        side: sideToOwner(b.side),
        col: b.col,
        row: b.row,
        hp: quantizeHp(b.hp),
        maxHp: quantizeHp(b.maxHp),
      });
    }

    const bases: StateBase[] = [
      { owner: 0, hp: quantizeHp(state.bottomPlayer.baseHp), maxHp: this.baseMaxHp[0] },
      { owner: 1, hp: quantizeHp(state.topPlayer.baseHp), maxHp: this.baseMaxHp[1] },
    ];

    return { tick, units, buildings, bases };
  }
}

/** Module-level single-slot singleton (most recent match). */
export const stateRecorder = new StateRecorder();
