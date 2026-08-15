// Edge case for the 2026-07-22 fix (see cityAtlasContentTop.ui.ts for the real-data coverage):
// an atlas JSON packed BEFORE pack_*_atlas.js started emitting `contentTop` (or a frame that's
// simply missing) must not throw or return undefined — the HP bar offset math in
// WorldMapRenderer/city.ts multiplies this value directly, so `undefined` would poison it into
// NaN. Mocks the JSON import (not the whole loader module, unlike worldMapBaseHpBar.ui.ts) to a
// frame set with no `contentTop` field at all, standing in for a stale/pre-fix atlas. cityAtlasLoader
// and playerBaseAtlasLoader now both read the same shared world_atlas.json (see worldAtlas.ts), so
// one mock with both frame families covers both loaders.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/assets/slg/world_atlas.json', () => ({
  default: {
    frames: {
      city_l1: { frame: { x: 0, y: 0, w: 256, h: 256 } },
      city_l10: { frame: { x: 256, y: 0, w: 256, h: 256 } },
      playerbase_l1: { frame: { x: 0, y: 256, w: 256, h: 256 } },
    },
  },
}));

describe('content-top getters fall back to 0 on a pre-fix atlas (no contentTop field)', () => {
  it('getCityContentTopFracForLevel returns 0, not undefined/NaN', async () => {
    const { getCityContentTopFracForLevel } = await import('../../src/render/atlas/cityAtlasLoader');
    expect(getCityContentTopFracForLevel(1)).toBe(0);
    expect(getCityContentTopFracForLevel(10)).toBe(0); // fieldless mock frame, same as level 1
  });

  it('getPlayerBaseContentTopFracForLevel returns 0, not undefined/NaN', async () => {
    const { getPlayerBaseContentTopFracForLevel } = await import('../../src/render/atlas/playerBaseAtlasLoader');
    expect(getPlayerBaseContentTopFracForLevel(1)).toBe(0);
  });
});
