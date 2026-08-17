// Coverage for the 2026-08-08 "进场才发现没资源" fix (ASSET_PACKAGING §10): `ensureBattleAssets`
// must warm StickmanRuntime's cache for every default unit type PLUS both sides' equipped-skin
// overrides, plus L1 hero/spell card art — and must never reject, even when an individual asset
// fails, so app.ts's pre-match loading gate can't get stuck on one flaky asset.
//
// Lives under test/ui/ (not the plain test/ root) purely because it imports UnitView.ts, which
// pulls in raw `.tao`/`.png` asset imports — only vitest.ui.config.ts's stubBinaryAssets plugin
// (`*.png`/`*.tao` import → 1×1 PNG data URI) can resolve those; this file has no PIXI/UI content.
import { describe, it, expect, vi } from 'vitest';
import { UnitType } from '@nw/engine/types';

const loadAssetCalls: Array<{ url: string; targetHeight?: number }> = [];
let failUrl: string | null = null;

vi.mock('../../src/render/stickman/StickmanRuntime', () => ({
  StickmanRuntime: {
    loadAsset: vi.fn((url: string, targetHeight?: number) => {
      loadAssetCalls.push({ url, targetHeight });
      if (url === failUrl) return Promise.reject(new Error('boom'));
      return Promise.resolve({ naturalHeight: 100 });
    }),
  },
}));

const cardArtCalls: number[] = [];
vi.mock('../../src/render/cardArt', () => ({
  preloadL1CardArtTextures: vi.fn(() => { cardArtCalls.push(1); return Promise.resolve(); }),
}));

// Battle ambience/corner labels, a background-tier boot step since ASSET_PACKAGING §11 — so this
// gate is now what guarantees it before the first battle frame. Mocked for the same reason as the
// two above, and additionally because the real loader would hand PIXI.Spritesheet the stub 1×1
// data URI and never resolve.
const decorAtlasCalls: number[] = [];
vi.mock('../../src/render/atlas/decorMergedAtlas', () => ({
  decorMergedAtlas: { load: vi.fn(() => { decorAtlasCalls.push(1); return Promise.resolve(); }) },
}));

// Imported AFTER vi.mock (vitest hoists mock registration above all imports regardless of
// physical order — see marchTokenScale.ui.ts for the same pattern).
import { ensureBattleAssets } from '../../src/assets/battleAssets';
import { STICKMAN_ASSETS, resolveSkinOverrides } from '../../src/render/UnitView';

describe('ensureBattleAssets', () => {
  it('warms every default unit .tao plus L1 card art and the decor atlas when no skins are equipped', async () => {
    loadAssetCalls.length = 0;
    cardArtCalls.length = 0;
    decorAtlasCalls.length = 0;
    await ensureBattleAssets({});
    const urls = new Set(loadAssetCalls.map((c) => c.url));
    for (const url of Object.values(STICKMAN_ASSETS)) expect(urls.has(url as string)).toBe(true);
    expect(cardArtCalls.length).toBe(1);
    expect(decorAtlasCalls.length).toBe(1);
  });

  it('also warms local + opponent equipped-skin overrides', async () => {
    loadAssetCalls.length = 0;
    const localSkinUrl = Object.values(resolveSkinOverrides(['skin_l1']))[0];
    const oppSkinUrl = Object.values(resolveSkinOverrides(['skin_e1']))[0];
    await ensureBattleAssets({ equippedSkins: ['skin_l1'], opponentSkins: ['skin_e1'] });
    const urls = new Set(loadAssetCalls.map((c) => c.url));
    expect(urls.has(localSkinUrl as string)).toBe(true);
    expect(urls.has(oppSkinUrl as string)).toBe(true);
  });

  it('never rejects — a failed .tao degrades quietly instead of wedging the gate', async () => {
    loadAssetCalls.length = 0;
    failUrl = STICKMAN_ASSETS[UnitType.Infantry] as string;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ensureBattleAssets({})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    failUrl = null;
  });

  it('reports progress from 0 to total, one step per unique asset URL (units + card art + decor)', async () => {
    // ensureBattleAssets dedups by URL (StickmanRuntime.loadAsset is URL-cached, so requesting the
    // same url twice would be wasted work) — compute the expected total the same way rather than
    // counting UnitType keys: vitest.ui.config's binary-asset stub maps every `.tao` import to the
    // same placeholder data URI, so in THIS test environment all of STICKMAN_ASSETS collapses to
    // one unique url (unlike production, where webpack content-hashes each file to a distinct URL).
    const uniqueUrls = new Set(Object.values(STICKMAN_ASSETS));
    const total = uniqueUrls.size + 2; // + card art step + decor atlas step
    const seen: Array<[number, number]> = [];
    await ensureBattleAssets({}, (done, t) => seen.push([done, t]));
    expect(seen[0]).toEqual([0, total]);
    expect(seen[seen.length - 1]).toEqual([total, total]);
    expect(seen.length).toBe(total + 1); // initial 0/total + one call per completed step
  });
});
