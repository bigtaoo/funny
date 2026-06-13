import { Scene } from './SceneManager';
import { GameRenderer } from '../render/GameRenderer';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { createGameEngine, IGameEngine, LevelDefinition, OwnerId, PlayerStats } from '../game';

export interface GameSceneCallbacks {
  onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): void;
  onExitToLobby(): void;
}

export interface GameSceneOptions {
  /** When set, the scene runs the PvE campaign level instead of a PvP match. */
  level?: LevelDefinition;
  /**
   * A pre-built engine to drive the scene (online netplay, S1-8): app.ts builds
   * it with mode 'netplay' + a NetInputSource. Takes precedence over `level`.
   */
  engine?: IGameEngine;
}

export class GameScene implements Scene {
  readonly container;
  private readonly renderer: GameRenderer;

  constructor(layout: ILayout, input: InputManager, cb: GameSceneCallbacks, opts: GameSceneOptions = {}) {
    const engine = opts.engine
      ? opts.engine
      : opts.level
      ? createGameEngine({
          seed: opts.level.seed,
          players: [{ id: 0 }, { id: 1 }],
          mode: 'campaign',
          level: opts.level,
        })
      : createGameEngine({
          seed: Date.now() ^ (Math.random() * 0xffffff | 0),
          players: [{ id: 0 }, { id: 1 }],
        });

    this.renderer = new GameRenderer(engine, layout, input);
    this.renderer.init();
    this.renderer.onGameEnd     = cb.onGameEnd;
    this.renderer.onExitToLobby = cb.onExitToLobby;

    this.container = this.renderer.container;
  }

  update(dt: number): void { this.renderer.update(dt); }
  destroy():         void { this.renderer.destroy(); }
}
