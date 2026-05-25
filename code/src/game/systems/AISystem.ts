import {
  ATTACK_LANES,
  BUILDING_BLUEPRINTS,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
} from '../config';
import { Building } from '../Building';
import { GameState } from '../GameState';
import { SpellSystem } from './SpellSystem';
import { Unit } from '../Unit';
import { CardType, Side, SpellType } from '../types';

/**
 * Simple AI: simulates a "medium" player.
 * - Plays cards when affordable.
 * - Prefers spawning units on lanes with fewer enemies.
 * - Places buildings early if hand allows.
 * - Uses spells when beneficial.
 */
export class AISystem {
  private readonly spellSystem: SpellSystem;
  private thinkTimer: number = 0;
  private readonly thinkInterval: number = 1.5; // seconds between AI decisions

  constructor(spellSystem: SpellSystem) {
    this.spellSystem = spellSystem;
  }

  tick(state: GameState, dt: number): void {
    this.thinkTimer += dt;
    if (this.thinkTimer < this.thinkInterval) return;
    this.thinkTimer = 0;

    this.makeDecision(state);
  }

  private makeDecision(state: GameState): void {
    const player = state.topPlayer;
    const hand = player.hand;
    const board = state.board;

    // Shuffle hand indices for variety
    const indices = hand.cards
      .map((c, i) => ({ card: c, i }))
      .filter(({ card }) => card !== null)
      .map(({ i }) => i);

    for (const idx of indices) {
      const card = hand.cards[idx];
      if (!card || player.coins < card.cost) continue;

      if (card.cardType === CardType.Unit && card.unitType) {
        const lane = this.chooseLane(state);
        if (lane === null) continue;

        // Spawn units
        const bp = UNIT_BLUEPRINTS[card.unitType];
        player.spendCoins(card.cost);
        hand.play(idx);
        hand.fill(player.deck);

        for (let i = 0; i < bp.spawnCount; i++) {
          const unit = new Unit(card.unitType, Side.Top, lane, TOP_SPAWN_ROW);
          board.addUnit(unit);
          state.pushEvent({ type: 'unit_spawned', unitId: unit.id });
        }
        return; // one action per decision cycle
      }

      if (card.cardType === CardType.Building && card.buildingType) {
        const lane = this.chooseBuildingLane(state);
        if (lane === null) continue;

        player.spendCoins(card.cost);
        hand.play(idx);
        hand.fill(player.deck);

        const building = new Building(card.buildingType, Side.Top, lane, TOP_BUILDING_ROW);
        board.addBuilding(building);
        return;
      }

      if (card.cardType === CardType.Spell && card.spellType) {
        if (card.spellType === SpellType.Haste) {
          player.spendCoins(card.cost);
          hand.play(idx);
          hand.fill(player.deck);
          this.spellSystem.castHaste(Side.Top, state);
          return;
        }

        if (card.spellType === SpellType.Meteor) {
          const target = this.findMeteorTarget(state);
          if (!target) continue;
          player.spendCoins(card.cost);
          hand.play(idx);
          hand.fill(player.deck);
          this.spellSystem.castMeteor(Side.Top, target.col, target.row, state);
          return;
        }
      }
    }
  }

  /** Choose lane with fewest enemy (bottom player) units */
  private chooseLane(state: GameState): number | null {
    let bestLane: number | null = null;
    let minEnemies = Infinity;

    for (const lane of ATTACK_LANES) {
      let count = 0;
      for (const unit of state.board.units.values()) {
        if (unit.side === Side.Bottom && unit.col === lane) count++;
      }
      if (count < minEnemies) {
        minEnemies = count;
        bestLane = lane;
      }
    }
    return bestLane;
  }

  /** Choose a building lane without an existing AI building */
  private chooseBuildingLane(state: GameState): number | null {
    for (const lane of ATTACK_LANES) {
      if (!state.board.hasBuildingAt(lane, TOP_BUILDING_ROW)) return lane;
    }
    return null;
  }

  /** Find a cluster of bottom player units to target with meteor */
  private findMeteorTarget(state: GameState): { col: number; row: number } | null {
    const cells: Record<string, number> = {};
    for (const unit of state.board.units.values()) {
      if (unit.side !== Side.Bottom) continue;
      const key = `${unit.col},${Math.round(unit.row)}`;
      cells[key] = (cells[key] ?? 0) + 1;
    }
    let best: { col: number; row: number } | null = null;
    let bestCount = 1;
    for (const [key, count] of Object.entries(cells)) {
      if (count > bestCount) {
        bestCount = count;
        const [col, row] = key.split(',').map(Number);
        best = { col, row };
      }
    }
    return best;
  }
}
