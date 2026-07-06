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
  type AIDifficulty,
  type GameMode,
  type Replay,
} from '../game';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';

export interface LocalMatchOpts {
  /** When set, runs the PvE campaign level instead of a PvP-vs-AI match. */
  level?: LevelDefinition;
  /**
   * Explicit RNG seed (PvP-vs-AI path). Used by the match-bot fallback so the
   * server-chosen seed drives a deterministic local AI match. Ignored when a
   * `level` is given (campaign seed comes from the level). Omit → random seed.
   */
  seed?: number;
  /**
   * Engine mode override. Defaults to 'campaign' when a level is given, else 'pvp'.
   * Pass 'siege' (SLG siege mode, S8-3) to drive the same PvE-shaped engine with the
   * siege blueprint source — the `level` then carries the defender's config
   * (garrison / defenderBuildings / defenderBaseLevel).
   */
  mode?: GameMode;
  /**
   * Hero Roster card instances (CC-1, CHARACTER_CARDS_DESIGN §9) for PvE/siege paths (A5 §5.2 hard wall).
   * The engine builds progression- and equipment-buffed blueprints from the highest-level card per unit
   * type. Omit for PvP — buildPvpBlueprints() has no card parameter, so no progression/equipment leaks in.
   */
  cardInstances?: EngineCardInstance[];
  /**
   * Equipment instance inventory (SaveData.equipmentInv) used to resolve each card's gear slot ids.
   * Structurally compatible with EngineEquipInv; omit for PvP.
   */
  equipmentInv?: EngineEquipInv;
  /**
   * PvP-vs-AI deck gating (PVP_LOADOUT_DESIGN §3). Filters each side's draw pool to the given card ids
   * (bottom = human, top = AI). Omit → the engine draws from the full CARD_DEFINITIONS pool, which would
   * leak ELO-locked units (runner/splitter/…) into the bot-fallback match. Ignored when `level` is set.
   */
  decks?: { top: string[]; bottom: string[] };
  /**
   * AI skill level (1–10, engine AISystem.ts) for the PvP-vs-AI path. Omit → engine
   * default (5). Ignored when `level` is set (PvE uses WaveDirector, not AISystem).
   */
  difficulty?: AIDifficulty;
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
            ...(opts.cardInstances ? { cardInstances: opts.cardInstances } : {}),
            ...(opts.equipmentInv ? { equipmentInv: opts.equipmentInv } : {}),
          }
        : {
            ...(opts.decks ? { decks: opts.decks } : {}),
            ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
          }),
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
