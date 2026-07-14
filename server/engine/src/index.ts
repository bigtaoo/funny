/**
 * @nw/engine — the deterministic simulation core, single source of truth.
 *
 * Extracted from `client/src/game` (SLG_DESIGN §16.7) so the client (via webpack
 * alias + tsconfig paths) and the server processes (worldsvc / gateway, via the
 * workspace dependency) run the SAME engine bytes — killing the hand-mirrored
 * determinism time-bomb. Internal classes (GameEngineImpl, Unit, Building, Board,
 * GameState, Player, EscortUnit) stay unexported here; deep consumers (tests)
 * reach them by subpath. The render layer + server only touch this surface.
 */

// ── Factory + engine interface ────────────────────────────────────────────────
export { createGameEngine } from './GameEngine';
export type { IGameEngine } from './types';

// ── Headless driver (worldsvc authoritative siege / gateway self-judge) ───────
export { runHeadless } from './runHeadless';
export type { HeadlessOutcome } from './runHeadless';

// ── Unified input pipeline (M13) — proto-free sources only ────────────────────
export { LocalInputSource } from './net/InputSource';
export type { InputSource } from './net/InputSource';
export {
  ReplayInputSource,
  RecordingInputSource,
  ReplayVersionError,
} from './net/ReplayInputSource';
export type { ReplaySnapshotOptions } from './net/ReplayInputSource';

// ── Public types ──────────────────────────────────────────────────────────────
export type {
  GameConfig,
  PlayerConfig,
  PlayerCommand,
  GameEvent,
  OwnerId,
  PlayerStats,
  MatchSummary,
  AIDifficulty,
  Vec2_fp,
  Replay,
  ReplayFrame,
  ReplayMeta,
  GameMode,
} from './types';

/**
 * Engine version (U9). worldsvc / gateway pin against this when running
 * authoritative siege or recomputing a replay; bumping it mid-season requires a
 * pin. Lives with the engine so version and code can never drift apart.
 */
export { ENGINE_VERSION } from './types';

// ── Achievement stat mapping (S9-3b/S9-6) — engine counts → statKey deltas ────
export { achievementStatDelta } from './achievementStats';

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

// ── Fixed-point utilities ─────────────────────────────────────────────────────
export { FP_SCALE, TICK_RATE, fromFp } from './math/fixed';
export type { Fp } from './math/fixed';
export { Prng } from './math/prng';

// ── AI decision system (botsvc: headless bot driving a real netplay connection) ──
export { AISystem, DIFFICULTY } from './systems/AISystem';
export type { DifficultyParams } from './systems/AISystem';

// ── Board / blueprint constants (worldsvc siege army synthesis, G3-2b) ────────
// Exposed so the authoritative siege runner reads board geometry + unit HP caps
// from the SAME source the engine simulates with — no hand-mirrored copies.
export {
  BOARD_COLS,
  BOARD_ROWS,
  ATTACK_LANES,
  BASE_COLS,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
} from './config';
export type { UnitBlueprint } from './types';

// ── GameState exposed as a type only (state inspection after a headless run) ──
export type { GameState } from './GameState';

// ── Equipment / card input types (CC-1) ──────────────────────────────────────────────────────────
// Callers now pass EngineCardInstance[] + EngineEquipInv to buildCampaignBlueprints/buildSiegeBlueprints.
// EngineEquipmentInput is retained for backward-compat type references; new code should use EngineCardInstance.
export type { EngineEquipmentInput, EngineCardInstance, EngineEquipInv } from './balance/equipment';
// Player unit types that can receive card-based equipment bonuses (CC-1: expanded to 6 unit types).
export { PLAYER_EQUIPPABLE_UNITS } from './balance/equipment';

// ── Campaign / level data model + validator ───────────────────────────────────
export type {
  LevelDefinition,
  Cell,
  ObjectiveSpec,
  WaveScript,
  WaveEntry,
  HazardSpec,
  EscortSpec,
  GarrisonEntry,
  DefenderBuildingEntry,
  LevelRewards,
} from './campaign/LevelDefinition';
export { parseLevelDefinition, LevelParseError } from './campaign/levelSchema';
export { TUTORIAL_LEVEL_ID, TUTORIAL_TEACHING_CARDS } from './campaign/tutorial';
export { TutorialDrawPolicy } from './Card';
