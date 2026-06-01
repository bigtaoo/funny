import { ATTACK_LANES, TOP_BUILDING_ROW } from '../config';
import { TICK_RATE } from '../math/fixed';
import { GameState } from '../GameState';
import { CardType, OwnerId, PlayerCommand, Side, SpellType } from '../types';

/**
 * AISystem — reads game state, returns PlayerCommand[] for this tick.
 * Does NOT mutate state; commands are processed by GameEngine.processCommand().
 * Uses integer tick count for decision pacing — no floating-point.
 *
 * Strategy: "medium player"
 * - Plays unit cards on lanes with fewest enemies.
 * - Places buildings when affordable and slots are free.
 * - Uses spells opportunistically.
 * - At most one action per decision interval (every 1.5 s = 45 ticks).
 */
export class AISystem {
  private thinkTick: number = 0;

  /**
   * Decision interval in ticks: 1.5 s × 30 ticks/s = 45 ticks.
   * Integer constant — no float stored.
   */
  private readonly thinkIntervalTicks = Math.round(1.5 * TICK_RATE); // 45

  decideTick(tick: number, state: GameState): PlayerCommand[] {
    this.thinkTick++;
    if (this.thinkTick < this.thinkIntervalTicks) return [];
    this.thinkTick = 0;
    return this.makeDecision(tick, state);
  }

  private makeDecision(tick: number, state: GameState): PlayerCommand[] {
    const player = state.topPlayer;
    const hand   = player.hand;
    const owner: OwnerId = 1;

    for (let idx = 0; idx < hand.cards.length; idx++) {
      const card = hand.cards[idx];
      if (!card || player.coins < card.cost) continue;

      if (card.cardType === CardType.Unit && card.unitType) {
        const lane = this.chooseLane(state);
        if (lane === null) continue;
        return [{ type: 'play_card', owner, tick, handIndex: idx, col: lane }];
      }

      if (card.cardType === CardType.Building && card.buildingType) {
        const lane = this.chooseBuildingLane(state);
        if (lane === null) continue;
        return [{ type: 'play_card', owner, tick, handIndex: idx, col: lane }];
      }

      if (card.cardType === CardType.Spell && card.spellType) {
        if (card.spellType === SpellType.Haste) {
          return [{ type: 'play_card', owner, tick, handIndex: idx }];
        }
        if (card.spellType === SpellType.Meteor) {
          const target = this.findMeteorTarget(state);
          if (!target) continue;
          return [{ type: 'play_card', owner, tick, handIndex: idx, col: target.col, row: target.row }];
        }
      }
    }

    return [];
  }

  // ─── Decision helpers ─────────────────────────────────────────────────────

  private chooseLane(state: GameState): number | null {
    let minEnemies = Infinity;
    const bestLanes: number[] = [];

    for (const lane of ATTACK_LANES) {
      let count = 0;
      for (const unit of state.board.units.values()) {
        if (unit.side === Side.Bottom && unit.col === lane) count++;
      }
      if (count < minEnemies) {
        minEnemies = count;
        bestLanes.length = 0;
        bestLanes.push(lane);
      } else if (count === minEnemies) {
        bestLanes.push(lane);
      }
    }
    if (bestLanes.length === 0) return null;
    // Random tie-breaking so AI spreads across lanes from game start
    return bestLanes[Math.floor(Math.random() * bestLanes.length)]!;
  }

  private chooseBuildingLane(state: GameState): number | null {
    for (const lane of ATTACK_LANES) {
      if (!state.board.hasBuildingAt(lane, TOP_BUILDING_ROW)) return lane;
    }
    return null;
  }

  private findMeteorTarget(state: GameState): { col: number; row: number } | null {
    const cells: Record<string, number> = {};
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom) continue;
      const key = `${unit.col},${unit.row}`;
      cells[key] = (cells[key] ?? 0) + 1;
    }
    let best: { col: number; row: number } | null = null;
    let bestCount = 1;

    for (const [key, count] of Object.entries(cells)) {
      if (count > bestCount) {
        bestCount = count;
        const [col, row] = key.split(',').map(Number);
        best = { col: col!, row: row! };
      }
    }
    return best;
  }
}
