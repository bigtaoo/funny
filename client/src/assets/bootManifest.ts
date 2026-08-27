/**
 * bootManifest.ts — the L0 boot tier: the SINGLE source of truth for the minimal
 * asset set the first lobby + first battle need on screen without placeholders
 * (ASSET_PACKAGING §2). `startApp` awaits `preloadBoot` behind a loading screen
 * before revealing the game, so no unit ever flashes as a placeholder circle on
 * the player's first match.
 *
 * L0 is split in two (ASSET_PACKAGING §11). The gate runs its steps in parallel, so
 * its duration on a bandwidth-limited link is set by the tier's TOTAL bytes — which
 * makes it worth asking of every entry not just "is it L0?" but "must the player
 * WAIT for it?":
 *
 *   - {@link STEPS} — blocks the loading screen. Only what the first lobby paint can
 *     show: card art, logo, the icon atlas.
 *   - {@link BACKGROUND_STEPS} — battle-only assets, kicked off (not awaited) once
 *     the gate resolves. `enterBattle`'s own readiness gate (ASSET_PACKAGING §10,
 *     added later than this manifest) already re-awaits every one of them through
 *     the same URL-keyed idempotent loaders before a battle can start, so the
 *     "no placeholder circle in the first match" guarantee is unchanged — it is
 *     simply enforced by the gate that actually precedes a battle rather than by
 *     the one that precedes the lobby.
 *
 * Discipline: keep both lists MINIMAL, and prefer BACKGROUND_STEPS. Everything not
 * strictly needed for the first lobby + first battle is L1 (lazy, fetched on scene
 * entry or by `idlePrefetch`) and must NOT be added here.
 *
 * ⚠ `client/build/preloadBootAssets.js` mirrors both lists to emit `<link rel=preload>`
 * tags; `client/test/bootPreloadManifest.test.ts` fails if the two drift apart.
 */
import { UnitType } from '@nw/engine/types';
import { StickmanRuntime } from '../render/stickman/StickmanRuntime';
import { targetScreenHeight } from '../render/unitSize';
import { decorMergedAtlas } from '../render/atlas/decorMergedAtlas';
import { iconsAtlas } from '../render/atlas/iconsAtlas';
import { preloadTexture } from './preloadTextures';

// Starter-trio skeletal bundles + card illustrations — the only units the first
// battle (tutorial / first PvE) can field. Anna's trio (max/lena/mara) is L1.
import infantryTaoUrl from './units/infantry.tao';
import archerTaoUrl from './units/archer.tao';
import shieldBearerTaoUrl from './units/shieldbearer.tao';
import infantryArtUrl from './units/infantry.png';
import archerArtUrl from './units/archer.png';
import shieldBearerArtUrl from './units/shieldbearer.png';
import baseArtUrl from './buildings/game_base.png';
import barracksArtUrl from './buildings/game_infantry_barracks.png';
import towerArtUrl from './buildings/game_arrow_tower.png';
import logoArtUrl from './logo.png';

interface BootStep {
  /** Stable id (for logging). */
  id: string;
  run: () => Promise<unknown>;
}

/**
 * Blocking tier: card art the lobby's deck/roster rows draw, the header logo, and the
 * equipment/material/faction icon atlas (iconsAtlas.ts — one merged decode shared by
 * three modules, hence one step). ~1.1 MB.
 */
const STEPS: BootStep[] = [
  { id: 'art:infantry',     run: () => preloadTexture(infantryArtUrl     as string) },
  { id: 'art:archer',       run: () => preloadTexture(archerArtUrl       as string) },
  { id: 'art:shieldbearer', run: () => preloadTexture(shieldBearerArtUrl as string) },
  { id: 'art:base',         run: () => preloadTexture(baseArtUrl     as string) },
  { id: 'art:barracks',     run: () => preloadTexture(barracksArtUrl as string) },
  { id: 'art:tower',        run: () => preloadTexture(towerArtUrl    as string) },
  { id: 'art:logo',         run: () => preloadTexture(logoArtUrl    as string) },
  { id: 'icons:merged',     run: () => iconsAtlas.load() },
];

/**
 * Background tier: ~0.5 MB of battle-only assets the lobby never draws — the starter
 * trio's skeletal rigs, and the merged decor atlas (A/C doodle groups + battle corner
 * labels, drawn by decorLayer/decorCLayer/battleLabels/HUD/ResultScene). Every one of
 * these is re-awaited by `ensureBattleAssets` behind `enterBattle`'s loading screen,
 * so moving them off the boot gate cannot make a battle start with placeholders — it
 * only stops the LOBBY from waiting on assets it has no use for.
 */
const BACKGROUND_STEPS: BootStep[] = [
  { id: 'tao:infantry',     run: () => StickmanRuntime.loadAsset(infantryTaoUrl     as string, targetScreenHeight(UnitType.Infantry)) },
  { id: 'tao:archer',       run: () => StickmanRuntime.loadAsset(archerTaoUrl       as string, targetScreenHeight(UnitType.Archer)) },
  { id: 'tao:shieldbearer', run: () => StickmanRuntime.loadAsset(shieldBearerTaoUrl as string, targetScreenHeight(UnitType.ShieldBearer)) },
  { id: 'decor:merged',     run: () => decorMergedAtlas.load() },
];

function runStep(step: BootStep): Promise<unknown> {
  return step.run().catch((err) => console.warn(`[boot] step ${step.id} failed:`, err));
}

/**
 * Load the blocking L0 tier, reporting progress as steps complete, then kick off the
 * background tier without awaiting it. NEVER rejects — a failed step (e.g. a decor
 * atlas, or a .tao that will fall back to its placeholder draft) logs a warning and
 * still advances progress, so a flaky asset can't wedge boot.
 */
export async function preloadBoot(onProgress?: (done: number, total: number) => void): Promise<void> {
  const total = STEPS.length;
  let done = 0;
  onProgress?.(0, total);
  await Promise.all(STEPS.map((step) =>
    runStep(step).finally(() => { done += 1; onProgress?.(done, total); })
  ));
  // After the gate, not before: started earlier these would contend for bandwidth with
  // the tier the player is actually waiting on. The `<link rel=preload fetchpriority=low>`
  // tags (build/preloadBootAssets.js) mean this usually resolves straight out of the
  // HTTP cache anyway.
  void preloadBootBackground();
}

/** Warm the background tier. Exported for `idlePrefetch` to chain onto; idempotent per URL. */
export function preloadBootBackground(): Promise<void> {
  return Promise.all(BACKGROUND_STEPS.map(runStep)).then(() => undefined);
}
