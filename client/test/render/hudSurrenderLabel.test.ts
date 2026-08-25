/**
 * hudSurrenderLabel.test.ts — regression test for the campaign "exit level"
 * relabel (2026-07-17).
 *
 * Background: surrendering to a PvE stage reads oddly, so campaign levels reword
 * the top-strip surrender button (and its confirm dialog) as "exit level".
 * HUDView takes a `campaign` flag and swaps the i18n keys:
 *   button   hud.surrender      → hud.exitLevel
 *   title    hud.surrenderTitle → hud.exitLevelTitle
 *   confirm  hud.surrenderConfirm → hud.exitLevelConfirm
 * The cancel button is shared.
 *
 * The critical invariant (user requirement): the PvP / net path — HUDView built
 * WITHOUT the flag — must be untouched and keep the original 投降/surrender text.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Minimal PIXI stub — only what HUDView.build() / showSurrenderConfirm() touch ──
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    x = 0; y = 0;
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    removeChild(c: unknown): void { this.children = this.children.filter(x => x !== c); }
    removeChildren(): void { this.children = []; }
    destroy(): void { /* no-op */ }
  }
  class FakeSprite extends FakeContainer {
    anchor = { set(): void {} };
    scale  = { set(): void {} };
    rotation = 0; width = 0; height = 0;
    constructor(_tex?: unknown) { super(); }
  }
  class FakeGraphics extends FakeContainer {
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this   { return this; }
    drawRect(): this  { return this; }
    drawRoundedRect(): this { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this  { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    arc(): this    { return this; }
    closePath(): this { return this; }
    clear(): this  { return this; }
  }
  class FakeText extends FakeContainer {
    text: string;
    style: Record<string, unknown>;
    anchor = { set(): void {} };
    get height(): number { return 0; }
    constructor(text = '', style: Record<string, unknown> = {}) { super(); this.text = text; this.style = { ...style }; }
  }
  class FakeTicker {
    static shared = new FakeTicker();
    add(): void {}
    remove(): void {}
  }
  class FakeBaseTexture {
    valid = false;
    // `from`/`addToCache` are only here for assets/preloadTextures.ts, which HUDView now reaches
    // through its raster ink glyph: the preload it kicks off must settle quietly under this mock
    // rather than reject (preloadTextureList's contract is that it never rejects).
    static from(): FakeBaseTexture { return new FakeBaseTexture(); }
    static addToCache(): void {}
    on(): this { return this; } once(): this { return this; } off(): this { return this; }
  }
  class FakeTexture {
    // `valid: false` on purpose: `buildInkIcon`/`buildRasterTabIcon` read it to decide whether the
    // PNG has decoded, and under this mock nothing ever loads, so HUDView's ink glyph stays an
    // empty container — which is exactly what these HP-bar/label assertions want out of the way.
    baseTexture = new FakeBaseTexture();
    width = 0; height = 0;
    static from(): FakeTexture { return new FakeTexture(); }
    static addToCache(): void {}
  }
  class FakeSpritesheet { textures: Record<string, unknown> = {}; async parse(): Promise<void> {} }
  class FakeRectangle { constructor(_x = 0, _y = 0, _w = 0, _h = 0) {} }
  return {
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Text: FakeText,
    Ticker: FakeTicker,
    BaseTexture: FakeBaseTexture,
    Texture: FakeTexture,
    Spritesheet: FakeSpritesheet,
    Rectangle: FakeRectangle,
    settings: { ADAPTER: {} },
    LINE_CAP: { ROUND: 'round', SQUARE: 'square', BUTT: 'butt' },
    LINE_JOIN: { ROUND: 'round', MITER: 'miter', BEVEL: 'bevel' },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
    // Needed since 2026-08-25: HUDView's ink glyph is raster AI art now (batch 7 retired the
    // procedural `drawInk`), so importing it pulls render/cardArt's texture setup into this mock.
    MIPMAP_MODES: { OFF: 0, POW2: 1, ON: 2 },
    WRAP_MODES: { CLAMP: 0 },
  };
});

// ── webpack-served PNG/JSON assets pulled in transitively via labelDecor ────────
vi.mock('../../src/assets/decor/decor_merged_atlas.png',  () => ({ default: 'decor-merged-atlas.png' }));
vi.mock('../../src/assets/decor/decor_merged_atlas.json', () => ({ default: { frames: {}, meta: { size: { w: 1024, h: 675 } } } }));

// ── Imports (after all vi.mock declarations) ───────────────────────────────────
import { HUDView } from '../../src/render/HUDView';
import { t } from '../../src/i18n';
import type { ILayout, Rect } from '../../src/layout/ILayout';

// ── Fake layout — HUDView.build() only reads these rects / scalars ──────────────
function fakeLayout(): ILayout {
  const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  return {
    orientation: 'landscape',
    designWidth: 1920,
    designHeight: 1080,
    boardRect: rect(660, 120, 600, 840),
    hudTopRect: rect(0, 0, 1920, 100),
    hudBottomLeftRect: rect(0, 980, 480, 100),
    hudBottomRightRect: rect(1440, 980, 480, 100),
    playerBaseRect: () => rect(860, 840, 200, 120),
  } as unknown as ILayout;
}

/** Recursively collect every PIXI.Text `.text` string in a display tree. */
function collectTexts(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as { text?: unknown; children?: unknown[] };
  if (typeof n.text === 'string') out.push(n.text);
  if (Array.isArray(n.children)) for (const c of n.children) collectTexts(c, out);
  return out;
}

describe('HUDView surrender label — campaign "exit level" relabel', () => {
  it('campaign HUD shows the exit-level button, not the surrender button', () => {
    const hud = new HUDView(fakeLayout(), true);
    const texts = collectTexts(hud.container);
    expect(texts).toContain(t('hud.exitLevel'));
    expect(texts).not.toContain(t('hud.surrender'));
  });

  it('PvP / net HUD keeps the original surrender button (must not regress)', () => {
    // Both the explicit-false and the default (no-arg) construction are the PvP path.
    for (const hud of [new HUDView(fakeLayout(), false), new HUDView(fakeLayout())]) {
      const texts = collectTexts(hud.container);
      expect(texts).toContain(t('hud.surrender'));
      expect(texts).not.toContain(t('hud.exitLevel'));
    }
  });

  it('replay/spectator HUD hides the surrender button entirely (must not regress)', () => {
    // hideSurrender = true (3rd arg) → neither surrender nor exit-level text is present.
    const hud = new HUDView(fakeLayout(), false, true);
    const texts = collectTexts(hud.container);
    expect(texts).not.toContain(t('hud.surrender'));
    expect(texts).not.toContain(t('hud.exitLevel'));
    // The surrender hit rect stays zero so input never triggers the confirm dialog.
    expect(hud.getSurrenderRect()).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('campaign confirm dialog uses exit-level title + confirm, shared cancel', () => {
    const hud = new HUDView(fakeLayout(), true);
    hud.showSurrenderConfirm();
    const texts = collectTexts(hud.container);
    expect(texts).toContain(t('hud.exitLevelTitle'));
    expect(texts).toContain(t('hud.exitLevelConfirm'));
    expect(texts).toContain(t('hud.surrenderCancel')); // cancel is shared
    expect(texts).not.toContain(t('hud.surrenderTitle'));
    expect(texts).not.toContain(t('hud.surrenderConfirm'));
  });

  it('PvP confirm dialog keeps the original surrender title + confirm (must not regress)', () => {
    const hud = new HUDView(fakeLayout(), false);
    hud.showSurrenderConfirm();
    const texts = collectTexts(hud.container);
    expect(texts).toContain(t('hud.surrenderTitle'));
    expect(texts).toContain(t('hud.surrenderConfirm'));
    expect(texts).not.toContain(t('hud.exitLevelTitle'));
    expect(texts).not.toContain(t('hud.exitLevelConfirm'));
  });
});
