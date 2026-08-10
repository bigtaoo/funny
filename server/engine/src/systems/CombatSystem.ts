import { GameState } from '../GameState';
import { runCombatTick } from './combat/tick';

// Re-exported so external code that reached into CombatSystem.ts's original
// module scope for these (there was none outside this file, but keeping the
// re-export costs nothing and matches the equipment.ts/cards.ts precedent).
export { findTarget, findTargetForBuilding } from './combat/targeting';
export { performBuildingAttack, performUnitAttack, resolveAttackHit } from './combat/hitResolution';
export { fireProjectile, tickProjectiles } from './combat/projectiles';

/**
 * CombatSystem — tick-based attack cooldowns, no floating-point.
 *
 * Direction convention:
 *   Bottom (+1): looks for targets at higher row numbers (rows above).
 *   Top    (-1): looks for targets at lower  row numbers (rows below).
 *
 * ── Split (2026-08-10, independent function module range 6) ──
 * This class never held any instance state — every method was already a pure
 * function of its explicit arguments — so the split is a straight move to free
 * functions in `combat/{targeting,hitResolution,projectiles,tick}.ts`, grouped
 * by concern (target acquisition / attack execution + shared hit resolution /
 * projectile lifecycle / the tick() orchestrator). This class is now a thin
 * shell whose only job is preserving the `new CombatSystem().tick(state)`
 * public API that `engine/base.ts` and the engine test suite construct.
 */
export class CombatSystem {
  tick(state: GameState): void {
    runCombatTick(state);
  }
}
