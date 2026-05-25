import { Board } from './Board';
import { Player } from './Player';
import { ActiveSpell, GamePhase, Side } from './types';

export class GameState {
  readonly bottomPlayer: Player;
  readonly topPlayer: Player;
  readonly board: Board;

  phase: GamePhase = GamePhase.Idle;
  elapsedTime: number = 0; // seconds since game start
  winner: Side | null = null;

  /** Currently active spell effects */
  activeSpells: ActiveSpell[] = [];

  /** Pending events for the render layer (cleared each frame after render) */
  events: GameEvent[] = [];

  constructor() {
    this.bottomPlayer = new Player(Side.Bottom);
    this.topPlayer = new Player(Side.Top);
    this.board = new Board();
  }

  getPlayer(side: Side): Player {
    return side === Side.Bottom ? this.bottomPlayer : this.topPlayer;
  }

  getOpponent(side: Side): Player {
    return side === Side.Bottom ? this.topPlayer : this.bottomPlayer;
  }

  pushEvent(event: GameEvent): void {
    this.events.push(event);
  }

  clearEvents(): void {
    this.events = [];
  }
}

// ─── Events (game logic → render layer) ──────────────────────────────────────

export type GameEvent =
  | { type: 'unit_attacked'; attackerId: number; targetId: number; damage: number }
  | { type: 'unit_died'; unitId: number }
  | { type: 'building_attacked'; attackerId: number; buildingId: number; damage: number }
  | { type: 'building_destroyed'; buildingId: number }
  | { type: 'base_damaged'; side: Side; damage: number }
  | { type: 'spell_cast'; spellType: string; side: Side; col?: number; row?: number }
  | { type: 'unit_spawned'; unitId: number }
  | { type: 'game_over'; winner: Side };
