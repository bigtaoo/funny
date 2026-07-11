/**
 * baseUpgradeAtlasLoader.ts — battle-base upgrade-tier sprite atlas loader.
 *
 * Two hand-drawn images at 256px each, packed into
 * `assets/base_upgrade_atlas.{png,json}` (see `art/ui/game/pack_base_atlas.js`):
 *   base_lv1 — castle-town (walled settlement, upgradeLevel 1)
 *   base_lv2 — palace (grandest tier, upgradeLevel 2 = max)
 *
 * Tier 0 (no upgrade) keeps using the original `assets/game_base.png`, loaded
 * synchronously at L0 boot — this atlas only covers the upgrade tiers, lazy-loaded
 * like `cityAtlasLoader.ts`. Failure is non-fatal: `BoardView` keeps the current
 * texture until the atlas resolves.
 */
import * as PIXI from 'pixi.js-legacy';
import { assetIO } from '../assets/assetIO';
import atlasUrl from '../assets/base_upgrade_atlas.png';
import atlasData from '../assets/base_upgrade_atlas.json';

let sheet: PIXI.Spritesheet | null = null;
let loading: Promise<void> | null = null;

/** True once the atlas PNG has decoded and frames are parsed. */
export function isBaseUpgradeAtlasReady(): boolean {
  return sheet !== null;
}

/** Texture for an upgrade tier (1-2); null if not loaded yet. */
export function getBaseUpgradeTexture(tier: 1 | 2): PIXI.Texture | null {
  return sheet ? (sheet.textures[`base_lv${tier}`] ?? null) : null;
}

/**
 * Decode + parse the base-upgrade atlas. Idempotent; concurrent calls share one
 * in-flight promise. Failure is non-fatal — bases fall back to the current texture.
 */
export async function loadBaseUpgradeAtlas(): Promise<void> {
  if (sheet) return;
  if (loading) return loading;
  loading = (async () => {
    const baseTex = new PIXI.BaseTexture(await assetIO().textureSource(atlasUrl as string));
    await new Promise<void>((resolve, reject) => {
      if (baseTex.valid) { resolve(); return; }
      baseTex.once('loaded', () => resolve());
      baseTex.once('error', (err: unknown) =>
        reject(new Error(`base upgrade atlas load error: ${String(err)}`)));
    });
    const ss = new PIXI.Spritesheet(baseTex, atlasData as PIXI.ISpritesheetData);
    await ss.parse();
    sheet = ss;
  })();
  return loading;
}
