// Pool of playable-character .tao bundles used for ambient decorative silhouettes
// (e.g. the lobby hero button) — the same six rigs UnitView renders in battle
// (see STICKMAN_ASSETS, render/UnitView.ts), re-exported here so decoration code
// doesn't have to depend on the battle-rendering module.
import infantryTaoUrl from '../assets/infantry.tao';
import archerTaoUrl from '../assets/archer.tao';
import shieldBearerTaoUrl from '../assets/shieldbearer.tao';
import maxTaoUrl from '../assets/max.tao';
import lenaTaoUrl from '../assets/lena.tao';
import maraTaoUrl from '../assets/mara.tao';

const HERO_SILHOUETTE_ASSETS: string[] = [
  infantryTaoUrl, archerTaoUrl, shieldBearerTaoUrl, maxTaoUrl, lenaTaoUrl, maraTaoUrl,
] as unknown as string[];

export function randomHeroAssetUrl(): string {
  return HERO_SILHOUETTE_ASSETS[Math.floor(Math.random() * HERO_SILHOUETTE_ASSETS.length)]!;
}
