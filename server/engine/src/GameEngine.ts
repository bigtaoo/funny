// GameEngine — battle engine core. The implementing class is assembled from domain mixins
// living in ./engine/*.ts, chained onto GameEngineBase (./engine/base.ts, which also holds the
// full constructor / mode-setup logic). To add engine behavior: find the matching domain mixin
// (loop / commands / campaign / winCondition / helpers) or add a new one to the chain below —
// do NOT grow this file. This is a pure mechanical split of the former monolithic
// GameEngineImpl; method bodies were moved verbatim.
import { LocalInputSource } from './net/InputSource';
import type { InputSource } from './net/InputSource';
import type { GameConfig, IGameEngine } from './types';
import { GameEngineBase } from './engine/base';
import { HelpersMixin } from './engine/helpers';
import { CampaignMixin } from './engine/campaign';
import { CommandsMixin } from './engine/commands';
import { WinConditionMixin } from './engine/winCondition';
import { LoopMixin } from './engine/loop';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a game engine.
 *
 * `input` is the unified input pipeline (M13). Defaults to `LocalInputSource`
 * (single-player / practice: UI commands self-forward to the current tick with
 * zero delay). Online play (S1-7) and replay (S1-RP) inject `NetInputSource` /
 * `ReplayInputSource` here instead — the engine code is unchanged.
 */
export function createGameEngine(config: GameConfig, input?: InputSource): IGameEngine {
  return new GameEngineImpl(config, input ?? new LocalInputSource());
}

// ─── Implementation (not exported) ───────────────────────────────────────────
//
// Mixin application order matters: each domain can only call into domains already applied
// before it (TypeScript infers `this` through the generic chain, so a mixin sees exactly the
// members mixed in so far). Dependency order here:
//   Helpers      — no dependencies (drawIntoSlot, accumulateBuildingSurvival)
//   Campaign     — no dependencies (spawnEnemyUnit, hasLivingEnemyUnits)
//   Commands     — needs Helpers (consumeCardSlot → drawIntoSlot)
//   WinCondition — needs Campaign (survive objective → hasLivingEnemyUnits)
//   Loop         — needs all four (step() orchestrates commands/campaign/win-check/survival)

const Assembled = LoopMixin(
  WinConditionMixin(
    CommandsMixin(
      CampaignMixin(
        HelpersMixin(GameEngineBase),
      ),
    ),
  ),
);

class GameEngineImpl extends Assembled implements IGameEngine {}
