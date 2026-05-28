import {
  ATTACK_LANES,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  BOTTOM_TRANSIT_ROW,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
} from './config';
import { fp, toFp } from './math/fixed';
import { Building } from './Building';
import { Player } from './Player';
import { Unit } from './Unit';
import { GameState } from './GameState';
import { AISystem } from './systems/AISystem';
import { BuildingProductionSystem } from './systems/BuildingProductionSystem';
import { CombatSystem } from './systems/CombatSystem';
import { MovementSystem } from './systems/MovementSystem';
import { ResourceSystem } from './systems/ResourceSystem';
import { SpellSystem } from './systems/SpellSystem';
import {
  CardType,
  GameConfig,
  GameEvent,
  GamePhase,
  IGameEngine,
  OwnerId,
  ownerToSide,
  PlayerCommand,
  Side,
  SpellType,
  sideToOwner,
} from './types';

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a game engine. This is the ONLY public constructor.
 * Returns IGameEngine — the render layer never touches the concrete class.
 *
 * @param config  Must include a `seed` for deterministic PRNG. No default.
 */
export function createGameEngine(config: GameConfig): IGameEngine {
  return new GameEngineImpl(config);
}

// ─── Implementation (not exported) ───────────────────────────────────────────

class GameEngineImpl implements IGameEngine {
  private readonly state: GameState;

  private readonly resource:   ResourceSystem;
  private readonly movement:   MovementSystem;
  private readonly combat:     CombatSystem;
  private readonly spell:      SpellSystem;
  private readonly production: BuildingProductionSystem;
  private readonly ai:         AISystem;

  /** True until the first step() call. */
  private firstStep = true;

  constructor(config: GameConfig) {
    // seed is required — no Date.now() fallback (would break determinism)
    this.state      = new GameState(config.seed);
    this.resource   = new ResourceSystem();
    this.movement   = new MovementSystem();
    this.combat     = new CombatSystem();
    this.spell      = new SpellSystem();
    this.production = new BuildingProductionSystem();
    this.ai         = new AISystem();
  }

  // ─── IGameEngine ─────────────────────────────────────────────────────────

  /**
   * Advance game state by exactly one logic frame (1/30 s).
   * Returns all GameEvents produced this frame.
   *
   * First call (any tick): also emits initial state events (starting hands, etc.)
   * so the render layer can build its initial view from events alone.
   *
   * step() execution order:
   *   1. Emit initial events (first call only)
   *   2. AI commands + filtered external commands
   *   3. Process all commands (play_card / upgrade_base)
   *   4. Resources (coin regen)
   *   5. Building production (barracks spawn)
   *   6. Combat (attack, damage, deaths)
   *   7. Movement (advance positions)
   *   8. Spells (duration countdown, expiry)
   *   9. Win condition check
   */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
    if (this.state.phase === GamePhase.GameOver) return [];

    // Transition Idle → Playing on first step
    if (this.state.phase === GamePhase.Idle) {
      this.state.phase = GamePhase.Playing;
    }

    this.state.clearEvents();
    this.state.elapsedTicks++;

    // ── Emit initial state events on very first call ───────────────────────
    if (this.firstStep) {
      this.firstStep = false;
      this.emitInitialEvents();
    }

    // ── Commands ──────────────────────────────────────────────────────────
    const aiCmds = this.ai.decideTick(tick, this.state);
    const allCmds = [
      ...commands.filter((c) => c.tick === tick),
      ...aiCmds,
    ];
    for (const cmd of allCmds) {
      this.processCommand(cmd);
    }

    // ── Systems ───────────────────────────────────────────────────────────
    this.resource.tick(this.state);
    this.production.tick(this.state);
    this.combat.tick(this.state);
    this.movement.tick(this.state);
    this.spell.tick(this.state);

    this.checkWinCondition();

    return this.state.events;
  }

  // ─── Initial state events ─────────────────────────────────────────────────

  /**
   * Emit card_drawn + resource_changed events for both players' starting state.
   * Called once, before the first tick's normal logic runs.
   * The render layer uses these events to set up the initial UI.
   */
  private emitInitialEvents(): void {
    for (const side of [Side.Bottom, Side.Top] as const) {
      const player = this.state.getPlayer(side);
      const owner  = sideToOwner(side);

      for (let i = 0; i < player.hand.cards.length; i++) {
        const card = player.hand.cards[i];
        if (card) {
          this.state.pushEvent({ type: 'card_drawn', owner, cardType: card.cardType, handIndex: i });
        }
      }
      this.state.pushEvent({ type: 'resource_changed', owner, coins: player.coins });
    }
  }

  // ─── Command processing ───────────────────────────────────────────────────

  private processCommand(cmd: PlayerCommand): void {
    const side   = ownerToSide(cmd.owner);
    const player = this.state.getPlayer(side);

    if (cmd.type === 'upgrade_base') {
      if (player.upgradeBase()) {
        this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
      }
      return;
    }

    if (cmd.type === 'play_card') {
      const card = player.hand.cards[cmd.handIndex];
      if (!card || player.coins < card.cost) return;

      // ── Unit card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Unit && card.unitType) {
        const col = cmd.col;
        if (col === undefined || !(ATTACK_LANES as readonly number[]).includes(col)) return;

        const bp = UNIT_BLUEPRINTS[card.unitType];
        player.spendCoins(card.cost);
        player.hand.play(cmd.handIndex);
        this.state.pushEvent({ type: 'card_played', owner: cmd.owner, handIndex: cmd.handIndex });

        const spawnRow = side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
        for (let i = 0; i < bp.spawnCount; i++) {
          const unit = new Unit(card.unitType, side, col, spawnRow);
          this.state.board.addUnit(unit);
          this.state.pushEvent({
            type: 'unit_spawned',
            unitId:    unit.id,
            owner:     cmd.owner,
            unitType:  unit.unitType,
            col:       unit.col,
            y_fp:      unit.y_fp,
            radius_fp: unit.radius_fp,
          });
          this.state.pushEvent({
            type:     'unit_move_start',
            unitId:   unit.id,
            from:     { col: unit.col, y_fp: unit.y_fp },
            to:       { col: unit.col, y_fp: side === Side.Bottom ? fp(0) : toFp(BOTTOM_TRANSIT_ROW) },
            speed_fp: unit.speed_fp,
          });
        }

        this.refillHand(player, cmd.owner);
        this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
        return;
      }

      // ── Building card ─────────────────────────────────────────────────────
      if (card.cardType === CardType.Building && card.buildingType) {
        const col = cmd.col;
        if (col === undefined) return;

        const buildingRow = side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
        if (this.state.board.hasBuildingAt(col, buildingRow)) return;

        player.spendCoins(card.cost);
        player.hand.play(cmd.handIndex);
        this.state.pushEvent({ type: 'card_played', owner: cmd.owner, handIndex: cmd.handIndex });

        const building = new Building(card.buildingType, side, col, buildingRow);
        this.state.board.addBuilding(building);
        this.state.pushEvent({
          type:         'building_placed',
          buildingId:   building.id,
          owner:        cmd.owner,
          buildingType: building.buildingType,
          col:          building.col,
          row:          building.row,
        });

        this.refillHand(player, cmd.owner);
        this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
        return;
      }

      // ── Spell card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Spell && card.spellType) {
        if (card.spellType === SpellType.Haste) {
          player.spendCoins(card.cost);
          player.hand.play(cmd.handIndex);
          this.state.pushEvent({ type: 'card_played', owner: cmd.owner, handIndex: cmd.handIndex });
          this.spell.castHaste(side, this.state);
          this.refillHand(player, cmd.owner);
          this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
          return;
        }

        if (card.spellType === SpellType.Meteor && cmd.col !== undefined && cmd.row !== undefined) {
          player.spendCoins(card.cost);
          player.hand.play(cmd.handIndex);
          this.state.pushEvent({ type: 'card_played', owner: cmd.owner, handIndex: cmd.handIndex });
          this.spell.castMeteor(side, cmd.col, cmd.row, this.state);
          this.refillHand(player, cmd.owner);
          this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
          return;
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private refillHand(player: Player, owner: OwnerId): void {
    const drawn = player.hand.fill(player.deck);
    for (const { index, card } of drawn) {
      this.state.pushEvent({ type: 'card_drawn', owner, cardType: card.cardType, handIndex: index });
    }
  }

  private checkWinCondition(): void {
    if (this.state.phase === GamePhase.GameOver) return;

    if (this.state.bottomPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Top;
      this.state.pushEvent({ type: 'game_over', winner: 1 });
    } else if (this.state.topPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Bottom;
      this.state.pushEvent({ type: 'game_over', winner: 0 });
    }
  }

}
