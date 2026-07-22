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
import { FS } from './fontScale';
import { makeText } from './pixiText';

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
export function txt(label: string, size: number, color: number, bold = false, wordWrapWidth?: number): PIXI.Text {
  // makeText() applies CJK anti-clip padding (see render/pixiText.ts) — layout-neutral.
  return makeText(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
    ...(wordWrapWidth !== undefined ? { wordWrap: true, wordWrapWidth, breakWords: true } : {}),
  });
}

/**
 * `txt()` factory for content that lives inside a container scaled up after layout —
 * the "popup-scale-to-80%" convention (see CardSceneBase/EquipmentSceneBase's `modalScale`
 * and CityScene's `renderDetailModal`): a modal is laid out in a small local frame, then
 * the whole panel is `.scale.set(scale)`'d to fill most of the real screen.
 *
 * `PIXI.Text` rasterizes glyphs onto a canvas at its own native resolution; stretching
 * that bitmap via a parent transform blurs it exactly like upscaling a photo — vector
 * `Graphics` (panel borders, icons) don't suffer this, only baked text does. Rendering
 * the glyph canvas at `scale`× up front cancels the later stretch back out.
 *
 * Safe to use unconditionally (including at `scale === 1`, e.g. no modal open): it then
 * just matches PIXI's own default auto-resolution behavior.
 */
export function scaledTxt(scale: number) {
  return (label: string, size: number, color: number, bold = false, wordWrapWidth?: number): PIXI.Text => {
    const t = txt(label, size, color, bold, wordWrapWidth);
    t.resolution = devicePixelRatioSafe() * scale;
    return t;
  };
}

function devicePixelRatioSafe(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}

/**
 * Detach AND destroy a container's children before a full re-render — the safe
 * replacement for a bare `container.removeChildren()` in any scene that re-renders
 * on **every keystroke / per frame / on a timer** (LoginScene caret, chat compose,
 * settings rename, world-map train countdowns, …).
 *
 * Why this matters: `txt()` mints a fresh `PIXI.Text` each render, and every Text
 * owns its own GPU texture. `removeChildren()` only detaches — it leaves those
 * textures orphaned until PIXI's texture GC runs (~60s), so a high-frequency
 * re-render piles up textures faster than they're reclaimed. On iPad Safari's tiny
 * WebGL budget that exhausts GPU memory → context loss → Safari reloads the page
 * (the "nickname-entry keeps crashing" crash, fixed in 29b0daea).
 *
 * Contract: `PIXI.Text` frees its own texture (`texture/baseTexture: true`);
 * everything else (Graphics geometry, and crucially Sprites backed by a shared
 * `bake()` RenderTexture like the paper background) is destroyed with the default
 * `texture: false` so the shared bake cache is never touched.
 *
 * Recurses into **sub-containers**: a plain `child.destroy({ children: true })` destroys any
 * nested Text *object* but leaves its baseTexture orphaned (the `texture` flag defaults to false
 * for descendants), so Text tucked inside a scroll body / modal / row container would still leak.
 * Walking the tree lets the Text special-case apply at every depth while leaf Sprites/Graphics keep
 * `texture: false` — the shared bake/atlas cache is never touched regardless of nesting depth.
 */
export function tearDownChildren(container: PIXI.Container): void {
  for (const child of container.removeChildren()) disposeChild(child);
}

/** Destroy one display object, freeing Text textures at any nesting depth (see {@link tearDownChildren}). */
function disposeChild(child: PIXI.DisplayObject): void {
  if (child instanceof PIXI.Text) {
    child.destroy({ texture: true, baseTexture: true });
    return;
  }
  // Detach + dispose grandchildren first, so the subsequent destroy() sees a childless node and
  // can't double-destroy anything we already freed (a double free surfaces as the "_geometry.clear
  // of null" crash). Only non-Text containers with children need the walk; leaves fall straight through.
  if (child instanceof PIXI.Container && child.children.length > 0) {
    for (const grandchild of child.removeChildren()) disposeChild(grandchild);
  }
  child.destroy({ children: true });
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
 * X of the red notebook margin rule (see buildPaperBackground). Content columns
 * should start to its right so icon cards don't sit on top of the red stripe.
 */
export function marginLineX(w: number): number {
  return Math.round(w * 0.09);
}

/**
 * Notebook-paper background: aged paper + faint ruled lines + a red margin line
 * down the left, drawn with the shared SketchPen and baked per (tag,w,h). Mirrors
 * the lobby / board so every screen is the same page. Falls back to live Graphics
 * when no bake renderer is wired (headless tests).
 */
export function buildPaperBackground(
  tag: string, w: number, h: number, opts: { marginLine?: boolean; railX?: number } = {},
): PIXI.DisplayObject {
  const { marginLine = true, railX } = opts;
  const gfx = new PIXI.Graphics();
  gfx.beginFill(ui.bg);
  gfx.drawRect(0, 0, w, h);
  gfx.endFill();

  const pen = new SketchPen(gfx, 0x5bd1c7);
  const lineGap = Math.round(h / 28);
  for (let y = lineGap; y < h; y += lineGap) {
    pen.line(0, y, w, y, { color: palette.ruleLine, width: 1.1, jitter: 0.7, taper: 0.9, double: false });
  }
  // The notebook's red margin rule. Suppressed on the SLG overworld (marginLine:false):
  // there the paper is a backdrop for a full-bleed isometric map, and a lone red vertical
  // stripe down the left read as a stray artifact rather than as notebook stationery.
  // `railX` overrides the classic 9%-of-width position for screens whose left tab rail is wider
  // than that (sidebarNavW, 20% of the short edge) — without it the line cuts through the middle
  // of the rail instead of marking its edge.
  if (marginLine) {
    const mx = railX ?? marginLineX(w);
    pen.line(mx, 0, mx, h, { color: palette.inkRed, width: 2.2, jitter: 1.0, taper: 0.95 });
  }

  const tex = bake(`${tag}:${Math.round(w)}x${Math.round(h)}:${railX ?? ''}`, gfx, w, h);
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
 * The one true primary-button background, shared across every full-screen scene
 * (Auction, Equipment, Sect, Family, WorldMap, …): a `sketchPanel` with the
 * ink-dark fill + blue accent border. Callers pass their own `seed` so each
 * instance keeps its distinct hand-drawn jitter; omit it to hash from the size.
 * Re-skinning every primary button in the game is now a single edit here.
 */
export function sketchButton(w: number, h: number, seed?: number): PIXI.Graphics {
  return sketchPanel(w, h, { fill: ui.dark, border: ui.accent, seed });
}

/**
 * A hand-drawn left-edge ink accent stroke (replaces the flat `drawRect` accent
 * bar on list rows / player slots). Draws into `g` in its local coords.
 */
export function sketchAccentBar(g: PIXI.Graphics, h: number, color: number, seed = 9): void {
  new SketchPen(g, seed).line(4, 5, 4, h - 5, { color, width: 4.5, jitter: 0.8, taper: 0.85 });
}

/**
 * Full-screen loading overlay: semi-transparent dim + centred panel +
 * animated processing text. Purely visual — caller must block input
 * (typically `if (bt.busy) return` at the top of handleDown).
 * @param dots 0–2, drives the trailing-dot animation
 * @param label Already-translated label string (dots appended automatically)
 */
export function drawLoadingOverlay(
  container: PIXI.Container, w: number, h: number, dots: number, label: string,
): void {
  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.55); dim.drawRect(0, 0, w, h); dim.endFill();
  container.addChild(dim);

  const display = label + '.'.repeat(dots + 1);
  const lbl = txt(display, FS.title, 0xffffff, true);
  const padX = Math.round(w * 0.08);
  const padY = Math.round(h * 0.022);
  const bw = Math.max(lbl.width + padX * 2, Math.round(w * 0.40));
  const bh = lbl.height + padY * 2;
  const bx = (w - bw) / 2;
  const by = (h - bh) / 2;
  const panel = sketchPanel(bw, bh, {
    fill: ui.dark, fillAlpha: 0.92, border: ui.gold, width: 2, seed: seedFor(bw, bh, 9),
  });
  panel.x = bx; panel.y = by;
  container.addChild(panel);
  lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
  container.addChild(lbl);
}
