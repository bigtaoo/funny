/**
 * battleGate.ts — the pre-match asset-readiness gate shared by PixiAppViews.showGame/showGameNet
 * (ASSET_PACKAGING §10). Pulled out of app.ts on purpose: app.ts imports ~30 scene classes for
 * its other show* methods (including WorldMapScene/FamilyScene/etc., whose import graphs reach
 * `@nw/shared` and therefore require `server/node_modules` to even resolve) — this module only
 * needs SceneManager/InputManager/LoadingOverlay/battleAssets, so it (and its tests) stay cheap
 * to import in isolation.
 */
import * as PIXI from 'pixi.js-legacy';
import type { Scene, SceneManager, GotoOptions } from '../scenes/SceneManager';
import type { InputManager } from '../inputSystem/InputManager';
import { LoadingOverlay } from '../ui/LoadingOverlay';
import { ensureBattleAssets, type BattleAssetOptions } from '../assets/battleAssets';

export interface BattleGateDeps {
  app: PIXI.Application;
  manager: SceneManager;
  input: InputManager;
}

/**
 * Freezes input (pointer input bypasses PIXI — a bare visual overlay can't block taps on the
 * still-live outgoing scene, same reasoning as SceneManager's own fade-transition input gate),
 * shows a LoadingOverlay while `ensureBattleAssets` warms unit rigs/skins/card art, THEN builds +
 * gotos the real scene with a cross-fade. `manager.goto(..., {fade:true})`'s own transition takes
 * over un-suppressing input once the fade settles — calling `suppress(true)` again there is a
 * harmless no-op.
 */
export async function enterBattle<T extends Scene>(
  deps: BattleGateDeps,
  opts: BattleAssetOptions,
  build: () => T,
): Promise<T> {
  deps.input.suppress(true);
  const overlay = new LoadingOverlay(deps.app);
  await ensureBattleAssets(opts, (done, total) => overlay.setProgress(total ? done / total : 1));
  overlay.destroy();
  const scene = build();
  const gotoOpts: GotoOptions = { fade: true };
  deps.manager.goto(scene, gotoOpts);
  return scene;
}

/**
 * Buffers calls meant for a scene that doesn't exist yet — e.g. showGameNet must return a
 * NetGameView synchronously (the caller wires session.handlers to it right away), but
 * `enterBattle`'s loading gate means the actual GameScene isn't built until some time later, and
 * a server push (net_state/peer_dc/match_over) can legitimately arrive in that window since the
 * socket is already live. Calls made before `resolve()` are queued and flushed in order once the
 * scene exists; calls made after `resolve()` apply immediately. `GameScene`'s own destroyed-guard
 * covers the symmetric case (a push arriving after the scene is torn down) — this covers "before
 * it's built yet".
 */
export class DeferredSceneCalls<S> {
  private scene: S | null = null;
  private readonly pending: Array<(s: S) => void> = [];

  call(fn: (s: S) => void): void {
    if (this.scene) fn(this.scene);
    else this.pending.push(fn);
  }

  resolve(scene: S): void {
    this.scene = scene;
    this.pending.splice(0).forEach((fn) => fn(scene));
  }
}
