/**
 * battleAssets.ts — pre-match asset readiness gate for PvP / PvE (ASSET_PACKAGING §10).
 *
 * `UnitView` loads every unit's `.tao` rig — including skin overrides — fire-and-forget at
 * `GameScene` construction time, falling back to the colored-circle placeholder until each
 * resolves (see `UnitView.loadAssetsInto`); `GameScene` does the same for L1 hero/spell card
 * art (`preloadL1CardArtTextures`, `void`-ed). Both are fine once everything is warm (repeat
 * matches in a session), but the FIRST time a session fields a rarely-used unit type or an
 * equipped skin, entering the scene could flash a placeholder for a few frames — exactly the
 * "进场才发现没资源" complaint this closes.
 *
 * `ensureBattleAssets` pre-warms the same caches for the actual roster about to be used, so
 * `app.ts`'s `enterBattle` can await it behind a loading screen before the scene is ever built.
 * Both `StickmanRuntime.loadAsset` and `preloadTexture` are idempotent/URL-cached, so this
 * costs nothing extra once `UnitView`/`GameScene` redundantly call the same loaders again —
 * it just means the cache is already warm by the time they do.
 *
 * Deliberately warms the FULL `STICKMAN_ASSETS` set, not just the two decks actually in play:
 * PvP's opponent roster (AI pick, or a real opponent's deck) isn't known at nav time, and the
 * set is small (12 units total) and cached after first use — unconditional coverage is simpler
 * and safer than precomputing exactly which units a given match can field. This also naturally
 * covers PvE (campaign levels can field the myth-creature roster) without level-specific logic.
 */
import { UnitType } from '@nw/engine/types';
import { StickmanRuntime } from '../render/stickman/StickmanRuntime';
import { STICKMAN_ASSETS, resolveSkinOverrides } from '../render/UnitView';
import { targetScreenHeight } from '../render/unitSize';
import { preloadL1CardArtTextures } from '../render/cardArt';
import { decorMergedAtlas } from '../render/atlas/decorMergedAtlas';

export interface BattleAssetOptions {
  /** Local player's equipped skin ids (LOBBY_IA_REDESIGN §15). */
  equippedSkins?: readonly string[];
  /** Opponent's equipped skin ids, when known (real net PvP only). */
  opponentSkins?: readonly string[];
}

/**
 * Warms StickmanRuntime's `.tao` cache for every unit type + both sides' equipped skins, plus
 * L1 hero/spell card art. Never rejects (each step is individually caught, mirroring
 * `bootManifest.preloadBoot`) — a single flaky asset degrades to its existing placeholder
 * instead of wedging the pre-match gate.
 */
export function ensureBattleAssets(
  opts: BattleAssetOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const urls = new Map<string, number>(); // url -> targetScreenHeight, deduped
  const addAll = (set: Partial<Record<UnitType, string>>): void => {
    for (const [type, url] of Object.entries(set) as [UnitType, string][]) {
      if (url) urls.set(url, targetScreenHeight(type));
    }
  };
  addAll(STICKMAN_ASSETS);
  addAll(resolveSkinOverrides(opts.equippedSkins ?? []));
  addAll(resolveSkinOverrides(opts.opponentSkins ?? []));

  const steps: Array<() => Promise<unknown>> = [
    ...Array.from(urls, ([url, h]) => () => StickmanRuntime.loadAsset(url, h)),
    () => preloadL1CardArtTextures(),
    // Battle ambience + corner labels (decorLayer/decorCLayer/battleLabels/HUD, and
    // ResultScene right after). Used to ride the L0 boot gate; since it became a
    // background-tier boot step (ASSET_PACKAGING §11) this gate is what guarantees it
    // is decoded before the battle draws its first frame. Idempotent — free when warm.
    () => decorMergedAtlas.load(),
  ];
  const total = steps.length;
  let done = 0;
  onProgress?.(0, total);
  return Promise.all(steps.map((run) =>
    run()
      .catch((err) => console.warn('[battleAssets] step failed:', err))
      .finally(() => { done += 1; onProgress?.(done, total); })
  )).then(() => undefined);
}
