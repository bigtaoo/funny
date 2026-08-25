/**
 * assetGate.ts — the shared "warm the assets behind a loading screen, THEN build the scene"
 * primitive (ASSET_PACKAGING §10).
 *
 * §10 introduced this shape for battles only, as `battleGate.enterBattle`. It turned out to be
 * the general answer to the complaint that motivated §10 ("进场才发现没资源") rather than a
 * battle-specific one, so the mechanism lives here and each destination supplies just its own
 * warm function. `battleGate.ts` keeps `enterBattle` as its thin wrapper (it also owns the
 * battle-specific `DeferredSceneCalls`); `PixiAppViews.showGacha` is the second caller.
 *
 * Deliberately parameterised on a `warm(onProgress)` callback rather than on an asset list: the
 * two callers warm quite different things (skeletal rigs + skin overrides vs. a flat texture
 * list) and both already have an idempotent, never-rejecting loader of their own.
 */
import * as PIXI from 'pixi.js-legacy';
import type { Scene, SceneManager, GotoOptions } from '../scenes/SceneManager';
import type { InputManager } from '../inputSystem/InputManager';
import { LoadingOverlay } from '../ui/LoadingOverlay';

export interface AssetGateDeps {
  app: PIXI.Application;
  manager: SceneManager;
  input: InputManager;
}

/** A never-rejecting, idempotent warm step that reports progress as sub-steps settle. */
export type WarmAssets = (onProgress: (done: number, total: number) => void) => Promise<void>;

/**
 * Freezes input (pointer input bypasses PIXI — a bare visual overlay can't block taps on the
 * still-live outgoing scene, same reasoning as SceneManager's own fade-transition input gate),
 * shows a LoadingOverlay while `warm` runs, THEN builds + gotos the real scene.
 *
 * `fade` is opt-in because the two call sites differ: entering a battle cross-fades, while the
 * menu screens switch instantly. When faded, `manager.goto(..., {fade:true})`'s own transition
 * takes over un-suppressing input once the fade settles; otherwise this releases it directly.
 */
export async function enterWithAssets<T extends Scene>(
  deps: AssetGateDeps,
  warm: WarmAssets,
  build: () => T,
  opts?: { fade?: boolean },
): Promise<T> {
  deps.input.suppress(true);
  const overlay = new LoadingOverlay(deps.app);
  try {
    await warm((done, total) => overlay.setProgress(total ? done / total : 1));
  } finally {
    // `warm` is contractually non-rejecting, but a gate that can strand the player behind a
    // loading screen with input frozen is a bad enough failure mode to defend against anyway.
    overlay.destroy();
  }
  const scene = build();
  if (opts?.fade) {
    const gotoOpts: GotoOptions = { fade: true };
    deps.manager.goto(scene, gotoOpts);
  } else {
    deps.manager.goto(scene);
    deps.input.suppress(false);
  }
  return scene;
}
