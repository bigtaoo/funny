/**
 * game-logic public API — single entry point.
 *
 * The render layer (game-client) ONLY imports from this file.
 * Internal classes (GameEngineImpl, Unit, Building, Board, GameState, Player, …)
 * are NOT exported here and remain invisible to the client.
 *
 * When the project is split into separate packages, the client tsconfig will be
 * pointed at this file's .d.ts; TypeScript will enforce the boundary at compile time.
 */

// ── Factory + engine interface ────────────────────────────────────────────────
export { createGameEngine } from '@nw/engine/GameEngine';
export type { IGameEngine } from '@nw/engine/types';

// ── Headless driver (shared with server: worldsvc siege / gateway self-judge) ─
export { runHeadless } from '@nw/engine/runHeadless';
export type { HeadlessOutcome } from '@nw/engine/runHeadless';

// ── Unified input pipeline (M13) ──────────────────────────────────────────────
export { LocalInputSource } from '@nw/engine/net/InputSource';
export type { InputSource } from '@nw/engine/net/InputSource';
export { NetInputSource } from './net/NetInputSource';
export type { CmdSink, MatchStartInfo, NetInputSourceOptions } from './net/NetInputSource';
export {
  ReplayInputSource,
  RecordingInputSource,
  ReplayVersionError,
} from '@nw/engine/net/ReplayInputSource';
export type { ReplaySnapshotOptions } from '@nw/engine/net/ReplayInputSource';

// ── Public types (needed by the render layer) ─────────────────────────────────
export type {
  GameConfig,
  PlayerConfig,
  PlayerCommand,
  GameEvent,
  OwnerId,
  PlayerStats,
  MatchSummary,
  Vec2_fp,
  Replay,
  ReplayFrame,
  ReplayMeta,
  GameMode,
  AIDifficulty,
} from '@nw/engine/types';

export { ENGINE_VERSION } from '@nw/engine/types';

// ── Achievement stat mapping (S9-6) — engine counts → statKey deltas ──────────
export { achievementStatDelta } from '@nw/engine';

export {
  UnitType,
  BuildingType,
  SpellType,
  CardType,
  Side,
  GamePhase,
  UnitState,
  sideToOwner,
  ownerToSide,
} from '@nw/engine/types';

// ── Fixed-point utilities (render layer needs fromFp to convert for display) ──
export { FP_SCALE, TICK_RATE, fromFp } from '@nw/engine/math/fixed';
export type { Fp } from '@nw/engine/math/fixed';

// ── GameState — exposed as a type so the render layer can annotate parameters ──
export type { GameState } from '@nw/engine/GameState';

// ── Campaign (PvE) ────────────────────────────────────────────────────────────
export type { LevelDefinition } from '@nw/engine/campaign/LevelDefinition';
export { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER, getLevel } from './campaign/levels';
export type { ChapterMap, ChapterNode, ChapterDecor, NormPoint } from './campaign/maps';
export { CHAPTER_MAPS, CHAPTER_ORDER, getChapterMap, parseChapterMap, ChapterMapParseError } from './campaign/maps';
