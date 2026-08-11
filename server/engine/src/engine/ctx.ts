// EngineCtx — the deterministic simulation's dependency surface. Replaces the
// GameEngineBase mixin-chain ancestor (see claudedocs/server.md "engine/GameEngine")
// with an explicit, constructor-built value: every sim/*.ts function takes this (plus
// tick/commands where relevant) instead of reading fields off `this` in a chain.
//
// Deliberately excludes:
//   - `input` (InputSource) — only the facade (GameEngine.ts, for playCard/upgradeBase/
//     refreshHand self-forwarding) and the realtime driver (driver/realtimeDriver.ts,
//     for tick() catch-up) touch it. Keeping it out of EngineCtx makes "sim/** cannot
//     see wall-clock or network state" a structural fact, not a comment.
//   - `currentTick` / wall-clock accumulator — driver-owned (see driver/*.ts); the sim
//     layer only ever sees the tick number step() is explicitly called with.
//   - `firstStep` — lives on GameState itself (sim state, not driver state).
import type { GameState } from '../GameState';
import type { Building } from '../Building';
import type { Unit } from '../Unit';
import type { AIDifficulty, CardDefinition, GameMode, UnitBlueprint, UnitType } from '../types';
import type { LevelDefinition } from '../campaign/LevelDefinition';
import type { WaveDirector } from '../campaign/WaveDirector';
import { Prng } from '../math/prng';
import { AISystem } from '../systems/AISystem';
import { BuildingProductionSystem } from '../systems/BuildingProductionSystem';
import { CombatSystem } from '../systems/CombatSystem';
import { EscortSystem } from '../systems/EscortSystem';
import { HazardSystem } from '../systems/HazardSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { ResourceSystem } from '../systems/ResourceSystem';
import { SpellSystem } from '../systems/SpellSystem';
import { TraitSystem } from '../systems/TraitSystem';

/** Per-tick systems (engine/base.ts's old protected fields). Never reassigned after construction. */
export interface EngineSystems {
  readonly resource: ResourceSystem;
  readonly movement: MovementSystem;
  readonly combat: CombatSystem;
  readonly escort: EscortSystem;
  readonly hazard: HazardSystem;
  readonly spell: SpellSystem;
  readonly production: BuildingProductionSystem;
  readonly trait: TraitSystem;
  readonly ai: AISystem;
}

export function createSystems(seed: number, difficulty: AIDifficulty | undefined): EngineSystems {
  return {
    resource:   new ResourceSystem(),
    movement:   new MovementSystem(),
    combat:     new CombatSystem(),
    escort:     new EscortSystem(),
    hazard:     new HazardSystem(),
    spell:      new SpellSystem(),
    production: new BuildingProductionSystem(),
    trait:      new TraitSystem(),
    ai:         new AISystem(new Prng(seed ^ 0xA1A1A1A1), difficulty ?? 5),
  };
}

export interface EngineCtx {
  readonly state: GameState;
  readonly systems: EngineSystems;
  readonly mode: GameMode;
  readonly level: LevelDefinition | null;
  readonly waveDirector: WaveDirector | null;
  /**
   * Blueprints used by wave-spawned enemies (§4.10). Defaults to the shared
   * {@link GameState.unitBlueprints}; when a campaign level sets `enemyScale`, it's an
   * independent, progression-free, per-level-scaled set instead.
   */
  readonly enemyWaveBlueprints: Record<UnitType, UnitBlueprint>;
  /** Spell cards force-injected into the player's opening hand (levelSpells). */
  readonly initialSpellCards: readonly CardDefinition[];
  /** Garrison units (U10): pre-placed defender units awaiting their spawn events. */
  readonly garrisonUnits: readonly Unit[];
  /** Attacker army (G3, §16): pre-placed Bottom-side units awaiting their spawn events. */
  readonly attackerArmyUnits: readonly Unit[];
  /** Defender buildings (U10): pre-placed buildings awaiting their placed events. */
  readonly defenderBuildingList: readonly Building[];
}
