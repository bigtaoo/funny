/**
 * Replay input source + recorder (S1-RP / META_DESIGN §6.6).
 *
 * The deterministic core (fixed-point math + injected PRNG) makes a recording
 * nothing more than **seed + config + the confirmed input stream** — no state is
 * ever stored. Re-feeding that stream into a fresh engine on the same seed
 * reproduces every tick byte-for-byte. This file is the third {@link InputSource}
 * implementation, alongside {@link LocalInputSource} (single-player) and
 * {@link NetInputSource} (online lockstep):
 *
 *   • {@link RecordingInputSource} — a transparent wrapper that delegates to any
 *     inner source and captures whatever it confirms each tick. Wrap a
 *     `LocalInputSource` to record a PvE/practice run, or a `NetInputSource` to
 *     record an online match locally. PvE recordings naturally contain only the
 *     player's commands (the `WaveDirector` enemy isn't a command source — it
 *     regenerates from seed+level on playback); netplay recordings contain both
 *     sides because the server-confirmed stream already does.
 *
 *   • {@link ReplayInputSource} — feeds a recorded {@link Replay} back to the
 *     engine. `take(frame)` returns that frame's recorded commands (or an empty
 *     set for the sparse gaps) and never stalls — playback always has the answer.
 *     Build the engine with the replay's `seed` + `mode` and pump `tick(dt)`; the
 *     run reproduces the original.
 */

import type { GameMode, PlayerCommand, Replay, ReplayFrame, ReplayMeta } from '../types';
import { ENGINE_VERSION } from '../types';
import type { InputSource } from './InputSource';

const EMPTY: readonly PlayerCommand[] = [];

// ─── Recording ─────────────────────────────────────────────────────────────────

export interface ReplaySnapshotOptions {
  seed: number;
  mode: GameMode;
  configRef?: string;
  meta?: ReplayMeta;
}

/**
 * Wraps an inner {@link InputSource} and records the confirmed command set the
 * engine consumes each tick. Transparent: `submit`/`take` behave exactly like
 * the wrapped source, so dropping a recorder in never changes engine behaviour
 * (the golden-replay determinism contract is preserved).
 *
 * Only non-empty confirmed sets are stored (sparse, mirroring the replay format);
 * frames advance monotonically as the engine steps, so each frame is captured at
 * most once. The captured commands are deep-cloned so later mutation of the live
 * objects can't corrupt the recording.
 */
export class RecordingInputSource implements InputSource {
  private readonly frames: ReplayFrame[] = [];
  /** Highest frame the engine has executed (take returned non-null). -1 = none yet. */
  private lastFrame = -1;

  constructor(private readonly inner: InputSource) {}

  submit(cmd: PlayerCommand): void {
    this.inner.submit(cmd);
  }

  take(frame: number): readonly PlayerCommand[] | null {
    const cmds = this.inner.take(frame);
    // `null` = the inner source stalled (net not yet confirmed); the engine does
    // not advance, so nothing to record for this frame.
    if (cmds === null) return null;
    if (frame > this.lastFrame) this.lastFrame = frame;
    if (cmds.length > 0) {
      this.frames.push({ tick: frame, commands: cmds.map(cloneCommand) });
    }
    return cmds;
  }

  /** Number of ticks executed so far (last executed frame + 1). */
  get frameCount(): number {
    return this.lastFrame + 1;
  }

  /** Build a serialisable {@link Replay} from everything recorded so far. */
  snapshot(opts: ReplaySnapshotOptions): Replay {
    return {
      engineVersion: ENGINE_VERSION,
      mode: opts.mode,
      seed: opts.seed,
      ...(opts.configRef !== undefined ? { configRef: opts.configRef } : {}),
      frames: this.frames.map((f) => ({ tick: f.tick, commands: f.commands.map(cloneCommand) })),
      endFrame: this.lastFrame + 1,
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    };
  }
}

// ─── Playback ────────────────────────────────────────────────────────────────

/** Thrown when a replay's engine version doesn't match the running engine. */
export class ReplayVersionError extends Error {
  constructor(
    readonly replayVersion: number,
    readonly engineVersion: number,
  ) {
    super(
      `replay engineVersion ${replayVersion} != engine ${engineVersion}; ` +
        `playback would diverge`,
    );
    this.name = 'ReplayVersionError';
  }
}

/**
 * Drives an engine from a recorded {@link Replay}. Build the engine with
 * `replay.seed` + `replay.mode` (+ the level for campaign), inject this source,
 * then pump `tick(dt)` — the engine reproduces the original run.
 *
 * Never stalls: `take(frame)` always returns the recorded set (empty for sparse
 * gaps). `submit()` is ignored — playback is fixed, live UI input must not leak
 * into a deterministic re-run.
 */
export class ReplayInputSource implements InputSource {
  /** Sparse: frame → recorded commands (frames absent ⇒ empty set). */
  private readonly byFrame = new Map<number, readonly PlayerCommand[]>();
  readonly endFrame: number;

  /**
   * @param validateVersion when true (default), throws {@link ReplayVersionError}
   *   if the replay was recorded under a different {@link ENGINE_VERSION}.
   */
  constructor(replay: Replay, validateVersion = true) {
    if (validateVersion && replay.engineVersion !== ENGINE_VERSION) {
      throw new ReplayVersionError(replay.engineVersion, ENGINE_VERSION);
    }
    for (const f of replay.frames) this.byFrame.set(f.tick, f.commands);
    this.endFrame = replay.endFrame;
  }

  submit(_cmd: PlayerCommand): void {
    /* playback is fixed — ignore live input */
  }

  take(frame: number): readonly PlayerCommand[] {
    return this.byFrame.get(frame) ?? EMPTY;
  }

  /** Whether the engine has reached the end of the recording. */
  isComplete(frame: number): boolean {
    return frame >= this.endFrame;
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function cloneCommand(cmd: PlayerCommand): PlayerCommand {
  return { ...cmd };
}
