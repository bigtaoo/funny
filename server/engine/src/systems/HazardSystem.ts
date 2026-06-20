import { TICK_RATE, type Fp } from '../math/fixed';
import { GameState } from '../GameState';

/**
 * HazardSystem — applies per-tick environmental effects to units inside hazard zones.
 *
 * Runs AFTER CombatSystem and BEFORE MovementSystem so that:
 *   - fog range reduction affects the same-tick combat (CombatSystem already ran).
 *   - speed reduction affects the same-tick movement (MovementSystem runs next).
 *
 * The system resets speed_fp and rangeMod each tick before applying zone effects,
 * so stacking multiple hazards on the same cell is additive but always based on
 * the unit's base values.
 *
 * Hard wall (§5.2/§6): state.hazards is always empty for pvp/netplay.
 */
export class HazardSystem {
  tick(state: GameState): void {
    if (!state.hazards.length) return;

    for (const unit of state.board.units.values()) {
      if (unit.isDead) continue;

      // Reset to base values each tick before hazard application.
      unit.speed_fp = unit.baseSpeed_fp;
      unit.rangeMod = 0;

      for (const h of state.hazards) {
        if (unit.col !== h.col) continue;
        const row = unit.row;
        if (row < h.rowRange[0] || row > h.rowRange[1]) continue;

        switch (h.effect) {
          case 'speed':
            unit.speed_fp = Math.round(unit.baseSpeed_fp * (h.speedMult ?? 0.5)) as Fp;
            break;
          case 'fog':
            unit.rangeMod += h.rangeMod ?? -1;
            break;
          case 'lava': {
            const dmgPerTick = Math.ceil((h.dps ?? 5) / TICK_RATE);
            unit.takeDamage(dmgPerTick);
            break;
          }
        }
      }
    }
  }
}
