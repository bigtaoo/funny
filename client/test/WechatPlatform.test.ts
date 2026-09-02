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

// ---------------------------------------------------------------------------------------------
// openTextInput(): the wx.showKeyboard-backed replacement for the 14 scenes' hidden <input>
// (ASSET_PACKAGING §4.3/§4.4 item 1). wx.onKeyboardInput/onKeyboardConfirm/onKeyboardComplete are
// GLOBAL listeners — there's no per-call handle in the wx API — so these tests exercise the
// single-active-session routing as much as the individual calls.
// ---------------------------------------------------------------------------------------------

interface KeyboardListeners {
  input?: (res: { value: string }) => void;
  confirm?: (res: { value: string }) => void;
  complete?: () => void;
}

async function platformWithKeyboard() {
  vi.resetModules();
  const listeners: KeyboardListeners = {};
  const showKeyboard = vi.fn();
  const updateKeyboard = vi.fn();
  const hideKeyboard = vi.fn();
  vi.stubGlobal('wx', {
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, language: 'zh-CN' }),
    setPreferredFramesPerSecond: () => {},
    getStorageSync: () => undefined,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10240, keys: [] }),
    showKeyboard,
    updateKeyboard,
    hideKeyboard,
    onKeyboardInput: (cb: (res: { value: string }) => void) => { listeners.input = cb; },
    onKeyboardConfirm: (cb: (res: { value: string }) => void) => { listeners.confirm = cb; },
    onKeyboardComplete: (cb: () => void) => { listeners.complete = cb; },
  });
  vi.stubGlobal('canvas', {});
  const mod = await import('../src/platform/wechat/WechatPlatform');
  return { platform: new mod.WechatPlatform(), listeners, showKeyboard, updateKeyboard, hideKeyboard };
}

describe('WechatPlatform.openTextInput', () => {
  it('opens the native keyboard with the seeded value/maxLength/confirmType, confirmHold always true', async () => {
    const { platform, showKeyboard } = await platformWithKeyboard();
    platform.openTextInput({
      value: 'hi', maxLength: 24, confirmType: 'send',
      onInput: () => {}, onComplete: () => {},
    });
    expect(showKeyboard).toHaveBeenCalledWith(expect.objectContaining({
      defaultValue: 'hi', maxLength: 24, multiple: false, confirmHold: true, confirmType: 'send',
    }));
  });

  it('defaults confirmType to "done" when omitted', async () => {
    const { platform, showKeyboard } = await platformWithKeyboard();
    platform.openTextInput({ value: '', maxLength: 10, onInput: () => {}, onComplete: () => {} });
    expect(showKeyboard).toHaveBeenCalledWith(expect.objectContaining({ confirmType: 'done' }));
  });

  it('routes onKeyboardInput to the active session\'s onInput', async () => {
    const { platform, listeners } = await platformWithKeyboard();
    const onInput = vi.fn();
    platform.openTextInput({ value: '', maxLength: 10, onInput, onComplete: () => {} });
    listeners.input?.({ value: 'ab' });
    expect(onInput).toHaveBeenCalledWith('ab');
  });

  it('routes onKeyboardConfirm to the active session\'s onConfirm, without closing it', async () => {
    const { platform, listeners } = await platformWithKeyboard();
    const onConfirm = vi.fn();
    const onComplete = vi.fn();
    const handle = platform.openTextInput({ value: '', maxLength: 10, onInput: () => {}, onConfirm, onComplete });
    listeners.confirm?.({ value: 'ok' });
    expect(onConfirm).toHaveBeenCalledWith('ok');
    expect(onComplete).not.toHaveBeenCalled();
    // Still open — a second confirm still routes.
    listeners.confirm?.({ value: 'ok2' });
    expect(onConfirm).toHaveBeenCalledTimes(2);
    handle.close();
  });

  it('a native keyboard dismiss (onKeyboardComplete) fires onComplete exactly once and detaches the session', async () => {
    const { platform, listeners } = await platformWithKeyboard();
    const onComplete = vi.fn();
    const onInput = vi.fn();
    platform.openTextInput({ value: '', maxLength: 10, onInput, onComplete });
    listeners.complete?.();
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Stray input events after dismissal (if the host ever fired one) must not reach a dead session.
    listeners.input?.({ value: 'late' });
    expect(onInput).not.toHaveBeenCalled();
    // A second dismiss (e.g. wx firing it again) must not double-fire onComplete.
    listeners.complete?.();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('close() calls wx.hideKeyboard, fires onComplete once, and is idempotent even if onKeyboardComplete later fires too', async () => {
    const { platform, listeners, hideKeyboard } = await platformWithKeyboard();
    const onComplete = vi.fn();
    const handle = platform.openTextInput({ value: '', maxLength: 10, onInput: () => {}, onComplete });
    handle.close();
    expect(hideKeyboard).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    handle.close(); // caller calling close() twice must not double-fire
    expect(onComplete).toHaveBeenCalledTimes(1);
    // wx's own dismissal event arriving after our close() (the real device may still emit it,
    // since we asked it to hide) must not double-fire onComplete either.
    listeners.complete?.();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('setValue() forwards to wx.updateKeyboard while open, no-ops after close', async () => {
    const { platform, updateKeyboard } = await platformWithKeyboard();
    const handle = platform.openTextInput({ value: '', maxLength: 10, onInput: () => {}, onComplete: () => {} });
    handle.setValue('clip');
    expect(updateKeyboard).toHaveBeenCalledWith(expect.objectContaining({ value: 'clip' }));
    handle.close();
    updateKeyboard.mockClear();
    handle.setValue('too-late');
    expect(updateKeyboard).not.toHaveBeenCalled();
  });

  it('opening a new field while one is open closes the previous one first (focus-steal, same as an <input>)', async () => {
    const { platform, listeners, showKeyboard } = await platformWithKeyboard();
    const firstComplete = vi.fn();
    const firstInput = vi.fn();
    platform.openTextInput({ value: 'a', maxLength: 10, onInput: firstInput, onComplete: firstComplete });
    const secondInput = vi.fn();
    platform.openTextInput({ value: 'b', maxLength: 10, onInput: secondInput, onComplete: () => {} });
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(showKeyboard).toHaveBeenCalledTimes(2);
    // Input events now route to the second (active) session only.
    listeners.input?.({ value: 'x' });
    expect(secondInput).toHaveBeenCalledWith('x');
    expect(firstInput).not.toHaveBeenCalled();
  });
});
