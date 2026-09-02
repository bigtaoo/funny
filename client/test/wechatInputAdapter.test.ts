// `inputSystem/WechatAdapter.ts` — the WeChat half of the input source. WeChat mini-games have no
// DOM, so PIXI's EventSystem never fires and every tap in the game arrives through this class.
//
// **It had zero cases before this file** (2026-09-02) — it was never instantiated in any suite in
// the repo, which is worse than it sounds for an input adapter: it is not a leaf, it is the
// *first* link. If it silently emits nothing (or emits screen coords instead of design coords),
// the entire WeChat build is unplayable while every other test stays green, because everything
// downstream of `InputManager` is driven directly by `_emitDown/_emitMove/_emitUp` in tests.
// Its sibling `WebAdapter` is in the same position and is also uninstantiated anywhere; the
// difference is that a broken WebAdapter shows up the moment anyone opens localhost:9090, while
// nobody drives the WeChat build by hand between real-device rounds.
//
// The seam here is the bare `declare const wx` the module reads (there is no injected dep), so
// these cases install a fake `wx` that records the four callbacks and then fires them.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WechatAdapter } from '../src/inputSystem/WechatAdapter';
import { InputManager } from '../src/inputSystem/InputManager';

type Touch = { clientX: number; clientY: number };
type TouchEvent = { changedTouches: Touch[] };
type Cb = (e: TouchEvent) => void;

/** The four `wx.onTouch*` registrations, captured so a case can fire them. */
type FakeWx = {
  start: Cb[]; move: Cb[]; end: Cb[]; cancel: Cb[];
  onTouchStart(cb: Cb): void;
  onTouchMove(cb: Cb): void;
  onTouchEnd(cb: Cb): void;
  onTouchCancel(cb: Cb): void;
};

function fakeWx(): FakeWx {
  const wx: FakeWx = {
    start: [], move: [], end: [], cancel: [],
    onTouchStart(cb) { wx.start.push(cb); },
    onTouchMove(cb) { wx.move.push(cb); },
    onTouchEnd(cb) { wx.end.push(cb); },
    onTouchCancel(cb) { wx.cancel.push(cb); },
  };
  return wx;
}

/** One touch at screen coords. */
const touch = (clientX: number, clientY: number): TouchEvent => ({ changedTouches: [{ clientX, clientY }] });

let wx: FakeWx;

/**
 * An adapter over a fresh fake `wx`, wired to a real InputManager whose three channels are
 * recorded. `toDesign` halves the coords so a case can tell design space from screen space —
 * an identity converter would let a "forgot to convert" regression pass.
 */
function adapter() {
  const input = new InputManager();
  const down: Array<[number, number]> = [];
  const move: Array<[number, number]> = [];
  const up: Array<[number, number]> = [];
  input.onDown((x, y) => down.push([x, y]));
  input.onMove((x, y) => move.push([x, y]));
  input.onUp((x, y) => up.push([x, y]));
  new WechatAdapter(input, (sx, sy) => ({ x: sx / 2, y: sy / 2 }));
  return { input, down, move, up };
}

beforeEach(() => {
  wx = fakeWx();
  (globalThis as { wx?: FakeWx }).wx = wx;
});

afterEach(() => {
  delete (globalThis as { wx?: FakeWx }).wx;
});

describe('WechatAdapter — registration', () => {
  it('registers exactly one handler on each of the four wx touch channels', () => {
    adapter();
    expect([wx.start.length, wx.move.length, wx.end.length, wx.cancel.length]).toEqual([1, 1, 1, 1]);
  });

  it('a second adapter over the same wx DOUBLES every channel — there is no unregister', () => {
    // Pinning current behaviour, not endorsing it: unlike `WebAdapter`, this class has no
    // `destroy()` and never calls `wx.offTouch*`, so constructing it twice makes every tap fire
    // twice. Harmless today (`WechatPlatform.setupInput` is called once at boot and drops the
    // instance), but it is the reason a future "re-init input on canvas resize" would silently
    // double-fire instead of erroring. If a `destroy()` lands, this case is the one to update.
    adapter();
    adapter();
    expect([wx.start.length, wx.move.length, wx.end.length, wx.cancel.length]).toEqual([2, 2, 2, 2]);
  });
});

describe('WechatAdapter — screen coords become design coords', () => {
  it('touchstart → _emitDown at the CONVERTED position', () => {
    const a = adapter();
    wx.start[0](touch(400, 300));
    expect(a.down).toEqual([[200, 150]]);
    expect(a.move).toEqual([]);
    expect(a.up).toEqual([]);
  });

  it('touchmove → _emitMove at the converted position', () => {
    const a = adapter();
    wx.move[0](touch(400, 300));
    expect(a.move).toEqual([[200, 150]]);
    expect(a.down).toEqual([]);
  });

  it('touchend → _emitUp at the converted position', () => {
    const a = adapter();
    wx.end[0](touch(400, 300));
    expect(a.up).toEqual([[200, 150]]);
  });

  it('touchcancel is treated as an UP, not dropped', () => {
    // A cancel that emitted nothing would leave the game holding a pointer down forever — a
    // stuck drag on the world map, which is exactly the kind of thing only a real device shows.
    const a = adapter();
    wx.cancel[0](touch(400, 300));
    expect(a.up).toEqual([[200, 150]]);
    expect(a.down).toEqual([]);
  });

  it('a full drag arrives in order on the three channels', () => {
    const a = adapter();
    wx.start[0](touch(100, 100));
    wx.move[0](touch(120, 100));
    wx.move[0](touch(140, 100));
    wx.end[0](touch(140, 100));
    expect(a.down).toEqual([[50, 50]]);
    expect(a.move).toEqual([[60, 50], [70, 50]]);
    expect(a.up).toEqual([[70, 50]]);
  });

  it('only the first touch of a multi-touch event is used (single-touch game)', () => {
    const a = adapter();
    wx.start[0]({ changedTouches: [{ clientX: 400, clientY: 300 }, { clientX: 800, clientY: 600 }] });
    expect(a.down).toEqual([[200, 150]]);
  });
});

describe('WechatAdapter — an empty changedTouches is ignored on all four channels', () => {
  // wx can hand back an event with no changedTouches; the guard is what stops a `undefined.clientX`
  // TypeError from escaping into wx's own callback dispatch, where nothing in the game would see it.
  it('emits nothing and does not throw', () => {
    const a = adapter();
    const empty: TouchEvent = { changedTouches: [] };
    expect(() => {
      wx.start[0](empty); wx.move[0](empty); wx.end[0](empty); wx.cancel[0](empty);
    }).not.toThrow();
    expect(a.down).toEqual([]);
    expect(a.move).toEqual([]);
    expect(a.up).toEqual([]);
  });
});

describe('WechatAdapter — it feeds the real InputManager, so the gate applies', () => {
  it('taps arriving while input is suppressed are dropped by InputManager, not by the adapter', () => {
    // The adapter has no idea about the fade gate; suppression lives in InputManager. This case
    // exists so "the WeChat build ignores the mid-fade gate" can't be true without turning red —
    // it was the mis-navigation bug class on the web side (see inputManager.test.ts).
    const a = adapter();
    a.input.suppress(true);
    wx.start[0](touch(400, 300));
    wx.end[0](touch(400, 300));
    expect(a.down).toEqual([]);
    expect(a.up).toEqual([]);

    a.input.suppress(false);
    wx.start[0](touch(400, 300));
    expect(a.down).toEqual([[200, 150]]);
  });
});
