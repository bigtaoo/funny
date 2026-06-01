import * as PIXI from 'pixi.js-legacy';

// ─── Base scene interface ─────────────────────────────────────────────────────

export interface Scene {
  /** Root display object — SceneManager adds/removes this from the stage. */
  readonly container: PIXI.Container;
  /** Called every render frame. */
  update(dt: number): void;
  /** Called when the scene is removed. Clean up listeners, timers, etc. */
  destroy(): void;
}

// ─── SceneManager ─────────────────────────────────────────────────────────────

/**
 * Manages the active scene.  One PIXI.Application is shared; scenes are
 * PIXI.Container subtrees that get swapped in and out of app.stage.
 */
export class SceneManager {
  private current: Scene | null = null;

  constructor(private readonly app: PIXI.Application) {
    app.ticker.add(this.onTick, this);
  }

  /** Transition to a new scene. Destroys the previous one. */
  goto(scene: Scene): void {
    if (this.current) {
      this.app.stage.removeChild(this.current.container);
      this.current.destroy();
    }
    this.current = scene;
    this.app.stage.addChild(scene.container);
  }

  get screenWidth(): number  { return this.app.screen.width;  }
  get screenHeight(): number { return this.app.screen.height; }

  private onTick = (): void => {
    if (!this.current) return;
    const dt = this.app.ticker.deltaMS / 1000;
    this.current.update(dt);
  };
}
