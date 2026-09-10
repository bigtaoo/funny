// platform/web/safeAreaProbe.ts — env(safe-area-inset-*) as something that PUSHES.
//
// The point of the rewrite this covers: the insets used to be readable only, so every consumer had
// to guess WHEN to read them. The 2026-07-28 attempt at the iPhone-13 safe-area bug was one such
// guess (re-read after the asset gate), and an inset that settles at any other moment — WebKit
// finishing `viewport-fit=cover`, iOS handing over the real inset at the end of a rotation, a status
// bar appearing over a call — still reached nobody, because `window.resize` does not fire for it.
//
// Runs in the node suite (no DOM), so `document` and `ResizeObserver` are hand-stubbed. That is
// also what lets a case assert the no-ResizeObserver path, which no real browser here would take.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readSafeAreaInsets, observeSafeAreaInsets, resetSafeAreaProbeForTests,
} from '../src/platform/web/safeAreaProbe';

/** The four `env()` values the fake CSS engine resolves to. Mutable — that IS the device changing. */
const env = { top: 0, right: 0, bottom: 0, left: 0 };

/** Fires the observer callbacks, the way a browser would after a style recalc. */
let fireResize: () => void = () => {};
let observed: unknown[] = [];

class FakeElement {
  style = { cssText: '' };
  private axes(): { w: 'left' | 'right'; h: 'top' | 'bottom' } {
    // Which corner this probe measures is decided by the env() names in its own cssText, exactly
    // as the browser would decide it — so a case cannot pass by luck if the two boxes get swapped.
    return this.style.cssText.includes('inset-right')
      ? { w: 'right', h: 'bottom' }
      : { w: 'left', h: 'top' };
  }
  getBoundingClientRect(): { width: number; height: number } {
    const { w, h } = this.axes();
    return { width: env[w], height: env[h] };
  }
  remove(): void {}
}

function installDom(withResizeObserver = true): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    body: { appendChild: (): void => {} },
    createElement: (): FakeElement => new FakeElement(),
  };
  if (!withResizeObserver) return;
  g.ResizeObserver = class {
    constructor(private readonly cb: () => void) { fireResize = () => this.cb(); }
    observe(el: unknown): void { observed.push(el); }
    disconnect(): void { observed = []; fireResize = () => {}; }
  };
}

beforeEach(() => {
  env.top = 0; env.right = 0; env.bottom = 0; env.left = 0;
  observed = [];
  resetSafeAreaProbeForTests();
});
afterEach(() => {
  resetSafeAreaProbeForTests();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.ResizeObserver;
});

describe('readSafeAreaInsets', () => {
  it('maps each probe box back to its own inset (a swap here silently mirrors the layout)', () => {
    installDom();
    Object.assign(env, { top: 47, right: 5, bottom: 34, left: 3 });
    expect(readSafeAreaInsets()).toEqual({ top: 47, right: 5, bottom: 34, left: 3 });
  });

  it('is all-zero with no DOM at all (WeChat, tests) rather than throwing', () => {
    expect(readSafeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('observeSafeAreaInsets', () => {
  it('pushes the new reading when an inset appears without any resize event', () => {
    installDom();
    const seen: Array<{ top: number; bottom: number }> = [];
    observeSafeAreaInsets((i) => seen.push({ top: i.top, bottom: i.bottom }));
    // Registration itself must not be mistaken for a change (the browser fires once on observe).
    fireResize();
    expect(seen).toEqual([]);

    Object.assign(env, { top: 47, bottom: 34 });
    fireResize();
    expect(seen).toEqual([{ top: 47, bottom: 34 }]);
  });

  it('stays silent when the boxes resize but the values did not', () => {
    // Every notification costs a renderer.resize + a layout rebuild downstream, so "fired" must
    // mean "actually different".
    installDom();
    let calls = 0;
    observeSafeAreaInsets(() => { calls++; });
    Object.assign(env, { top: 47 });
    fireResize();
    fireResize();
    fireResize();
    expect(calls).toBe(1);
  });

  it('still notifies when somebody polls the insets between the change and the callback', () => {
    // `ViewportResizer` polls `getSafeAreaInsets()` on every `window.resize`, and mobile browsers
    // fire `resize` for things that are not resizes (chrome bars, the keyboard). If the observer's
    // baseline were the same "last value" those reads update, such a read landing between the box
    // change and the (async, post-layout) callback would make the two compare equal — and the one
    // notification this module exists to deliver would vanish, non-deterministically.
    installDom();
    const seen: number[] = [];
    observeSafeAreaInsets((i) => seen.push(i.top));
    Object.assign(env, { top: 47 });
    readSafeAreaInsets(); // the interloper
    fireResize();
    expect(seen).toEqual([47]);
  });

  it('watches BOTH boxes — one box could not see a top/bottom swap', () => {
    installDom();
    const seen: Array<[number, number]> = [];
    observeSafeAreaInsets((i) => seen.push([i.top, i.bottom]));
    Object.assign(env, { top: 47, bottom: 34 });
    fireResize();
    // A device that hands back 34/47 instead (same sum): a single box sized by top+bottom would
    // resize by exactly 0 here and the change would be invisible.
    Object.assign(env, { top: 34, bottom: 47 });
    fireResize();
    expect(seen).toEqual([[47, 34], [34, 47]]);
    expect(observed).toHaveLength(2);
  });

  it('unsubscribes cleanly, and the last unsubscribe disconnects the observer', () => {
    installDom();
    let a = 0;
    let b = 0;
    const offA = observeSafeAreaInsets(() => { a++; });
    const offB = observeSafeAreaInsets(() => { b++; });
    Object.assign(env, { top: 47 });
    fireResize();
    expect([a, b]).toEqual([1, 1]);

    offA();
    Object.assign(env, { top: 48 });
    fireResize();
    expect([a, b]).toEqual([1, 2]);

    offB();
    expect(observed).toEqual([]); // disconnect() ran — no observer left holding the probes
  });

  it('degrades to a no-op where ResizeObserver does not exist', () => {
    // Not hypothetical for this codebase: the same bundle runs inside in-app WebViews of unknown
    // vintage. The caller still re-reads insets on every window.resize, so this loses the extra
    // coverage and nothing else.
    installDom(false);
    let calls = 0;
    const off = observeSafeAreaInsets(() => { calls++; });
    expect(() => off()).not.toThrow();
    expect(calls).toBe(0);
  });
});
