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
export { createGameEngine } from './GameEngine';
export type { IGameEngine } from './types';

// ── Unified input pipeline (M13) ──────────────────────────────────────────────
export { LocalInputSource } from './net/InputSource';
export type { InputSource } from './net/InputSource';

// ── Public types (needed by the render layer) ─────────────────────────────────
export type {
  GameConfig,
  PlayerConfig,
  PlayerCommand,
  GameEvent,
  OwnerId,
  PlayerStats,
  Vec2_fp,
  Replay,
  ReplayFrame,
} from './types';

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
} from './types';

// ── Fixed-point utilities (render layer needs fromFp to convert for display) ──
export { FP_SCALE, TICK_RATE, fromFp } from './math/fixed';
export type { Fp } from './math/fixed';

// ── GameState — exposed as a type so the render layer can annotate parameters ──
export type { GameState } from './GameState';

// ── Campaign (PvE) ────────────────────────────────────────────────────────────
export type { LevelDefinition } from './campaign/LevelDefinition';
export { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER, getLevel } from './campaign/levels';
