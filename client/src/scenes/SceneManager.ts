import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';

const log = netLog('scene');

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
  /** Set once the current scene's update() has thrown, so we log the fault once instead of every frame. */
  private updateFaulted = false;

  constructor(
    private readonly app: PIXI.Application,
    targetStage?: PIXI.Container,
  ) {
    this.targetStage = targetStage ?? app.stage;
    app.ticker.add(this.onTick, this);
  }

  goto(scene: Scene): void {
    if (this.current) {
      const prev = this.current;
      // Detach first, then destroy — a throwing destroy() must not leave the
      // outgoing scene mounted, and must not abort switching to the new scene.
      this.targetStage.removeChild(prev.container);
      try {
        prev.destroy();
      } catch (e) {
        log.error('scene destroy threw (contained)', errInfo(e));
      }
    }
    this.current = scene;
    this.updateFaulted = false;
    this.targetStage.addChild(scene.container);
  }

  get screenWidth():  number { return this.app.screen.width;  }
  get screenHeight(): number { return this.app.screen.height; }

  private onTick = (): void => {
    const scene = this.current;
    if (!scene) return;
    try {
      scene.update(this.app.ticker.deltaMS / 1000);
    } catch (e) {
      // CRITICAL: this runs on app.ticker, ahead of PIXI's renderer listener. In
      // PIXI 7 a throw from any ticker listener aborts the update loop AND prevents
      // the next requestAnimationFrame from being scheduled — the whole canvas
      // freezes permanently until a page reload (the "UI 切换卡死，只能刷新" report).
      // Contain it so the renderer still paints and the app stays interactive; the
      // player can navigate away (goto resets the flag). Log once per scene so a
      // per-frame re-throw doesn't flood the client-log ring buffer.
      if (!this.updateFaulted) {
        this.updateFaulted = true;
        log.error('scene update threw (contained)', errInfo(e));
      }
    }
  };
}

/** Best-effort error detail (stack when available) for the client-log ring buffer. */
function errInfo(e: unknown): string {
  return e instanceof Error ? (e.stack ?? e.message) : String(e);
}
