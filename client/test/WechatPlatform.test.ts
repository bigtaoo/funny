// WechatPlatform unit tests (client-resource-mgmt audit 2026-07-29 fix): WechatStorage.setItem
// used to swallow a quota-exceeded (or any) write failure completely silently — a save that failed
// to persist looked identical to one that succeeded until the player lost progress on relaunch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

async function freshWechatPlatform(wxOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.stubGlobal('wx', {
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, language: 'zh-CN' }),
    setPreferredFramesPerSecond: () => {},
    getStorageSync: () => undefined,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10240, keys: [] }),
    ...wxOverrides,
  });
  vi.stubGlobal('canvas', {});
  const mod = await import('../src/platform/wechat/WechatPlatform');
  return new mod.WechatPlatform();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WechatPlatform storage: setItem failure reporting (audit 2026-07-29 fix)', () => {
  it('a successful write never reports anything', async () => {
    const setStorageSync = vi.fn();
    const platform = await freshWechatPlatform({ setStorageSync });
    expect(() => platform.storage.setItem('k', 'v')).not.toThrow();
    expect(setStorageSync).toHaveBeenCalledWith('k', 'v');
  });

  it('a quota-exceeded (or any) write failure is caught, never rethrown to the caller', async () => {
    const setStorageSync = vi.fn(() => { throw new Error('exceed max storage limit'); });
    const platform = await freshWechatPlatform({ setStorageSync });
    expect(() => platform.storage.setItem('nw_save_v1', '{"big":true}')).not.toThrow();
  });

  it('a write failure is still attempted with getStorageInfoSync for diagnostics, itself best-effort', async () => {
    const setStorageSync = vi.fn(() => { throw new Error('exceed max storage limit'); });
    const getStorageInfoSync = vi.fn(() => ({ currentSize: 10240, limitSize: 10240, keys: ['nw_save_v1'] }));
    const platform = await freshWechatPlatform({ setStorageSync, getStorageInfoSync });
    platform.storage.setItem('nw_save_v1', '{"big":true}');
    expect(getStorageInfoSync).toHaveBeenCalledTimes(1);
  });

  it('getStorageInfoSync itself throwing does not break the failure path (diagnostics are best-effort)', async () => {
    const setStorageSync = vi.fn(() => { throw new Error('exceed max storage limit'); });
    const getStorageInfoSync = vi.fn(() => { throw new Error('not available'); });
    const platform = await freshWechatPlatform({ setStorageSync, getStorageInfoSync });
    expect(() => platform.storage.setItem('nw_save_v1', '{}')).not.toThrow();
  });

  it('removeItem/getItem failures are silently swallowed (unchanged pre-existing behavior)', async () => {
    const platform = await freshWechatPlatform({
      getStorageSync: () => { throw new Error('boom'); },
      removeStorageSync: () => { throw new Error('boom'); },
    });
    expect(platform.storage.getItem('k')).toBeNull();
    expect(() => platform.storage.removeItem('k')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// getCanvas(): where the on-screen canvas comes from (black-screen regression, 2026-09-01).
//
// getCanvas() used to `return canvas` — the bare global. That global comes from the adapter layer,
// not from the documented mini-game API, and base library 3.17.2 (canary, 2026-08-31) stopped
// providing it: `ReferenceError: canvas is not defined` out of startApp's first line, black screen.
// ---------------------------------------------------------------------------------------------

/** Like freshWechatPlatform, but with explicit control over both canvas globals. */
async function platformWithCanvasGlobals(opts: {
  bare?: unknown;
  gameGlobal?: unknown;
  createCanvas?: () => unknown;
}) {
  vi.resetModules();
  vi.stubGlobal('wx', {
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, language: 'zh-CN' }),
    setPreferredFramesPerSecond: () => {},
    getStorageSync: () => undefined,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10240, keys: [] }),
    createCanvas: opts.createCanvas ?? (() => ({ id: 'wx-created' })),
  });
  // `undefined` here is "the runtime does not provide it": `typeof canvas` reads 'undefined' either
  // way, which is exactly the shape the 3.17.2 canary presents.
  vi.stubGlobal('canvas', opts.bare);
  vi.stubGlobal('GameGlobal', opts.gameGlobal ?? {});
  const mod = await import('../src/platform/wechat/WechatPlatform');
  return new mod.WechatPlatform();
}

describe('WechatPlatform.getCanvas: on-screen canvas resolution', () => {
  it('uses the bare global when the runtime provides it (base lib <= 3.15 / adapter shim)', async () => {
    const bare = { id: 'bare-global' };
    const createCanvas = vi.fn(() => ({ id: 'wx-created' }));
    const platform = await platformWithCanvasGlobals({ bare, createCanvas });
    expect(platform.getCanvas()).toBe(bare);
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('falls back to GameGlobal.canvas when the bare global is gone', async () => {
    const owned = { id: 'game-global' };
    const createCanvas = vi.fn(() => ({ id: 'wx-created' }));
    const platform = await platformWithCanvasGlobals({
      bare: undefined, gameGlobal: { canvas: owned }, createCanvas,
    });
    expect(platform.getCanvas()).toBe(owned);
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it('falls back to wx.createCanvas() when neither global exists (base lib 3.17.2 canary)', async () => {
    const made = { id: 'wx-created' };
    const createCanvas = vi.fn(() => made);
    const platform = await platformWithCanvasGlobals({ bare: undefined, createCanvas });
    expect(platform.getCanvas()).toBe(made);
    expect(createCanvas).toHaveBeenCalledTimes(1);
  });

  it('memoises it: only the FIRST wx.createCanvas() is the on-screen canvas', async () => {
    let n = 0;
    const createCanvas = vi.fn(() => ({ id: `canvas-${++n}` })); // a different object every call
    const platform = await platformWithCanvasGlobals({ bare: undefined, createCanvas });
    const first = platform.getCanvas();
    expect(platform.getCanvas()).toBe(first);
    expect(platform.getCanvas()).toBe(first);
    // Without the memo the renderer would end up drawing into an off-screen canvas — the same
    // black screen, one indirection further away.
    expect(createCanvas).toHaveBeenCalledTimes(1);
  });
});
