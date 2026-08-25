/**
 * battleGate.ts — the pre-match asset-readiness gate shared by PixiAppViews.showGame/showGameNet
 * (ASSET_PACKAGING §10). Pulled out of app.ts on purpose: app.ts imports ~30 scene classes for
 * its other show* methods (including WorldMapScene/FamilyScene/etc., whose import graphs reach
 * `@nw/shared` and therefore require `server/node_modules` to even resolve) — this module only
 * needs assetGate (SceneManager/InputManager/LoadingOverlay) + battleAssets, so it (and its
 * tests) stay cheap to import in isolation.
 */
import type { Scene } from '../scenes/SceneManager';
import { enterWithAssets, type AssetGateDeps } from './assetGate';
import { ensureBattleAssets, type BattleAssetOptions } from '../assets/battleAssets';

export type BattleGateDeps = AssetGateDeps;

/**
 * Warms unit rigs/skins/card art behind a loading screen, then cross-fades into the battle scene.
 * The gate mechanics themselves live in `assetGate.enterWithAssets` (shared with the gacha gate);
 * this is only the battle-specific warm step + the cross-fade choice.
 */
export function enterBattle<T extends Scene>(
  deps: BattleGateDeps,
  opts: BattleAssetOptions,
  build: () => T,
): Promise<T> {
  return enterWithAssets(deps, (onProgress) => ensureBattleAssets(opts, onProgress), build, { fade: true });
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
