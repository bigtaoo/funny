/**
 * bootManifest.ts — the L0 boot tier: the SINGLE source of truth for the minimal
 * asset set the first lobby + first battle need on screen without placeholders
 * (ASSET_PACKAGING §2). `startApp` awaits `preloadBoot` behind a loading screen
 * before revealing the game, so no unit ever flashes as a placeholder circle on
 * the player's first match.
 *
 * Discipline: keep this list MINIMAL. Everything not strictly needed for the first
 * lobby + first battle is L1 (lazy, fetched on scene entry) and must NOT be added
 * here — every entry slows the first-load gate.
 */
import * as PIXI from 'pixi.js-legacy';
import { UnitType } from '../game/types';
import { StickmanRuntime } from '../render/stickman/StickmanRuntime';
import { targetScreenHeight } from '../render/unitSize';
import { loadDecorAtlas } from '../render/decorAtlas';
import { loadLabelDecor } from '../render/labelDecor';
import { loadDecorCAtlas } from '../render/decorCAtlas';
import { loadEquipmentAtlas } from '../render/equipmentAtlas';
import { assetIO } from './assetIO';

// Starter-trio skeletal bundles + card illustrations — the only units the first
// battle (tutorial / first PvE) can field. Anna's trio (max/lena/mara) is L1.
import infantryTaoUrl from './infantry.tao';
import archerTaoUrl from './archer.tao';
import shieldBearerTaoUrl from './shieldbearer.tao';
import infantryArtUrl from './infantry.png';
import archerArtUrl from './archer.png';
import shieldBearerArtUrl from './shieldbearer.png';
import baseArtUrl from './game_base.png';
import barracksArtUrl from './game_infantry_barracks.png';
import towerArtUrl from './game_archer_barracks.png';

/** Preheat a PIXI texture: resolve its platform source, decode, resolve when valid. */
function preheatTexture(url: string): Promise<void> {
  return assetIO().textureSource(url).then((src) => new Promise<void>((resolve) => {
    const tex = PIXI.BaseTexture.from(src);
    if (tex.valid) { resolve(); return; }
    tex.once('loaded', () => resolve());
    tex.once('error', () => resolve()); // never block the gate on a single texture
  }));
}

interface BootStep {
  /** Stable id (for logging). */
  id: string;
  run: () => Promise<unknown>;
}

/**
 * The L0 steps. Decor atlases are cosmetic (battle/lobby ambience); the starter
 * .tao + card art are what prevent placeholder circles in the first battle.
 */
const STEPS: BootStep[] = [
  { id: 'tao:infantry',     run: () => StickmanRuntime.loadAsset(infantryTaoUrl     as string, targetScreenHeight(UnitType.Infantry)) },
  { id: 'tao:archer',       run: () => StickmanRuntime.loadAsset(archerTaoUrl       as string, targetScreenHeight(UnitType.Archer)) },
  { id: 'tao:shieldbearer', run: () => StickmanRuntime.loadAsset(shieldBearerTaoUrl as string, targetScreenHeight(UnitType.ShieldBearer)) },
  { id: 'art:infantry',     run: () => preheatTexture(infantryArtUrl     as string) },
  { id: 'art:archer',       run: () => preheatTexture(archerArtUrl       as string) },
  { id: 'art:shieldbearer', run: () => preheatTexture(shieldBearerArtUrl as string) },
  { id: 'art:base',         run: () => preheatTexture(baseArtUrl     as string) },
  { id: 'art:barracks',     run: () => preheatTexture(barracksArtUrl as string) },
  { id: 'art:tower',        run: () => preheatTexture(towerArtUrl    as string) },
  { id: 'decor:atlas',      run: () => loadDecorAtlas() },
  { id: 'decor:labels',     run: () => loadLabelDecor() },
  { id: 'decor:c',          run: () => loadDecorCAtlas() },
  { id: 'equip:atlas',      run: () => loadEquipmentAtlas() },
];

/**
 * Load the L0 tier, reporting progress as steps complete. NEVER rejects — a failed
 * step (e.g. a decor atlas, or a .tao that will fall back to its placeholder draft)
 * logs a warning and still advances progress, so a flaky asset can't wedge boot.
 */
export async function preloadBoot(onProgress?: (done: number, total: number) => void): Promise<void> {
  const total = STEPS.length;
  let done = 0;
  onProgress?.(0, total);
  await Promise.all(STEPS.map((step) =>
    step.run()
      .catch((err) => console.warn(`[boot] step ${step.id} failed:`, err))
      .finally(() => { done += 1; onProgress?.(done, total); })
  ));
}
