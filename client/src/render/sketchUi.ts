/**
 * sketchUi.ts — shared hand-drawn UI primitives for the canvas-drawn scenes.
 *
 * The full-screen scenes (login / room / shop / gacha / result / replay / intro)
 * used to each draw their own notebook background, their own `drawRoundedRect`
 * buttons/panels, and keep a private copy of the palette + a `txt` helper. That
 * violated the art direction (§7.5 "buttons = irregular hand-drawn border, never
 * perfect rounded corners") and duplicated the colour table everywhere.
 *
 * This module is the single home for those primitives, all drawn with the shared
 * {@link SketchPen} so every screen reads as the same notebook page as the board
 * and lobby. Colours flow from {@link palette} (theme.ts) so a re-skin is one
 * edit. Fonts are intentionally left as `monospace` for now — a proper hand-drawn
 * font is a separate task (it needs a bundled font face).
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { palette } from './theme';
import { bake } from './bake';

/**
 * Shared scene palette. Paper / ruled line / margin / red flow from the theme
 * (single source of truth); the functional accents (blue/gold/green) stay as the
 * UI's own state colours, which §3.3 explicitly exempts from the friend-foe rule.
 */
export const ui = {
  /** Aged paper page background. */
  bg:     palette.paper,
  /** Slightly lighter card stock for panels / fields. */
  paper:  0xfaf6ee,
  /** Printed ruled lines. */
  line:   palette.ruleLine,
  /** Teacher's red margin line down the left (matches the board / lobby). */
  margin: palette.inkRed,
  /** Ink-dark — headers, primary text, button fills. */
  dark:   0x2c2c2a,
  mid:    0x888888,
  light:  0xdddddd,
  /** Disabled button stroke / muted accents. */
  btnOff: 0xbbbbbb,
  /** Disabled button fill (pale paper-grey). */
  btnDis: 0xddd8ce,
  /** Blue affordance accent (login / create / valid). */
  accent: 0x4477cc,
  /** Marker-gold accent (premium / confirm). */
  gold:   0xcc9900,
  green:  0x4a9e4a,
  /** Error / enemy red. */
  red:    0xcc3333,
} as const;

/**
 * Plain text node. Font stays `monospace` until the hand-written font task lands;
 * centralised here so that swap is one edit across every scene.
 */
export function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return new PIXI.Text(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/**
 * Deterministic seed from a rect so a button/panel's scrawl is stable across the
 * frequent full re-renders these scenes do (otherwise the border would re-jitter
 * — "boil" — on every keystroke / tap). Same position → same hand-drawn border.
 */
export function seedFor(x: number, y: number, w: number, h = 0): number {
  let s = 2166136261;
  for (const n of [x, y, w, h]) s = ((s ^ Math.round(n)) * 16777619) >>> 0;
  return s || 1;
}

/**
 * Notebook-paper background: aged paper + faint ruled lines + a red margin line
 * down the left, drawn with the shared SketchPen and baked per (tag,w,h). Mirrors
 * the lobby / board so every screen is the same page. Falls back to live Graphics
 * when no bake renderer is wired (headless tests).
 */
export function buildPaperBackground(tag: string, w: number, h: number): PIXI.DisplayObject {
  const gfx = new PIXI.Graphics();
  gfx.beginFill(ui.bg);
  gfx.drawRect(0, 0, w, h);
  gfx.endFill();

  const pen = new SketchPen(gfx, 0x5bd1c7);
  const lineGap = Math.round(h / 28);
  for (let y = lineGap; y < h; y += lineGap) {
    pen.line(0, y, w, y, { color: palette.ruleLine, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
  }
  const mx = Math.round(w * 0.09);
  pen.line(mx, 0, mx, h, { color: palette.inkRed, width: 2.2, jitter: 1.0, taper: 0.95 });

  const tex = bake(`${tag}:${Math.round(w)}x${Math.round(h)}`, gfx, w, h);
  if (tex) {
    const s = new PIXI.Sprite(tex);
    gfx.destroy();
    return s;
  }
  return gfx;
}

export interface PanelOpts {
  fill: number;
  border: number;
  /** Border stroke width (px). */
  width?: number;
  /** Fixed scrawl seed; defaults to a hash of the panel size. */
  seed?: number;
  /** Fill alpha (for ghosted / empty slots). */
  fillAlpha?: number;
}

/**
 * A hand-drawn panel: flat fill + a scribbled SketchPen border (corners overshoot
 * the box the way a hand lifts past the turn). Returned at local origin (0,0) —
 * the caller positions it and may add children. Replaces every `drawRoundedRect`.
 */
export function sketchPanel(w: number, h: number, opts: PanelOpts): PIXI.Graphics {
  const g = new PIXI.Graphics();
  g.beginFill(opts.fill, opts.fillAlpha ?? 1);
  g.drawRect(0, 0, w, h);
  g.endFill();
  new SketchPen(g, opts.seed ?? seedFor(w, h, opts.border)).rect(2, 2, w - 4, h - 4, {
    color: opts.border, width: opts.width ?? 2, jitter: 1.0,
  });
  return g;
}

/**
 * A hand-drawn left-edge ink accent stroke (replaces the flat `drawRect` accent
 * bar on list rows / player slots). Draws into `g` in its local coords.
 */
export function sketchAccentBar(g: PIXI.Graphics, h: number, color: number, seed = 9): void {
  new SketchPen(g, seed).line(4, 5, 4, h - 5, { color, width: 4.5, jitter: 0.8, taper: 0.85 });
}
