// Coverage for render/fastText.ts — the rasterize-once text cache and the numeric glyph atlas that
// took the Hero Roster's per-frame text cost out (see design/game/CHARACTER_CARDS_DESIGN_IMPL.md §10.5).
//
// Lives in test/ui (not test/render) because it needs a canvas: `pixiHeadless` supplies a pure-JS
// 2D context whose `measureText` returns real-ish widths, which is exactly what PIXI.Text needs.
// The bake renderer is stubbed in per-test — `RenderTexture.create` + `renderer.render()` never
// touch GL, so a `{ resolution, render() {} }` object is enough to exercise the cached paths and,
// by omitting it, the headless fallback that every other *.ui.ts test relies on.
//
// Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { setBakeRenderer, clearBakeCache } from '../../src/render/bake';
import {
  cachedTxt, numTxt, numAdvance, resetFastTextCaches, fastTextCacheSize,
} from '../../src/render/fastText';
import { FS } from '../../src/render/fontScale';

/** Minimal stand-in for the injected app renderer — see the file header for why this suffices. */
function stubRenderer(resolution = 2): void {
  setBakeRenderer({ resolution, render: () => {} } as unknown as PIXI.IRenderer);
}

function noRenderer(): void {
  setBakeRenderer(null as unknown as PIXI.IRenderer);
}

afterEach(() => {
  resetFastTextCaches();
  clearBakeCache();
  noRenderer();
});

describe('fastText — headless / no-renderer fallback', () => {
  it('cachedTxt and numTxt both hand back a live PIXI.Text when nothing can be baked', () => {
    noRenderer();
    const label = cachedTxt('Power', FS.small, 0x112233);
    const value = numTxt('249', FS.small, 0x112233);
    expect(label).toBeInstanceOf(PIXI.Text);
    expect(value).toBeInstanceOf(PIXI.Text);
    // Nothing was cached, so a scene built headlessly behaves exactly as it did before fastText —
    // which is what keeps every other *.ui.ts test's `instanceof PIXI.Text` tree walk working.
    expect(fastTextCacheSize()).toBe(0);
  });
});

describe('fastText — cachedTxt rasterizes once per (string, size, colour, weight)', () => {
  it('returns a Sprite and reuses the SAME base texture for a repeat call', () => {
    stubRenderer();
    const a = cachedTxt('Power', FS.small, 0x112233);
    const b = cachedTxt('Power', FS.small, 0x112233);
    expect(a).toBeInstanceOf(PIXI.Sprite);
    expect(b).toBeInstanceOf(PIXI.Sprite);
    expect(a).not.toBe(b);   // separate nodes...
    expect((b as PIXI.Sprite).texture.baseTexture)
      .toBe((a as PIXI.Sprite).texture.baseTexture);   // ...off one rasterization
    expect(fastTextCacheSize()).toBe(1);
  });

  it('keys on every style axis — a different colour, size or weight is a different entry', () => {
    stubRenderer();
    cachedTxt('Power', FS.small, 0x112233);
    cachedTxt('Power', FS.small, 0x445566);
    cachedTxt('Power', FS.tiny, 0x112233);
    cachedTxt('Power', FS.small, 0x112233, true);
    expect(fastTextCacheSize()).toBe(4);
  });

  it('lays out where the txt() it replaces did — same reported width', () => {
    stubRenderer();
    const sprite = cachedTxt('Attack 12', FS.small, 0x112233) as PIXI.Sprite;
    const live = (() => { noRenderer(); return cachedTxt('Attack 12', FS.small, 0x112233); })() as PIXI.Text;
    expect(sprite.width).toBeCloseTo(live.width, 5);
    live.destroy({ texture: true, baseTexture: true });
  });

  it('destroying a handed-out Sprite the normal way does not touch the cached texture', () => {
    stubRenderer();
    const first = cachedTxt('Power', FS.small, 0x112233) as PIXI.Sprite;
    const base = first.texture.baseTexture;
    // What tearDownChildren does to a Sprite: default options, i.e. `texture: false`.
    first.destroy();
    expect(base.destroyed).toBe(false);
    expect((cachedTxt('Power', FS.small, 0x112233) as PIXI.Sprite).texture.baseTexture).toBe(base);
  });

  it('evicts (and frees) the least recently used entry once past the cap', () => {
    stubRenderer();
    // 330 > CACHE_CAP (320). Touch entry 0 partway through so it is NOT the eviction victim.
    const held = cachedTxt('s0', FS.micro, 0x000000) as PIXI.Sprite;
    const heldBase = held.texture.baseTexture;
    for (let i = 1; i < 330; i++) {
      cachedTxt(`s${i}`, FS.micro, 0x000000);
      if (i === 200) cachedTxt('s0', FS.micro, 0x000000);   // touch → moves to the LRU tail
    }
    expect(fastTextCacheSize()).toBeLessThanOrEqual(320);
    // The touched entry survived; something older than it did not.
    expect(heldBase.destroyed).toBe(false);
    expect((cachedTxt('s0', FS.micro, 0x000000) as PIXI.Sprite).texture.baseTexture).toBe(heldBase);
  });
});

describe('fastText — numTxt assembles numbers from one shared glyph atlas', () => {
  it('emits one sprite per character, all off a single base texture (so they batch)', () => {
    stubRenderer();
    const node = numTxt('131/175', FS.small, 0x334455);
    expect(node).toBeInstanceOf(PIXI.Container);
    expect(node).not.toBeInstanceOf(PIXI.Text);
    const kids = (node as PIXI.Container).children as PIXI.Sprite[];
    expect(kids).toHaveLength('131/175'.length);
    const bases = new Set(kids.map((k) => k.texture.baseTexture));
    expect(bases.size).toBe(1);
    // Snapped to whole device pixels at draw time — see numTxt.
    for (const k of kids) expect(k.roundPixels).toBe(true);
  });

  it('two different numbers of the same colour and size share that one atlas', () => {
    stubRenderer();
    const a = numTxt('7', FS.small, 0x000000) as PIXI.Container;
    const b = numTxt('12345', FS.small, 0x000000) as PIXI.Container;
    expect((b.children[0] as PIXI.Sprite).texture.baseTexture)
      .toBe((a.children[0] as PIXI.Sprite).texture.baseTexture);
    // ...and none of it went through the PIXI.Text cache.
    expect(fastTextCacheSize()).toBe(0);
  });

  it('bakes a SEPARATE atlas per colour rather than tinting one white atlas', () => {
    stubRenderer();
    // Not an implementation detail for its own sake: Chrome gamma-corrects glyph antialiasing
    // against the fill colour, so tinting a white atlas down to ink-grey renders visibly heavier
    // than filling grey (~11% more ink, measured in the browser 2026-08-24). Nothing sets `tint`.
    const dark = numTxt('12', FS.small, 0x2c2c2a) as PIXI.Container;
    const gold = numTxt('12', FS.small, 0xcc9900) as PIXI.Container;
    expect((gold.children[0] as PIXI.Sprite).texture.baseTexture)
      .not.toBe((dark.children[0] as PIXI.Sprite).texture.baseTexture);
    for (const k of [...dark.children, ...gold.children] as PIXI.Sprite[]) {
      expect(k.tint).toBe(0xffffff);
    }
  });

  it('spaces advance without emitting a glyph', () => {
    stubRenderer();
    const node = numTxt('1 2', FS.small, 0x000000) as PIXI.Container;
    expect(node.children).toHaveLength(2);
    // Third character, so it sits two advances along — the layout a monospace font guarantees.
    expect((node.children[1] as PIXI.Sprite).x - (node.children[0] as PIXI.Sprite).x)
      .toBeCloseTo(2 * numAdvance(FS.small), 5);
  });

  it('falls back to a live PIXI.Text for anything outside the atlas charset', () => {
    stubRenderer();
    expect(numTxt('战力 249', FS.small, 0x000000)).toBeInstanceOf(PIXI.Text);
    expect(numTxt('Lv 3', FS.small, 0x000000)).toBeInstanceOf(PIXI.Text);
    expect(numTxt('249', FS.small, 0x000000)).not.toBeInstanceOf(PIXI.Text);
  });

  it('numAdvance agrees with the glyph step actually used, renderer or not', () => {
    stubRenderer();
    const node = numTxt('11', FS.small, 0x000000) as PIXI.Container;
    const step = (node.children[1] as PIXI.Sprite).x - (node.children[0] as PIXI.Sprite).x;
    // Reads the metric off the atlas that numTxt just built — same (size, weight), any colour.
    expect(numAdvance(FS.small)).toBeCloseTo(step, 5);
    resetFastTextCaches();
    noRenderer();
    // The measured fallback has to match too, or the "<label> <value>" split would drift apart
    // between the headless tests and the real client.
    expect(numAdvance(FS.small)).toBeCloseTo(step, 5);
  });

  it('numAdvance does not itself bake an atlas (a layout helper picks no colour)', () => {
    stubRenderer();
    const w = numAdvance(FS.tiny);
    expect(w).toBeGreaterThan(0);
    // Still the measured fallback: the first numTxt call is what decides which colour gets baked.
    const node = numTxt('11', FS.tiny, 0x2c2c2a) as PIXI.Container;
    expect(node).toBeInstanceOf(PIXI.Container);
    expect(numAdvance(FS.tiny)).toBeCloseTo(w, 5);
  });
});
