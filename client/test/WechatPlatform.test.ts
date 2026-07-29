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
