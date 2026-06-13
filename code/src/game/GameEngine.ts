import {
  ATTACK_LANES,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  CARD_REFRESH_INITIAL_OFFSET_MAX,
  CARD_REFRESH_TICKS,
  COUNTDOWN_THRESHOLD_TICKS,
  FORCE_DRAW_THRESHOLD_TICKS,
  HAND_SIZE,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
  UNIT_BLUEPRINTS,
} from './config';
import { toFp, TICK_RATE } from './math/fixed';
import { cardRefreshDuration } from './Card';
import { Building } from './Building';
import { Player } from './Player';
import { Unit } from './Unit';
import { Prng } from './math/prng';
import { GameState } from './GameState';
import { AISystem } from './systems/AISystem';
import { WaveDirector } from './campaign/WaveDirector';
import { InputSource, LocalInputSource } from './net/InputSource';
import type { LevelDefinition } from './campaign/LevelDefinition';
import { BuildingProductionSystem } from './systems/BuildingProductionSystem';
import { CombatSystem } from './systems/CombatSystem';
import { MovementSystem } from './systems/MovementSystem';
import { ResourceSystem } from './systems/ResourceSystem';
import { SpellSystem } from './systems/SpellSystem';
import {
  CardDefinition,
  CardType,
  GameConfig,
  GameEvent,
  GameMode,
  GamePhase,
  IGameEngine,
  OwnerId,
  ownerToSide,
  PlayerCommand,
  Side,
  SpellType,
  sideToOwner,
  UnitType,
} from './types';

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

class GameEngineImpl implements IGameEngine {
  readonly state: GameState;

  private readonly resource:   ResourceSystem;
  private readonly movement:   MovementSystem;
  private readonly combat:     CombatSystem;
  private readonly spell:      SpellSystem;
  private readonly production: BuildingProductionSystem;
  private readonly ai:         AISystem;

  private readonly mode:          GameMode;
  private readonly level:         LevelDefinition | null;
  private readonly waveDirector:  WaveDirector | null;

  private firstStep = true;
  private accumulatedTime = 0;
  private currentTick = 0;
  private readonly input: InputSource;

  constructor(config: GameConfig, input: InputSource) {
    this.input      = input;
    this.state      = new GameState(config.seed);
    this.resource   = new ResourceSystem();
    this.movement   = new MovementSystem();
    this.combat     = new CombatSystem();
    this.spell      = new SpellSystem();
    this.production = new BuildingProductionSystem();
    this.ai         = new AISystem(new Prng(config.seed ^ 0xA1A1A1A1));

    this.mode = config.mode ?? 'pvp';
    if (this.mode === 'campaign') {
      if (!config.level) throw new Error('campaign mode requires a level definition');
      this.level        = config.level;
      this.waveDirector = new WaveDirector(config.level, new Prng(config.seed ^ 0x5A5A5A5A));

      // Apply level setup: no-build cells (coverage puzzle) + starting coins.
      const noBuild = config.level.board?.cellMask?.noBuild;
      if (noBuild && noBuild.length > 0) this.state.board.setNoBuild(noBuild);
      if (config.level.startCoins) {
        this.state.bottomPlayer.addCoinsFp(toFp(config.level.startCoins));
      }
    } else {
      this.level        = null;
      this.waveDirector = null;
    }
  }

  // ─── Render-facing API ───────────────────────────────────────────────────

  tick(dt: number): void {
    const tickDt = 1 / TICK_RATE;
    this.accumulatedTime += dt;
    while (this.accumulatedTime >= tickDt) {
      // Pull the confirmed command set for this frame from the input pipeline.
      // LocalInputSource never stalls; a net source returns null when the frame
      // is not yet confirmed, in which case we stop advancing (S1-7 buffering).
      const cmds = this.input.take(this.currentTick);
      if (cmds === null) break;
      this.accumulatedTime -= tickDt;
      this.step(this.currentTick++, cmds);
    }
  }

  playCard(handIndex: number, col: number, row?: number): void {
    this.input.submit({ type: 'play_card', owner: 0, tick: this.currentTick, handIndex, col, row });
  }

  upgradeBase(): void {
    this.input.submit({ type: 'upgrade_base', owner: 0, tick: this.currentTick });
  }

  // ─── IGameEngine ─────────────────────────────────────────────────────────

  /**
   * step() execution order:
   *   1. Emit initial events (first call only)
   *   2. AI commands + filtered external commands
   *   3. Process all commands (play_card / upgrade_base)
   *   4. Resources (coin regen)
   *   5. Building production (barracks spawn)
   *   6. Combat (attack, damage, deaths)
   *   7. Movement (advance positions)
   *   8. Spells (duration countdown, expiry)
   *   9. Hand refresh timers
   *  10. Building survival stats
   *  11. Win condition check
   */
  step(tick: number, commands: readonly PlayerCommand[]): readonly GameEvent[] {
    if (this.state.phase === GamePhase.GameOver) return [];

    if (this.state.phase === GamePhase.Idle) {
      this.state.phase = GamePhase.Playing;
    }

    this.state.clearEvents();
    this.state.elapsedTicks++;

    if (this.firstStep) {
      this.firstStep = false;
      this.emitInitialEvents();
    }

    // ── Commands ──────────────────────────────────────────────────────────
    // `commands` is the player's confirmed set for this tick, pulled from the
    // InputSource (M13). AI (practice) and WaveDirector (PvE) are the engine's
    // *other* in-tick input sources, generated deterministically from state.
    const externalCmds = commands.filter((c) => c.tick === tick);
    if (this.mode === 'campaign' && this.waveDirector) {
      // Campaign: process player commands, then spawn scripted enemy waves
      // directly (bypassing the enemy hand/coin economy).
      for (const cmd of externalCmds) {
        this.processCommand(cmd);
      }
      for (const spawn of this.waveDirector.tick(tick)) {
        this.spawnEnemyUnit(spawn.unitType, spawn.col);
      }
    } else if (this.mode === 'netplay') {
      // Online lockstep PvP (S1-7): both sides are humans. `commands` is the
      // server-confirmed set for this frame (already containing BOTH sides'
      // commands, decoded from frame_batch). No local AI runs — the confirmed
      // stream is the *only* input, which is exactly what keeps two clients on
      // the same seed + same stream byte-identical.
      for (const cmd of externalCmds) {
        this.processCommand(cmd);
      }
    } else {
      // PvP: identical ordering to the original — decideTick is evaluated
      // before player commands are processed, then both are processed in turn.
      const aiCmds = this.ai.decideTick(tick, this.state);
      const allCmds = [...externalCmds, ...aiCmds];
      for (const cmd of allCmds) {
        this.processCommand(cmd);
      }
    }

    // ── Systems ───────────────────────────────────────────────────────────
    this.resource.tick(this.state);
    this.production.tick(this.state);
    this.combat.tick(this.state);
    this.movement.tick(this.state);
    this.spell.tick(this.state);

    // ── Hand refresh timers ───────────────────────────────────────────────
    this.tickHandRefresh(Side.Bottom, 0);
    this.tickHandRefresh(Side.Top, 1);

    // ── Building survival stats ───────────────────────────────────────────
    this.accumulateBuildingSurvival();

    this.checkWinCondition();

    return this.state.events;
  }

  // ─── Initial state events ─────────────────────────────────────────────────

  /**
   * Draw 6 cards per player with staggered timers, emit card_drawn + resource_changed.
   * Called once before the first tick's logic runs.
   */
  private emitInitialEvents(): void {
    for (const side of [Side.Bottom, Side.Top] as const) {
      const player = this.state.getPlayer(side);
      const owner  = sideToOwner(side);

      for (let i = 0; i < HAND_SIZE; i++) {
        const stagger = player.timerPrng.nextInt(CARD_REFRESH_INITIAL_OFFSET_MAX + 1);
        const duration = cardRefreshDuration(stagger);
        const card = player.drawPolicy.draw();
        player.hand.drawIntoSlot(i, card, duration);
        this.state.pushEvent({
          type:                'card_drawn',
          owner,
          cardType:            card.cardType,
          handIndex:           i,
          refreshDurationTicks: duration,
        });
      }
      this.state.pushEvent({ type: 'resource_changed', owner, coins: player.coins });
    }
  }

  // ─── Hand refresh timer tick ──────────────────────────────────────────────

  private tickHandRefresh(side: Side, owner: OwnerId): void {
    const player  = this.state.getPlayer(side);
    const expired = player.hand.tickTimers();

    for (const slotIndex of expired) {
      this.state.pushEvent({ type: 'card_expired', owner, handIndex: slotIndex });
      this.drawIntoSlot(player, owner, slotIndex, CARD_REFRESH_TICKS);
    }
  }

  // ─── Command processing ───────────────────────────────────────────────────

  private processCommand(cmd: PlayerCommand): void {
    const side   = ownerToSide(cmd.owner);
    const player = this.state.getPlayer(side);

    if (cmd.type === 'upgrade_base') {
      const cost = player.nextUpgradeCost;
      if (player.upgradeBase()) {
        if (cost !== null) this.state.stats[cmd.owner].goldSpent += cost;
        this.state.pushEvent({ type: 'resource_changed', owner: cmd.owner, coins: player.coins });
      }
      return;
    }

    if (cmd.type === 'play_card') {
      const slot = player.hand.slots[cmd.handIndex];
      if (!slot || player.coins < slot.card.cost) return;
      const card = slot.card;

      // ── Unit card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Unit && card.unitType) {
        const col = cmd.col;
        if (col === undefined || !(ATTACK_LANES as readonly number[]).includes(col)) return;

        const unitType = card.unitType;
        const bp = UNIT_BLUEPRINTS[unitType];
        this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
          const spawnRow = side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
          for (let i = 0; i < bp.spawnCount; i++) {
            const unit = new Unit(unitType, side, col, spawnRow);
            this.state.board.addUnit(unit);
            this.state.stats[cmd.owner].unitsSent++;
            this.state.pushEvent({
              type:      'unit_spawned',
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
              to:       { col: unit.col, y_fp: side === Side.Bottom ? toFp(TOP_BUILDING_ROW) : toFp(BOTTOM_BUILDING_ROW) },
              speed_fp: unit.speed_fp,
            });
          }
        });
        return;
      }

      // ── Building card ─────────────────────────────────────────────────────
      if (card.cardType === CardType.Building && card.buildingType) {
        const col = cmd.col;
        if (col === undefined) return;

        const buildingRow = side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
        if (this.state.board.hasBuildingAt(col, buildingRow)) return;
        if (this.state.board.isNoBuild(col, buildingRow)) return;

        const buildingType = card.buildingType;
        this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
          const building = new Building(buildingType, side, col, buildingRow);
          this.state.board.addBuilding(building);
          this.state.pushEvent({
            type:         'building_placed',
            buildingId:   building.id,
            owner:        cmd.owner,
            buildingType: building.buildingType,
            col:          building.col,
            row:          building.row,
          });
        });
        return;
      }

      // ── Spell card ────────────────────────────────────────────────────────
      if (card.cardType === CardType.Spell && card.spellType) {
        if (card.spellType === SpellType.Haste) {
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castHaste(side, this.state);
          });
          return;
        }

        if (card.spellType === SpellType.Meteor && cmd.col !== undefined && cmd.row !== undefined) {
          const col = cmd.col;
          const row = cmd.row;
          this.consumeCardSlot(player, cmd.owner, cmd.handIndex, card, () => {
            this.spell.castMeteor(side, col, row, this.state);
          });
          return;
        }
      }
    }
  }

  /**
   * Shared bookkeeping for every successful card play: spend the coins, record
   * gold spent, clear the hand slot, emit `card_played`, run the card-specific
   * `effect`, then draw a replacement and emit `resource_changed`.
   *
   * Event order (spend → card_played → effect events → card_drawn →
   * resource_changed) is identical to the previous inline branches, so the
   * golden-replay determinism contract is preserved.
   */
  private consumeCardSlot(
    player: Player,
    owner: OwnerId,
    handIndex: number,
    card: CardDefinition,
    effect: () => void,
  ): void {
    player.spendCoins(card.cost);
    this.state.stats[owner].goldSpent += card.cost;
    player.hand.play(handIndex);
    this.state.pushEvent({ type: 'card_played', owner, handIndex });
    effect();
    this.drawIntoSlot(player, owner, handIndex, CARD_REFRESH_TICKS);
    this.state.pushEvent({ type: 'resource_changed', owner, coins: player.coins });
  }

  // ─── Campaign: scripted enemy spawn ────────────────────────────────────────

  /**
   * Spawn a single enemy (Top side, owner 1) unit on `col`, bypassing the
   * hand/coin economy. Emits the same unit_spawned / unit_move_start events as
   * a card play, so the render layer needs no campaign-specific handling.
   */
  private spawnEnemyUnit(unitType: UnitType, col: number): void {
    const side: Side = Side.Top;
    const owner: OwnerId = 1;
    const unit = new Unit(unitType, side, col, TOP_SPAWN_ROW);
    this.state.board.addUnit(unit);
    this.state.stats[owner].unitsSent++;
    this.state.pushEvent({
      type:      'unit_spawned',
      unitId:    unit.id,
      owner,
      unitType:  unit.unitType,
      col:       unit.col,
      y_fp:      unit.y_fp,
      radius_fp: unit.radius_fp,
    });
    this.state.pushEvent({
      type:     'unit_move_start',
      unitId:   unit.id,
      from:     { col: unit.col, y_fp: unit.y_fp },
      to:       { col: unit.col, y_fp: toFp(BOTTOM_BUILDING_ROW) },
      speed_fp: unit.speed_fp,
    });
  }

  /** Whether any living Top-side (enemy) unit is still on the board. */
  private hasLivingEnemyUnits(): boolean {
    for (const unit of this.state.board.units.values()) {
      if (unit.side === Side.Top && !unit.isDead) return true;
    }
    return false;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Draw one card into a hand slot and emit card_drawn. */
  private drawIntoSlot(player: Player, owner: OwnerId, slotIndex: number, duration: number): void {
    const card = player.drawPolicy.draw();
    player.hand.drawIntoSlot(slotIndex, card, duration);
    this.state.pushEvent({
      type:                'card_drawn',
      owner,
      cardType:            card.cardType,
      handIndex:           slotIndex,
      refreshDurationTicks: duration,
    });
  }

  private accumulateBuildingSurvival(): void {
    for (const building of this.state.board.buildings.values()) {
      if (!building.isDead) {
        const owner = this.state.ownerOf(building.side);
        this.state.stats[owner].buildingSurvivalTicks++;
      }
    }
  }

  private checkWinCondition(): void {
    if (this.state.phase === GamePhase.GameOver) return;

    if (this.state.bottomPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Top;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_over', winner: 1 });
      return;
    }

    // ── Campaign objectives ──────────────────────────────────────────────────
    if (this.mode === 'campaign') {
      // Wiping the enemy base always wins.
      if (this.state.topPlayer.isDead) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Bottom;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 0 });
        return;
      }
      const objective = this.level!.objective;
      const survived =
        objective.kind === 'timed_defense'
          ? this.state.elapsedTicks >= objective.durationTicks
          : this.waveDirector!.exhausted && !this.hasLivingEnemyUnits();
      if (survived) {
        this.state.phase  = GamePhase.GameOver;
        this.state.winner = Side.Bottom;
        this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
        this.state.pushEvent({ type: 'game_over', winner: 0 });
      }
      // Campaign skips the PvP countdown / force-draw timers.
      return;
    }

    if (this.state.topPlayer.isDead) {
      this.state.phase  = GamePhase.GameOver;
      this.state.winner = Side.Bottom;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_over', winner: 0 });
      return;
    }

    if (this.state.elapsedTicks >= FORCE_DRAW_THRESHOLD_TICKS) {
      this.state.phase = GamePhase.GameOver;
      this.state.pushEvent({ type: 'game_stats', stats: this.state.snapshotStats() });
      this.state.pushEvent({ type: 'game_draw' });
      return;
    }

    if (
      !this.state.countdownStarted &&
      this.state.elapsedTicks >= COUNTDOWN_THRESHOLD_TICKS
    ) {
      this.state.countdownStarted = true;
      this.state.pushEvent({ type: 'game_countdown_start' });
    }
  }
}
