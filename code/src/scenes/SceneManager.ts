import * as PIXI from 'pixi.js-legacy';

// ── Base scene interface ───────────────────────────────────────────────────────

export interface Scene {
  readonly container: PIXI.Container;
  update(dt: number): void;
  destroy(): void;
}

// ── SceneManager ───────────────────────────────────────────────────────────────

/**
 * Manages the active scene.  Scenes are added to `targetStage` (defaults to
 * `app.stage`).  Pass `ScalingManager.gameLayer` as `targetStage` so that all
 * scene content goes through the Contain-scaled game layer.
 */
export class SceneManager {
  private current: Scene | null = null;
  private readonly targetStage: PIXI.Container;

  constructor(
    private readonly app: PIXI.Application,
    targetStage?: PIXI.Container,
  ) {
    this.targetStage = targetStage ?? app.stage;
    app.ticker.add(this.onTick, this);
  }

  goto(scene: Scene): void {
    if (this.current) {
      this.targetStage.removeChild(this.current.container);
      this.current.destroy();
    }
    this.current = scene;
    this.targetStage.addChild(scene.container);
  }

  get screenWidth():  number { return this.app.screen.width;  }
  get screenHeight(): number { return this.app.screen.height; }

  private onTick = (): void => {
    if (!this.current) return;
    this.current.update(this.app.ticker.deltaMS / 1000);
  };
}
