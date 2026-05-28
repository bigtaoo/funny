import { Board } from './Board';
import { Prng } from './math/prng';
import { Player } from './Player';
import { ActiveSpell, GameEvent, GamePhase, OwnerId, Side, sideToOwner } from './types';

export class GameState {
  readonly bottomPlayer: Player;
  readonly topPlayer: Player;
  readonly board: Board;

  phase: GamePhase = GamePhase.Idle;

  /**
   * Elapsed ticks since game start (integer, incremented each step).
   * Used by ResourceSystem for acceleration thresholds.
   * Logic layer never stores elapsed time as a float.
   */
  elapsedTicks: number = 0;

  winner: Side | null = null;

  /** Currently active spell effects. */
  activeSpells: ActiveSpell[] = [];

  /**
   * Events produced in the current frame.
   * Cleared at the start of each step() call.
   * The render layer reads these after step() returns.
   */
  private _events: GameEvent[] = [];

  constructor(seed: number) {
    // Each player gets a separate PRNG derived from seed to ensure independent deck orders
    const prng0 = new Prng(seed);
    const prng1 = new Prng(seed ^ 0xdeadbeef);
    this.bottomPlayer = new Player(Side.Bottom, prng0);
    this.topPlayer    = new Player(Side.Top,    prng1);
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
