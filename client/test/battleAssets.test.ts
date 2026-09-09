// Coverage for the 2026-08-08 "进场才发现没资源" fix (ASSET_PACKAGING §10): `ensureBattleAssets`
// must warm StickmanRuntime's cache for every default unit type PLUS both sides' equipped-skin
// overrides, plus L1 hero/spell card art — and must never reject, even when an individual asset
// fails, so app.ts's pre-match loading gate can't get stuck on one flaky asset.
//
// Lived under test/ui/ until 2026-09-09 — not for any UI content (it has none), purely because it
// imports UnitView.ts, which pulls in raw `.tao`/`.png` asset imports that only the stubBinaryAssets
// plugin can resolve. That plugin is now shared by both configs (test/harness/stubBinaryAssets.ts),
// so this suite runs in the coverage suite where it belongs and `assets/battleAssets.ts` is gated
// instead of sitting at 0%. NOT a formality: this gate is the whole safety case for moving the
// starter rigs + decor atlas off the L0 boot gate (ASSET_PACKAGING §11.2) — if it stops warming
// them, the FIRST battle of a session draws placeholder circles and every later one looks fine,
// which is exactly the case a developer with a warm cache never sees. Moved with no assertion
// changed; `bootManifestTiers.test.ts` holds the both-ends guard.
import { describe, it, expect, vi } from 'vitest';
import { UnitType } from '@nw/engine/types';

const loadAssetCalls: Array<{ url: string; targetHeight?: number }> = [];
let failUrl: string | null = null;

vi.mock('../src/render/stickman/StickmanRuntime', () => ({
  StickmanRuntime: {
    loadAsset: vi.fn((url: string, targetHeight?: number) => {
      loadAssetCalls.push({ url, targetHeight });
      if (url === failUrl) return Promise.reject(new Error('boom'));
      return Promise.resolve({ naturalHeight: 100 });
    }),
  },
}));

const cardArtCalls: number[] = [];
vi.mock('../src/render/cardArt', () => ({
  preloadL1CardArtTextures: vi.fn(() => { cardArtCalls.push(1); return Promise.resolve(); }),
}));

// Battle ambience/corner labels, a background-tier boot step since ASSET_PACKAGING §11 — so this
// gate is now what guarantees it before the first battle frame. Mocked for the same reason as the
// two above, and additionally because the real loader would hand PIXI.Spritesheet the stub 1×1
// data URI and never resolve.
const decorAtlasCalls: number[] = [];
vi.mock('../src/render/atlas/decorMergedAtlas', () => ({
  decorMergedAtlas: { load: vi.fn(() => { decorAtlasCalls.push(1); return Promise.resolve(); }) },
}));

// Imported AFTER vi.mock (vitest hoists mock registration above all imports regardless of
// physical order — see marchTokenScale.ui.ts for the same pattern).
import { ensureBattleAssets } from '../src/assets/battleAssets';
import { STICKMAN_ASSETS, resolveSkinOverrides } from '../src/render/UnitView';

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
    // same url twice would be wasted work), so the expected total is computed the same way rather
    // than by counting UnitType keys — a skin override pointing at a default rig must not add a
    // step. 2026-09-09: under test/ui's asset stub every `.tao` collapsed to ONE data URI, so this
    // file's URL assertions were vacuous (`total` was 1 + 2 whatever the code did). The coverage
    // suite stubs rigs per file, so `uniqueUrls` is the real 12 and the count bites.
    const uniqueUrls = new Set(Object.values(STICKMAN_ASSETS));
    // Guards the vacuous version of this case coming back rather than any product property: two
    // types are allowed to share a rig, but if ALL rig URLs collapse to one string again (a wider
    // asset stub), `total` degenerates to 1 + 2 and the assertions below hold no matter what
    // `ensureBattleAssets` does.
    expect(uniqueUrls.size).toBeGreaterThan(1);
    const total = uniqueUrls.size + 2; // + card art step + decor atlas step
    const seen: Array<[number, number]> = [];
    await ensureBattleAssets({}, (done, t) => seen.push([done, t]));
    expect(seen[0]).toEqual([0, total]);
    expect(seen[seen.length - 1]).toEqual([total, total]);
    expect(seen.length).toBe(total + 1); // initial 0/total + one call per completed step
  });
});
