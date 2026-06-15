// PIXI-free factory for a locally-simulated match engine (campaign / PvP-vs-AI).
// Extracted from GameScene so the engine build + replay snapshot can be reused by
// the headless test harness (full-link E2E) without pulling in the render layer.
//
// Online netplay does NOT use this: app.ts builds that engine directly (mode
// 'netplay' + a NetInputSource) and the server owns the recording.

import {
  createGameEngine,
  IGameEngine,
  LevelDefinition,
  LocalInputSource,
  OwnerId,
  RecordingInputSource,
  type GameMode,
  type Replay,
} from '../game';

export interface LocalMatchOpts {
  /** When set, runs the PvE campaign level instead of a PvP-vs-AI match. */
  level?: LevelDefinition;
  /** PvE upgrade levels threaded into the engine (hard wall, §5.2); campaign only. */
  pveUpgrades?: Record<string, number>;
}

export interface LocalMatch {
  engine: IGameEngine;
  /** Snapshot the recorded confirmed input stream into a Replay (S1-RP). */
  buildReplay(winner: OwnerId | null): Replay;
}

/**
 * Build a locally-simulated match: wrap a LocalInputSource in a RecordingInputSource
 * so the confirmed command stream can be replayed later. seed + mode + level are
 * everything needed to reconstruct the run.
 */
export function createLocalMatch(opts: LocalMatchOpts = {}): LocalMatch {
  const seed = opts.level
    ? opts.level.seed
    : (Date.now() ^ ((Math.random() * 0xffffff) | 0)) >>> 0;
  const mode: GameMode = opts.level ? 'campaign' : 'pvp';
  const recorder = new RecordingInputSource(new LocalInputSource());
  const recordLevelId = opts.level?.id;
  const engine = createGameEngine(
    {
      seed,
      players: [{ id: 0 }, { id: 1 }],
      mode,
      ...(opts.level ? { level: opts.level, pveUpgrades: opts.pveUpgrades ?? {} } : {}),
    },
    recorder,
  );
  const buildReplay = (winner: OwnerId | null): Replay =>
    recorder.snapshot({
      seed,
      mode,
      ...(recordLevelId ? { configRef: recordLevelId } : {}),
      meta: {
        recordedAt: Date.now(),
        winner: winner ?? -1,
        ...(recordLevelId ? { levelId: recordLevelId } : {}),
      },
    });
  return { engine, buildReplay };
}
