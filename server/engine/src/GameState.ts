import { Board } from './Board';
import { Prng } from './math/prng';
import { Player } from './Player';
import { resetUnitIds } from './Unit';
import { resetBuildingIds } from './Building';
import { EscortUnit, resetEscortIds } from './EscortUnit';
import { UNIT_BLUEPRINTS } from './config';
import { ActiveSpell, GameEvent, GamePhase, OwnerId, PlayerStats, Side, SpellType, UnitType, UnitBlueprint, sideToOwner } from './types';
import type { HazardSpec } from './campaign/LevelDefinition';

/** Mutable version of PlayerStats — accumulated throughout the game. */
export interface PlayerStatsMutable {
  damageDealtToBase: number;
  damageTakenByBase: number;
  unitsSent: number;
  unitsKilled: number;
  spellHits: number;
  /** Per-victim-type kill counts (S9-3b); sparse, absent = 0. */
  killsByType: Partial<Record<UnitType, number>>;
  /** Per-spell-type cast counts (S9-3b); sparse, absent = 0. */
  castsByType: Partial<Record<SpellType, number>>;
  buildingSurvivalTicks: number;
  goldSpent: number;
}

function emptyStats(): PlayerStatsMutable {
  return {
    damageDealtToBase: 0,
    damageTakenByBase: 0,
    unitsSent: 0,
    unitsKilled: 0,
    spellHits: 0,
    killsByType: {},
    castsByType: {},
    buildingSurvivalTicks: 0,
    goldSpent: 0,
  };
}

export class GameState {
  readonly bottomPlayer: Player;
  readonly topPlayer: Player;
  readonly board: Board;

  phase: GamePhase = GamePhase.Idle;

  /**
   * Elapsed ticks since game start (integer, incremented each step).
   * Used by ResourceSystem for acceleration thresholds.
   */
  elapsedTicks: number = 0;

  winner: Side | null = null;

  /** Set to true when the 15-min countdown event has been emitted. */
  countdownStarted: boolean = false;

  /**
   * Number of Top-side (enemy) units that have reached the Bottom player's base
   * during this match. Used by the `leak_limit` campaign objective.
   */
  enemyLeaks: number = 0;

  /**
   * Ids of units spawned with `isBoss === true` (campaign `boss` objective).
   * Registered at spawn time; queried in checkWinCondition.
   */
  bossUnitIds: Set<number> = new Set();

  /** Multiplier applied to the bottom player's ink regen rate (campaign `inkRegenMult`). */
  bottomInkRegenMult: number = 1;

  /** Active hazard zones for this level. Empty in PvP/netplay. */
  hazards: HazardSpec[] = [];

  /** Currently active spell effects. */
  activeSpells: ActiveSpell[] = [];

  /**
   * Columns temporarily blocked by BridgeCollapse. Maps col → tick at which the
   * block expires. Checked by MovementSystem; cleaned up each step().
   */
  tempBlockedCols: Map<number, number> = new Map();

  /**
   * Escort units active in this level (§4.9.3). Populated at construction time
   * by GameEngine for campaign/escort levels; empty in PvP and non-escort PvE.
   */
  escorts: EscortUnit[] = [];

  /** Per-player accumulated stats. Index matches OwnerId (0 = bottom, 1 = top). */
  readonly stats: [PlayerStatsMutable, PlayerStatsMutable] = [emptyStats(), emptyStats()];

  /**
   * Resolved unit blueprints for this match. Defaults to the read-only PvP
   * constants; the engine overwrites it at construction with either
   * buildPvpBlueprints() or buildCampaignBlueprints(save.pveUpgrades) (the hard
   * wall — §5.2). Every unit spawn reads stats from here, NOT the global
   * UNIT_BLUEPRINTS, so PvE upgrades only ever touch the campaign path.
   */
  unitBlueprints: Record<UnitType, UnitBlueprint> = UNIT_BLUEPRINTS;

  private _events: GameEvent[] = [];

  constructor(seed: number) {
    // Reset entity id counters so ids are reproducible across engine instances
    // (deterministic replay). Safe because the client runs one game at a time.
    resetUnitIds();
    resetBuildingIds();
    resetEscortIds();

    // Each player gets separate PRNGs: one for card draws, one for timer stagger offsets.
    const cardPrng0  = new Prng(seed);
    const cardPrng1  = new Prng(seed ^ 0xdeadbeef);
    const timerPrng0 = new Prng(seed ^ 0x12345678);
    const timerPrng1 = new Prng(seed ^ 0x87654321);

    this.bottomPlayer = new Player(Side.Bottom, cardPrng0, timerPrng0);
    this.topPlayer    = new Player(Side.Top,    cardPrng1, timerPrng1);
    this.board        = new Board();
  }

  getPlayer(side: Side): Player {
    return side === Side.Bottom ? this.bottomPlayer : this.topPlayer;
  }

  getOpponent(side: Side): Player {
    return side === Side.Bottom ? this.topPlayer : this.bottomPlayer;
  }

  ownerOf(side: Side): OwnerId {
    return sideToOwner(side);
  }

  /** Snapshot stats as the immutable PlayerStats type for game_stats event. */
  snapshotStats(): [PlayerStats, PlayerStats] {
    // Copy the per-type maps so the snapshot never aliases the still-mutable accumulators.
    return [
      { owner: 0, ...this.stats[0], killsByType: { ...this.stats[0].killsByType }, castsByType: { ...this.stats[0].castsByType } },
      { owner: 1, ...this.stats[1], killsByType: { ...this.stats[1].killsByType }, castsByType: { ...this.stats[1].castsByType } },
    ];
  }

  // ─── Event queue ──────────────────────────────────────────────────────────

  pushEvent(event: GameEvent): void {
    this._events.push(event);
  }

  clearEvents(): void {
    this._events = [];
  }

  get events(): readonly GameEvent[] {
    return this._events;
  }
}
