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
import type { EngineEquipmentInput } from '@nw/engine';

export interface LocalMatchOpts {
  /** When set, runs the PvE campaign level instead of a PvP-vs-AI match. */
  level?: LevelDefinition;
  /**
   * Explicit RNG seed (PvP-vs-AI path). Used by the match-bot fallback so the
   * server-chosen seed drives a deterministic local AI match. Ignored when a
   * `level` is given (campaign seed comes from the level). Omit → random seed.
   */
  seed?: number;
  /** @deprecated S12: per-stat 升级；单位养成改 unitLevels。仍透传以兼容过渡。 */
  pveUpgrades?: Record<string, number>;
  /** 单位养成等级（SaveData.unitLevels）threaded into the engine (hard wall, §5.2); campaign + siege. */
  unitLevels?: Record<string, number>;
  /**
   * Engine mode override. Defaults to 'campaign' when a level is given, else 'pvp'.
   * Pass 'siege' (SLG 围攻, S8-3) to drive the same PvE-shaped engine with the
   * siege blueprint source — the `level` then carries the defender's config
   * (garrison / defenderBuildings / defenderBaseLevel).
   */
  mode?: GameMode;
  /**
   * Equipment loadout + inventory for PvE/siege paths (A5 §5.2 hard wall).
   * Structurally compatible with EngineEquipmentInput; omit for PvP.
   */
  equipment?: EngineEquipmentInput;
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
    : (opts.seed ?? (Date.now() ^ ((Math.random() * 0xffffff) | 0))) >>> 0;
  const mode: GameMode = opts.mode ?? (opts.level ? 'campaign' : 'pvp');
  const recorder = new RecordingInputSource(new LocalInputSource());
  const recordLevelId = opts.level?.id;
  const engine = createGameEngine(
    {
      seed,
      players: [{ id: 0 }, { id: 1 }],
      mode,
      ...(opts.level
        ? {
            level: opts.level,
            pveUpgrades: opts.pveUpgrades ?? {},
            unitLevels: opts.unitLevels ?? {},
            ...(opts.equipment ? { equipment: opts.equipment } : {}),
          }
        : {}),
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
