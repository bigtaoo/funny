import {
  ATTACK_LANES,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  CARD_DEFINITIONS,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
} from './config';
import { Building } from './Building';
import { Unit } from './Unit';
import { GameState } from './GameState';
import { AISystem } from './systems/AISystem';
import { BuildingProductionSystem } from './systems/BuildingProductionSystem';
import { CombatSystem } from './systems/CombatSystem';
import { MovementSystem } from './systems/MovementSystem';
import { ResourceSystem } from './systems/ResourceSystem';
import { SpellSystem } from './systems/SpellSystem';
import { CardDefinition, CardType, GamePhase, Side, SpellType } from './types';

export class GameEngine {
  readonly state: GameState;

  private readonly resource: ResourceSystem;
  private readonly movement: MovementSystem;
  private readonly combat: CombatSystem;
  private readonly spell: SpellSystem;
  private readonly production: BuildingProductionSystem;
  private readonly ai: AISystem;

  constructor() {
    this.state = new GameState();
    this.resource = new ResourceSystem();
    this.movement = new MovementSystem();
    this.combat = new CombatSystem();
    this.spell = new SpellSystem();
    this.production = new BuildingProductionSystem();
    this.ai = new AISystem(this.spell);
  }

  start(): void {
    this.state.phase = GamePhase.Playing;
  }

  pause(): void {
    this.state.phase = GamePhase.Paused;
  }

  resume(): void {
    if (this.state.phase === GamePhase.Paused) {
      this.state.phase = GamePhase.Playing;
    }
  }

  /** Main game tick — call from render loop with delta time in seconds */
  tick(dt: number): void {
    if (this.state.phase !== GamePhase.Playing) return;

    this.state.elapsedTime += dt;
    this.state.clearEvents();

    this.resource.tick(this.state, dt);
    this.production.tick(this.state, dt);
    this.combat.tick(this.state, dt);
    this.movement.tick(this.state, dt);
    this.spell.tick(this.state, dt);
    this.ai.tick(this.state, dt);

    this.checkWinCondition();
  }

  // ─── Player actions ────────────────────────────────────────────────────────

  /**
   * Bottom player plays a card.
   * @param handIndex Index into player's hand (0–5)
   * @param col       Target column (for unit/building)
   * @param row       Target row center (for spell meteor)
   */
  playCard(handIndex: number, col: number, row?: number): boolean {
    const player = this.state.bottomPlayer;
    const card = player.hand.cards[handIndex];
    if (!card) return false;
    if (player.coins < card.cost) return false;

    if (card.cardType === CardType.Unit && card.unitType) {
      if (!ATTACK_LANES.includes(col as (typeof ATTACK_LANES)[number])) return false;

      const bp = UNIT_BLUEPRINTS[card.unitType];
      player.spendCoins(card.cost);
      player.hand.play(handIndex);
      player.hand.fill(player.deck);

      for (let i = 0; i < bp.spawnCount; i++) {
        const unit = new Unit(card.unitType, Side.Bottom, col, BOTTOM_SPAWN_ROW);
        this.state.board.addUnit(unit);
        this.state.pushEvent({ type: 'unit_spawned', unitId: unit.id });
      }
      return true;
    }

    if (card.cardType === CardType.Building && card.buildingType) {
      if (this.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) return false;

      player.spendCoins(card.cost);
      player.hand.play(handIndex);
      player.hand.fill(player.deck);

      const building = new Building(card.buildingType, Side.Bottom, col, BOTTOM_BUILDING_ROW);
      this.state.board.addBuilding(building);
      return true;
    }

    if (card.cardType === CardType.Spell && card.spellType) {
      if (card.spellType === SpellType.Haste) {
        player.spendCoins(card.cost);
        player.hand.play(handIndex);
        player.hand.fill(player.deck);
        this.spell.castHaste(Side.Bottom, this.state);
        return true;
      }

      if (card.spellType === SpellType.Meteor && row !== undefined) {
        player.spendCoins(card.cost);
        player.hand.play(handIndex);
        player.hand.fill(player.deck);
        this.spell.castMeteor(Side.Bottom, col, row, this.state);
        return true;
      }
    }

    return false;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private checkWinCondition(): void {
    if (this.state.bottomPlayer.isDead) {
      this.state.phase = GamePhase.GameOver;
      this.state.winner = Side.Top;
      this.state.pushEvent({ type: 'game_over', winner: Side.Top });
    } else if (this.state.topPlayer.isDead) {
      this.state.phase = GamePhase.GameOver;
      this.state.winner = Side.Bottom;
      this.state.pushEvent({ type: 'game_over', winner: Side.Bottom });
    }
  }
}
