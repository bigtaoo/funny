/**
 * hudHeartHpBar.test.ts — regression test for the heart-shaped HP bar (2026-07-18).
 *
 * Background: the top/bottom HP bars used to be plain rectangle pips; they were
 * replaced with heart-shaped pips (`HUDView.drawHpBar` / `drawHeartPip`) whose
 * boundary heart fills left-to-right by the HP fraction within that pip (e.g. a
 * third of one heart goes gray) instead of snapping the whole pip on/off.
 *
 * Two layers are tested:
 *   1. The pure geometry helpers (`heartPoints`, `clipPolygonRight`) in isolation —
 *      no PIXI involved.
 *   2. `HUDView.sync()` end-to-end against a FakeGraphics that records every
 *      `beginFill`/`drawPolygon` call, asserting the right number of full/partial/
 *      empty hearts and that the partial heart's colored polygon is clipped
 *      narrower than the full heart's.
 *
 * Run with: npm run test:render
 */

import { describe, it, expect, vi } from 'vitest';
import { heartPoints, clipPolygonRight } from '../../src/render/HUDView';

// ── Pure geometry ────────────────────────────────────────────────────────────

describe('heartPoints', () => {
  it('returns a closed polygon of 24 points, bounded within [0, s] × roughly [0, s]', () => {
    const s = 14;
    const pts = heartPoints(s);
    expect(pts).toHaveLength(24);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(s);
    }
    // Symmetric about the vertical centerline (x = s/2), since the parametric
    // curve has no horizontal skew term.
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    expect((minX + maxX) / 2).toBeCloseTo(s / 2, 1);
  });
});

describe('clipPolygonRight', () => {
  const pts = heartPoints(14);
  const maxX = Math.max(...pts.map(p => p.x));
  const minX = Math.min(...pts.map(p => p.x));

  it('clipping past the right edge keeps every point unchanged', () => {
    const clipped = clipPolygonRight(pts, maxX + 1);
    expect(clipped).toEqual(pts);
  });

  it('clipping past the left edge drops every point', () => {
    const clipped = clipPolygonRight(pts, minX - 1);
    expect(clipped).toHaveLength(0);
  });

  it('clipping through the middle keeps no point past clipX', () => {
    const clipX = (minX + maxX) / 2;
    const clipped = clipPolygonRight(pts, clipX);
    expect(clipped.length).toBeGreaterThan(0);
    for (const p of clipped) expect(p.x).toBeLessThanOrEqual(clipX + 1e-9);
    // The clip must actually introduce interpolated boundary points, not just
    // drop vertices — otherwise the polygon edge wouldn't sit exactly at clipX.
    expect(clipped.some(p => Math.abs(p.x - clipX) < 1e-9)).toBe(true);
  });
});

// ── End-to-end via HUDView.sync() ───────────────────────────────────────────

// Minimal PIXI stub — only what HUDView.build()/sync() touch. FakeGraphics
// records every fill call so the test can inspect what each heart pip drew.
type FillCall = { color: number; alpha: number; polygon: { x: number; y: number }[] };

vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    x = 0; y = 0; visible = true; alpha = 1;
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    removeChild(c: unknown): void { this.children = this.children.filter(x => x !== c); }
    destroy(): void { /* no-op */ }
  }
  class FakeSprite extends FakeContainer {
    anchor = { set(): void {} };
    scale  = { set(): void {} };
    rotation = 0; width = 0; height = 0;
    constructor(_tex?: unknown) { super(); }
  }
  class FakeGraphics extends FakeContainer {
    fills: FillCall[] = [];
    private curFill: { color: number; alpha: number } | null = null;
    lineStyle(): this { return this; }
    beginFill(color = 0, alpha = 1): this { this.curFill = { color, alpha }; return this; }
    endFill(): this   { this.curFill = null; return this; }
    drawRect(): this  { return this; }
    drawRoundedRect(): this { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this  { return this; }
    drawPolygon(points: { x: number; y: number }[]): this {
      if (this.curFill) this.fills.push({ ...this.curFill, polygon: points });
      return this;
    }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    arc(): this    { return this; }
    closePath(): this { return this; }
    clear(): this  { this.fills = []; return this; }
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
  class FakeBaseTexture { on(): this { return this; } once(): this { return this; } off(): this { return this; } }
  class FakeTexture { static from(): FakeTexture { return new FakeTexture(); } }
  class FakeSpritesheet { textures: Record<string, unknown> = {}; async parse(): Promise<void> {} }
  class FakeRectangle { constructor(_x = 0, _y = 0, _w = 0, _h = 0) {} }
  class FakePoint { constructor(public x = 0, public y = 0) {} }
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
    Point: FakePoint,
    settings: { ADAPTER: {} },
    LINE_CAP: { ROUND: 'round', SQUARE: 'square', BUTT: 'butt' },
    LINE_JOIN: { ROUND: 'round', MITER: 'miter', BEVEL: 'bevel' },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
    WRAP_MODES: { CLAMP: 0 },
  };
});

vi.mock('../../src/assets/decor/battle/label_boss.png',       () => ({ default: 'label-boss.png' }));
vi.mock('../../src/assets/decor/battle/label_start.png',      () => ({ default: 'label-start.png' }));
vi.mock('../../src/assets/decor/battle/label_win.png',        () => ({ default: 'label-win.png' }));
vi.mock('../../src/assets/decor/battle/label_arrow_here.png', () => ({ default: 'label-arrow.png' }));

import { HUDView } from '../../src/render/HUDView';
import { BASE_HP } from '../../src/game/config';
import { factionInk } from '../../src/render/theme';
import type { ILayout, Rect } from '../../src/layout/ILayout';
import type { GameState } from '../../src/game/GameState';

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

function fakeState(baseHp: number): GameState {
  return {
    elapsedTicks: 0,
    bottomPlayer: { baseHp, ink: 0, nextUpgradeCost: 30 },
    topPlayer:    { baseHp, ink: 0, nextUpgradeCost: 30 },
  } as unknown as GameState;
}

/** The colored (non-base-gray) fills drawn for one HP bar's Graphics object. */
function coloredFills(gfx: unknown): FillCall[] {
  const fake = gfx as { fills: FillCall[] };
  return fake.fills.filter(f => f.color !== 0xdddddd);
}

describe('HUDView heart HP bar', () => {
  it('full HP: all 10 hearts get a full-width colored polygon', () => {
    const hud = new HUDView(fakeLayout());
    hud.sync(fakeState(BASE_HP));
    const fills = coloredFills((hud as unknown as { playerHpGfx: unknown }).playerHpGfx);
    expect(fills).toHaveLength(10);
    for (const f of fills) expect(f.color).toBe(factionInk.friend);
  });

  it('zero HP: no heart gets a colored polygon (base gray only)', () => {
    const hud = new HUDView(fakeLayout());
    hud.sync(fakeState(0));
    const fills = coloredFills((hud as unknown as { playerHpGfx: unknown }).playerHpGfx);
    expect(fills).toHaveLength(0);
  });

  it('partial HP: full hearts get full-width fills, the boundary heart gets a narrower one, the rest none', () => {
    // 44/100 * 10 cells = 4.4 → 4 full hearts + a 40%-filled 5th + 5 empty.
    const hud = new HUDView(fakeLayout());
    hud.sync(fakeState(44));
    const fills = coloredFills((hud as unknown as { playerHpGfx: unknown }).playerHpGfx);
    expect(fills).toHaveLength(5); // 4 full + 1 partial; the remaining 5 hearts have no colored fill

    const fullWidth = Math.max(...fills[0]!.polygon.map(p => p.x)) - Math.min(...fills[0]!.polygon.map(p => p.x));
    const widths = fills.map(f => Math.max(...f.polygon.map(p => p.x)) - Math.min(...f.polygon.map(p => p.x)));
    // First 4 hearts are full width; the 5th (last) is strictly narrower — the
    // partial fill, clipped to ~40% of the heart's width.
    for (let i = 0; i < 4; i++) expect(widths[i]).toBeCloseTo(fullWidth, 1);
    expect(widths[4]).toBeLessThan(fullWidth * 0.7);
    expect(widths[4]).toBeGreaterThan(fullWidth * 0.1);
  });

  it('critical HP (last heart only): the danger fill alpha never hits the full 0.9 rest-alpha', () => {
    // 5/100 * 10 = 0.5 → only the first heart partially fills; this is the
    // "critical" tier (filledCeil <= 1), which blinks via a reduced alpha instead
    // of turning red (faction hue must stay fixed — see drawHpBar's doc comment).
    const hud = new HUDView(fakeLayout());
    hud.sync(fakeState(5));
    const fills = coloredFills((hud as unknown as { playerHpGfx: unknown }).playerHpGfx);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.alpha).toBeLessThan(0.9);
  });
});
