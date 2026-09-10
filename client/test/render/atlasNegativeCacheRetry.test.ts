/**
 * Regression coverage (client-resource-mgmt audit 2026-07-29): render/atlas/spriteAtlas.ts's
 * createAtlasLoader, the now-deleted render/atlas/coinIconAtlas.ts (coin balance/reward icons were
 * folded into the plain `TAB_ICON_RASTER` table 2026-08-25, which has no promise cache of its own
 * to go stale), and render/stickman/StickmanRuntime.loadAsset all shared the same bug — a failed
 * load() cached the *rejected* promise forever, so a single
 * transient network blip (very plausible on WeChat / mobile) permanently negative-cached the
 * atlas/rig for the rest of the session: every subsequent call replayed the same old rejection
 * instead of retrying, even once the network recovered. The fix resets the cache slot to null in
 * a `.catch`, so the next load()/loadAsset() call genuinely retries.
 *
 * pixi.js-legacy is fully faked (same technique as stickmanAttackScaling.test.ts) so this runs in
 * plain Node (vitest.config.ts's default environment) without a real WebGL/DOM stack — the fakes
 * only need to be complete enough for the atlas-decode happy path (BaseTexture.valid=true,
 * Spritesheet.parse() resolving) to run once the assetIO layer itself resolves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AssetIO } from '../../src/assets/assetIO';

vi.mock('pixi.js-legacy', () => ({
  BaseTexture: class FakeBaseTexture {
    valid = true;
    constructor(public source: unknown, public opts?: unknown) {}
    once(): void { /* never reached: valid=true resolves synchronously */ }
  },
  Spritesheet: class FakeSpritesheet {
    textures: Record<string, unknown> = { frame1: {} };
    constructor(public baseTex: unknown, public data: unknown) {}
    async parse(): Promise<void> { /* no-op success */ }
  },
}));

function flakyThenOkIO(): AssetIO {
  const textureSource = vi.fn()
    .mockRejectedValueOnce(new Error('network blip'))
    .mockResolvedValueOnce('resolved-source');
  return { loadBinary: vi.fn(), textureSource } as unknown as AssetIO;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('spriteAtlas.createAtlasLoader: retries after a failed load (does not negative-cache)', () => {
  it('a failed load() followed by a retry succeeds and reaches isReady()', async () => {
    // setAssetIO and the module under test must come from the SAME fresh module registry snapshot
    // (both dynamically imported here, after the previous test's vi.resetModules()) — otherwise
    // spriteAtlas.ts's own `import { assetIO } from '../assets/assetIO'` resolves a stale/different
    // instance than the one setAssetIO() was just called on, and it silently falls back to the real
    // WebAssetIO (which always resolves) instead of our mock.
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const { createAtlasLoader } = await import('../../src/render/atlas/spriteAtlas');
    const io = flakyThenOkIO();
    setAssetIO(io);

    const loader = createAtlasLoader('atlas.png', {} as never, 'test-atlas');
    await expect(loader.load()).rejects.toThrow('network blip');
    expect(loader.isReady()).toBe(false);

    await loader.load(); // retry — must not just replay the same rejection
    expect(loader.isReady()).toBe(true);
    expect((io.textureSource as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('a load() call already in flight (not yet failed) is still shared, not duplicated', async () => {
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const { createAtlasLoader } = await import('../../src/render/atlas/spriteAtlas');
    const io = flakyThenOkIO();
    setAssetIO(io);
    const loader = createAtlasLoader('atlas.png', {} as never, 'test-atlas');

    const p1 = loader.load();
    const p2 = loader.load(); // same in-flight attempt, not a second textureSource call
    await expect(p1).rejects.toThrow('network blip');
    await expect(p2).rejects.toThrow('network blip');
    expect((io.textureSource as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

describe('baseUpgradeAtlasLoader: retries after a failed load (does not negative-cache)', () => {
  // 2026-08-03 fix — this loader had the exact same bug as spriteAtlas/coinIconAtlas (since deleted,
  // see this file's header comment) above but was missed by the 2026-07-29 audit that fixed those two
  // (see claudedocs/client-modules.md).
  it('a failed loadBaseUpgradeAtlas() followed by a retry succeeds', async () => {
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const io = flakyThenOkIO();
    setAssetIO(io);
    const mod = await import('../../src/render/atlas/baseUpgradeAtlasLoader');

    await expect(mod.loadBaseUpgradeAtlas()).rejects.toThrow('network blip');
    expect(mod.isBaseUpgradeAtlasReady()).toBe(false);

    await mod.loadBaseUpgradeAtlas(); // retry
    expect(mod.isBaseUpgradeAtlasReady()).toBe(true);
    expect((io.textureSource as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

describe('StickmanRuntime.loadAsset: retries after a failed parse (does not negative-cache)', () => {
  it('a failed loadAsset(url) followed by a retry for the SAME url succeeds', async () => {
    const parseTaoAsset = vi.fn()
      .mockRejectedValueOnce(new Error('zip decode failed'))
      .mockResolvedValueOnce({ ok: true });
    vi.doMock('../../src/render/stickman/assetLoader', () => ({ parseTaoAsset }));

    const { StickmanRuntime } = await import('../../src/render/stickman/StickmanRuntime');

    await expect(StickmanRuntime.loadAsset('infantry.tao')).rejects.toThrow('zip decode failed');
    const asset = await StickmanRuntime.loadAsset('infantry.tao'); // retry, same url
    expect(asset).toEqual({ ok: true });
    expect(parseTaoAsset).toHaveBeenCalledTimes(2);
  });

  it('a successful load is still cached (no redundant re-parse) — only the failure path resets', async () => {
    const parseTaoAsset = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../src/render/stickman/assetLoader', () => ({ parseTaoAsset }));

    const { StickmanRuntime } = await import('../../src/render/stickman/StickmanRuntime');

    await StickmanRuntime.loadAsset('archer.tao');
    await StickmanRuntime.loadAsset('archer.tao');
    expect(parseTaoAsset).toHaveBeenCalledTimes(1); // still a genuine cache, just not a negative one
  });
});

/**
 * The two ACCESSORS on the same loader (2026-09-10 FNDA sweep: `getTexture` and `frameNames` were
 * the file's only never-called functions — the suite above drives `load`/`isReady` and stops there).
 *
 * They are worth pinning because "not loaded yet" is the normal state, not an edge case: every
 * atlas is fetched lazily while the scene that wants it is already on screen, and every call site
 * treats `null` as "draw the procedural fallback this frame". Return `undefined` instead and the
 * cosmetic degrade turns into a PIXI crash inside a Sprite constructor; throw before the sheet is
 * parsed and the first frames of the world map / forge grid take the whole scene down. `frameNames`
 * has one caller — `decorMergedAtlas` enumerating a prefix — and an empty array there means "no
 * decor this frame", which is exactly the right answer before the sheet exists.
 */
describe('spriteAtlas.createAtlasLoader: what it answers before/after the sheet exists', () => {
  it('answers null / [] before load, without throwing', async () => {
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const { createAtlasLoader } = await import('../../src/render/atlas/spriteAtlas');
    setAssetIO(flakyThenOkIO());
    const loader = createAtlasLoader('atlas.png', {} as never, 'test-atlas');

    expect(loader.isReady()).toBe(false);
    expect(loader.getTexture('frame1')).toBeNull();
    expect(loader.frameNames()).toEqual([]);
  });

  it('serves parsed frames after load, and still nulls an unknown name', async () => {
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const { createAtlasLoader } = await import('../../src/render/atlas/spriteAtlas');
    const io = flakyThenOkIO();
    setAssetIO(io);
    const loader = createAtlasLoader('atlas.png', {} as never, 'test-atlas');

    await expect(loader.load()).rejects.toThrow('network blip'); // the flaky IO's first answer
    await loader.load();

    expect(loader.frameNames()).toEqual(['frame1']); // the fake Spritesheet's one frame
    expect(loader.getTexture('frame1')).not.toBeNull();
    // A name the sheet does not have is null, NOT undefined: `sheet.textures[name] ?? null` is the
    // line that makes a renamed frame a missing decal instead of a crash.
    expect(loader.getTexture('no_such_frame')).toBeNull();
  });

  it('stays null / [] after a load that failed', async () => {
    const { setAssetIO } = await import('../../src/assets/assetIO');
    const { createAtlasLoader } = await import('../../src/render/atlas/spriteAtlas');
    setAssetIO({ loadBinary: vi.fn(), textureSource: vi.fn().mockRejectedValue(new Error('offline')) } as never);
    const loader = createAtlasLoader('atlas.png', {} as never, 'test-atlas');

    await expect(loader.load()).rejects.toThrow('offline');
    expect(loader.getTexture('frame1')).toBeNull();
    expect(loader.frameNames()).toEqual([]);
  });
});
