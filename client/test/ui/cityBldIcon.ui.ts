// Coverage for CityScene/icons.ts's bldIcon() atlas-vs-fallback wiring — previously untested
// for ANY of the six BLD_ATLAS-mapped keys (desk/cabinet/drillYard/wall/satchel/academy), so a
// broken mapping (wrong frame name, atlas check inverted, etc.) would have shipped silently.
// `academy` added 2026-08-17 (design/product/slg-citybld-icon-prompts.md) — it was the one
// BuildingKey left out of the 2026-07-17 batch with no rationale on record; this file locks in
// that it now takes the same atlas-sprite path as its five siblings.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { BuildingKey } from '../../src/net/WorldApiClient';

/** A texture of the given size; never rendered, so no GL context is needed. */
function fakeTex(w: number, h: number): PIXI.Texture {
  return new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: w, height: h }));
}

const ATLAS_KEYS: BuildingKey[] = ['desk', 'cabinet', 'drillYard', 'wall', 'satchel', 'academy'];

describe('CityScene/icons.ts bldIcon() — atlas sprite vs. fallback glyph/emoji', () => {
  it.each(ATLAS_KEYS)('%s takes the city_bld_atlas sprite once the atlas has decoded', async (key) => {
    vi.resetModules();
    vi.doMock('../../src/render/atlas/cityBldAtlasLoader', () => ({
      isCityBldAtlasReady: () => true,
      getCityBldTexture: () => fakeTex(180, 256),
      loadCityBldAtlas: async () => {},
    }));
    const { bldIcon } = await import('../../src/scenes/CityScene/icons');
    const node = bldIcon(key, 60, 0x000000);
    // Exact-constructor check, not instanceof: bldIcon's fallback for `satchel` is PIXI.Text
    // (emoji, no BLD_GLYPH entry) which itself extends PIXI.Sprite in PixiJS — `instanceof
    // Sprite` would pass for that fallback too and hide a broken atlas mapping.
    expect(node.constructor).toBe(PIXI.Sprite);
    const sp = node as PIXI.Sprite;
    expect(sp.width).toBe(60);
    expect(sp.height).toBe(60);
  });

  it.each(ATLAS_KEYS)('%s falls back when the atlas frame is missing (decoded but this key has no frame)', async (key) => {
    vi.resetModules();
    vi.doMock('../../src/render/atlas/cityBldAtlasLoader', () => ({
      isCityBldAtlasReady: () => true,
      getCityBldTexture: () => null,
      loadCityBldAtlas: async () => {},
    }));
    const { bldIcon } = await import('../../src/scenes/CityScene/icons');
    const node = bldIcon(key, 60, 0x000000);
    expect(node.constructor).not.toBe(PIXI.Sprite);
  });

  it('the five resource-producer buildings never touch city_bld_atlas — they route through res_atlas regardless', async () => {
    vi.resetModules();
    const getCityBldTexture = vi.fn(() => fakeTex(180, 256));
    vi.doMock('../../src/render/atlas/cityBldAtlasLoader', () => ({
      isCityBldAtlasReady: () => true,
      getCityBldTexture,
      loadCityBldAtlas: async () => {},
    }));
    const { bldIcon } = await import('../../src/scenes/CityScene/icons');
    for (const key of ['inkPot', 'paperTray', 'graphiteMill', 'metalForge', 'stickerShop'] as BuildingKey[]) {
      bldIcon(key, 60, 0x000000);
    }
    expect(getCityBldTexture).not.toHaveBeenCalled();
  });
});
