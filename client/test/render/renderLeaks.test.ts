/**
 * renderLeaks.test.ts — regression tests for the JS heap leak fixed on 2026-06-27.
 *
 * Two patterns were leaking:
 *   1. BaseTexture.on('loaded') instead of .once() — listeners piled up permanently.
 *   2. URL.createObjectURL() in StickmanRuntime never revoked — each .tao load
 *      retained several MB of blob memory for the lifetime of the session.
 *
 * Run with: npm run test:render
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Shared capture array — vi.hoisted runs before vi.mock factories ─────────────
const { mockTexInstances } = vi.hoisted(() => ({
  mockTexInstances: [] as Array<{
    listenerCount(ev: string): number;
    onCalls: string[];
    onceCalls: string[];
  }>,
}));

// ── PIXI stub — covers everything StickmanRuntime/decorAtlas/labelDecor touch ──
vi.mock('pixi.js-legacy', () => {
  class FakeBaseTexture {
    valid = false;
    readonly onCalls: string[] = [];
    readonly onceCalls: string[] = [];
    private readonly _evts = new Map<string, Array<(...a: unknown[]) => void>>();

    constructor(_url?: string) {
      mockTexInstances.push(this);
    }

    on(ev: string, cb: (...a: unknown[]) => void): this {
      this.onCalls.push(ev);
      const arr = this._evts.get(ev) ?? [];
      arr.push(cb);
      this._evts.set(ev, arr);
      // Auto-fire so tests don't hang if code incorrectly uses on() instead of once().
      if (ev === 'loaded') queueMicrotask(() => this._emit(ev));
      return this;
    }

    once(ev: string, cb: (...a: unknown[]) => void): this {
      this.onceCalls.push(ev);
      const arr = this._evts.get(ev) ?? [];
      const wrap = (...a: unknown[]): void => {
        cb(...a);
        this._evts.set(ev, (this._evts.get(ev) ?? []).filter(f => f !== wrap));
      };
      arr.push(wrap);
      this._evts.set(ev, arr);
      if (ev === 'loaded') queueMicrotask(() => this._emit(ev));
      return this;
    }

    off(ev: string, cb: (...a: unknown[]) => void): this {
      this._evts.set(ev, (this._evts.get(ev) ?? []).filter(f => f !== cb));
      return this;
    }

    _emit(ev: string, ...a: unknown[]): this {
      for (const cb of [...(this._evts.get(ev) ?? [])]) cb(...a);
      return this;
    }

    listenerCount(ev: string): number {
      return this._evts.get(ev)?.length ?? 0;
    }
  }

  class FakeSpritesheet {
    textures: Record<string, unknown> = {};
    async parse(): Promise<void> { /* no-op */ }
  }

  class FakeTexture {
    constructor(_bt?: unknown, _rect?: unknown) {}
    static from(_src: unknown): FakeTexture { return new FakeTexture(); }
  }

  class FakeRectangle {
    constructor(_x = 0, _y = 0, _w = 0, _h = 0) {}
  }

  class FakeContainer {
    children: unknown[] = [];
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    removeChild(c: unknown): void { this.children = this.children.filter(x => x !== c); }
    destroy(): void { /* no-op */ }
    position = { x: 0, y: 0, set(_x: number, _y: number): void {} };
    scale     = { x: 1, y: 1, set(_x: number, _y: number): void {} };
    visible   = true;
    alpha     = 1;
    rotation  = 0;
    zIndex    = 0;
  }

  class FakeSprite extends FakeContainer {
    texture: unknown = null;
    anchor = { set(): void {} };
    tint = 0xffffff;
    parent: FakeContainer | null = null;
    constructor(_tex?: unknown) { super(); }
  }

  class FakeTicker {
    static shared = new FakeTicker();
    add(_cb: unknown): void {}
    remove(_cb: unknown): void {}
  }

  class FakeGraphics extends FakeContainer {
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this   { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this  { return this; }
    drawRect(): this    { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    arc(): this    { return this; }
    closePath(): this { return this; }
    clear(): this     { return this; }
    generateCanvasTexture(): FakeTexture { return new FakeTexture(); }
  }

  return {
    BaseTexture: FakeBaseTexture,
    Spritesheet: FakeSpritesheet,
    Texture: FakeTexture,
    Rectangle: FakeRectangle,
    Container: FakeContainer,
    Sprite: FakeSprite,
    Ticker: FakeTicker,
    Graphics: FakeGraphics,
    settings: { ADAPTER: {} },
    LINE_CAP:  { ROUND: 'round', SQUARE: 'square', BUTT: 'butt' },
    LINE_JOIN: { ROUND: 'round', MITER: 'miter', BEVEL: 'bevel' },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
    WRAP_MODES: { CLAMP: 0 },
  };
});

// ── webpack-served PNG/JSON assets ─────────────────────────────────────────────
vi.mock('../../src/assets/decor/battle/decor_atlas.png',  () => ({ default: 'decor-atlas.png' }));
vi.mock('../../src/assets/decor/battle/decor_atlas.json', () => ({
  default: { frames: {}, meta: { size: { w: 256, h: 256 }, app: '', version: '', image: '', format: 'RGBA8888', scale: '1', smartupdate: '' } },
}));
vi.mock('../../src/assets/decor/decor_c_atlas.png',  () => ({ default: 'decor-c-atlas.png' }));
vi.mock('../../src/assets/decor/decor_c_atlas.json', () => ({
  default: { frames: {}, meta: { size: { w: 256, h: 256 }, app: '', version: '', image: '', format: 'RGBA8888', scale: '1', smartupdate: '' } },
}));
vi.mock('../../src/assets/decor/battle/label_boss.png',       () => ({ default: 'label-boss.png' }));
vi.mock('../../src/assets/decor/battle/label_start.png',      () => ({ default: 'label-start.png' }));
vi.mock('../../src/assets/decor/battle/label_win.png',        () => ({ default: 'label-win.png' }));
vi.mock('../../src/assets/decor/battle/label_arrow_here.png', () => ({ default: 'label-arrow.png' }));

// ── JSZip stub (used by StickmanRuntime) ───────────────────────────────────────
vi.mock('jszip', () => ({
  default: {
    loadAsync: () => Promise.resolve({
      file: (name: string) => {
        if (name === 'animation.json')
          return { async: () => Promise.resolve(JSON.stringify({ animations: {}, bindings: {}, boneLengthScales: {} })) };
        if (name === 'spritesheet.json')
          return { async: () => Promise.resolve(JSON.stringify({ frames: {} })) };
        if (name === 'spritesheet.png')
          return { async: () => Promise.resolve(new Blob()) };
        return undefined;
      },
    }),
  },
}));

// ── Image stub for StickmanRuntime's loadImageEl() ────────────────────────────
class MockImage {
  onload:  (() => void) | null = null;
  onerror: (() => void) | null = null;
  width  = 1;
  height = 1;
  set src(_url: string) {
    queueMicrotask(() => { if (this.onload) this.onload(); });
  }
}
(globalThis as unknown as { Image: unknown }).Image = MockImage;

// ── Imports (after all vi.mock declarations) ───────────────────────────────────
import * as PIXI from 'pixi.js-legacy';
import { loadDecorAtlas }  from '../../src/render/decorAtlas';
import { loadDecorCAtlas } from '../../src/render/decorCAtlas';
import { loadLabelDecor }  from '../../src/render/labelDecor';
import { StickmanRuntime } from '../../src/render/stickman/StickmanRuntime';

afterEach(() => {
  vi.restoreAllMocks();
  mockTexInstances.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('BaseTexture listener leak — on() vs once()', () => {

  it('decorAtlas: uses once() so listeners self-remove after load', async () => {
    const onceSpy = vi.spyOn(PIXI.BaseTexture.prototype, 'once');
    const onSpy   = vi.spyOn(PIXI.BaseTexture.prototype, 'on');

    await loadDecorAtlas();

    expect(onceSpy).toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('error',  expect.any(Function));
    // Regression: if reverted to on(), this fails
    expect(onSpy).not.toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('error',  expect.any(Function));

    const tex = mockTexInstances[0]!;
    // 'loaded' fires and once() self-removes → 0 remaining. Regression: on() would leave 1.
    expect(tex.listenerCount('loaded')).toBe(0);
    // 'error' never fired during a successful load, so it stays registered (1).
    // This is expected behaviour for both on() and once(); not a meaningful leak
    // because BaseTexture is only loaded once and then held alive anyway.
    expect(tex.listenerCount('error')).toBe(1);
  });

  it('decorCAtlas: uses once() so listeners self-remove after load', async () => {
    const onceSpy = vi.spyOn(PIXI.BaseTexture.prototype, 'once');
    const onSpy   = vi.spyOn(PIXI.BaseTexture.prototype, 'on');

    await loadDecorCAtlas();

    expect(onceSpy).toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('error',  expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('error',  expect.any(Function));

    const tex = mockTexInstances[0]!;
    expect(tex.listenerCount('loaded')).toBe(0);
    expect(tex.listenerCount('error')).toBe(1);
  });

  it('labelDecor: all four PNG textures use once(), no stale loaded-listeners', async () => {
    const onceSpy = vi.spyOn(PIXI.BaseTexture.prototype, 'once');
    const onSpy   = vi.spyOn(PIXI.BaseTexture.prototype, 'on');

    await loadLabelDecor();

    // Four PNGs → four BaseTexture instances, each calling once() twice (loaded + error).
    expect(mockTexInstances).toHaveLength(4);
    expect(onceSpy).toHaveBeenCalledTimes(8);
    expect(onSpy).not.toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('error',  expect.any(Function));

    for (const tex of mockTexInstances) {
      expect(tex.listenerCount('loaded')).toBe(0); // fired → self-removed
      expect(tex.listenerCount('error')).toBe(1);  // not fired → stays (expected)
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
describe('StickmanRuntime — blob URL revocation', () => {

  it('revokes the object URL after the spritesheet image is decoded', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(8)),
    }));

    await StickmanRuntime.loadAsset('fake://unit.tao');

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Regression: old code never called revokeObjectURL → each load leaked blob memory.
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake-url');
  });

  it('StickmanRuntime: uses once() for the spritesheet BaseTexture load', async () => {
    const onceSpy = vi.spyOn(PIXI.BaseTexture.prototype, 'once');
    const onSpy   = vi.spyOn(PIXI.BaseTexture.prototype, 'on');
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake2');
    vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(8)),
    }));

    // Use a different URL so the _cache doesn't return the previous test's result.
    await StickmanRuntime.loadAsset('fake://unit2.tao');

    expect(onceSpy).toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('error',  expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('loaded', expect.any(Function));
    expect(onSpy).not.toHaveBeenCalledWith('error',  expect.any(Function));
  });

});
