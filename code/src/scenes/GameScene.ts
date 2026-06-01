import { Scene } from './SceneManager';
import { GameRenderer } from '../render/GameRenderer';
import { createGameEngine, OwnerId, PlayerStats } from '../game';

export interface GameSceneCallbacks {
  onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): void;
  onExitToLobby(): void;
}

/**
 * Wraps GameRenderer as a Scene.
 * Creates a new engine (with a fresh random seed) each time it's instantiated.
 */
export class GameScene implements Scene {
  readonly container;
  private readonly renderer: GameRenderer;

  constructor(w: number, h: number, cb: GameSceneCallbacks) {
    const engine = createGameEngine({
      seed: Date.now() ^ (Math.random() * 0xffffff | 0),
      players: [{ id: 0 }, { id: 1 }],
    });

    this.renderer = new GameRenderer(engine, w, h);
    this.renderer.init();
    this.renderer.onGameEnd = cb.onGameEnd;
    this.renderer.onExitToLobby = cb.onExitToLobby;

    this.container = this.renderer.container;
  }

  update(dt: number): void {
    this.renderer.update(dt);
  }

  destroy(): void {
    this.renderer.destroy();
  }
}
