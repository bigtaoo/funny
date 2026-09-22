// HUDView's HP-bar rendering (heart-pip cells + the critical-HP warning glyph), extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). Pure given a
// PIXI.Graphics + its params — no host object needed, HUDView.sync() just calls drawHpBar directly.
//
// ── Why this is sprites and not a per-frame Graphics (2026-09-22) ────────────────────────────────
//
// It used to be one `Graphics` per bar, fully re-stroked by `HUDView.sync()` on EVERY frame. The
// heart outline is a 24-point polygon drawn twice per pip (gray base + colored fill), so one bar
// came out at ~4,560 indices, and the battle screen paid 9,120 of them 30-60 times a second.
// Measured headless (1280x631, VS-AI match, 120 frames): 8,573 indices/frame of re-triangulation
// out of 10,173 total — **84% of all per-frame geometry work in the battle screen was these two
// bars**, and 45% of the frame's static index count on top of that.
//
// None of it was geometry that changed. `heartPoints()` is a constant, the faction hue is fixed for
// the whole match, and the only thing animating is the danger BLINK — which was baked into
// `beginFill(color, alpha)` and therefore dragged the whole polygon set through earcut again. Same
// defect, same shape, as the `render/GuideOverlay.ts` pulse ring fixed on 2026-09-08 (ADR-085 §7):
// an alpha animation wearing a geometry animation's clothes.
//
// So the pips are now baked once into a shared atlas and shown as sprites:
//   - the ten empty pips are ONE static sprite (they never change at all),
//   - each filled pip is a white heart sprite, `tint`ed to the faction hue, cropped left-to-right
//     by moving its texture `frame` (which is exactly what `clipPolygonRight` used to do, minus the
//     triangulation), and `alpha`-blinked,
//   - the critical ⚠ is one more sprite whose two colors share a single alpha, so it blinks by
//     `sprite.alpha` verbatim.
// Everything sits on one baseTexture, so the whole bar batches.
//
// The live-Graphics path is kept as a FALLBACK for hosts with no bake renderer (headless tests) —
// the same contract as `render/sketchUi.ts`'s `sketchPanel()`. It draws the identical shapes and it
// is NOT a per-frame path either: it splits into a static base layer plus a fill layer that is
// re-stroked only when the HP actually crosses a pip boundary, with the blink on the layer's alpha.
import * as PIXI from 'pixi.js-legacy';
import { bakeLazy } from '../bake';

const HP_CELLS    = 10;
const HP_CELL_W   = 21;
const HP_CELL_GAP = 3;
export const HP_BAR_W = HP_CELLS * (HP_CELL_W + HP_CELL_GAP) - HP_CELL_GAP;

/** Parametric heart outline (same curve as icons/equipment.ts drawHp), as plain points for fill/clip. */
export function heartPoints(s: number): { x: number; y: number }[] {
  const cx = s / 2, cy = s * 0.46, k = s * 0.025;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 24; i++) {
    const tt = (Math.PI * 2 * i) / 24;
    const hx = 16 * Math.pow(Math.sin(tt), 3);
    const hy = 13 * Math.cos(tt) - 5 * Math.cos(2 * tt) - 2 * Math.cos(3 * tt) - Math.cos(4 * tt);
    pts.push({ x: cx + hx * k, y: cy - hy * k });
  }
  return pts;
}

/** Sutherland–Hodgman clip of a closed polygon to the half-plane x <= clipX. */
export function clipPolygonRight(pts: { x: number; y: number }[], clipX: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const cur = pts[i]!, prev = pts[(i - 1 + n) % n]!;
    const curIn = cur.x <= clipX, prevIn = prev.x <= clipX;
    if (curIn !== prevIn) {
      const t = (clipX - prev.x) / (cur.x - prev.x);
      out.push({ x: clipX, y: prev.y + t * (cur.y - prev.y) });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

// ── Shared ink ────────────────────────────────────────────────────────────────

const PIP_LINE_COLOR = 0x888888;
const PIP_LINE_ALPHA = 0.4;
const PIP_BASE_FILL  = 0xdddddd;
const PIP_BASE_ALPHA = 0.4;

/** Amber ⚠ box: the triangle's width/height and how far above the bar its top sits. */
const WARN_W = 16, WARN_H = 13, WARN_TOP_Y = -WARN_H - 4;
const WARN_AMBER = 0xffb300, WARN_INK = 0x4a3200;

/**
 * The heart's own bounds inside its `HP_CELL_W`-wide cell, padded for the 1px outline (`lineStyle`
 * straddles the path by half its width). Derived from {@link heartPoints} rather than written down,
 * so a change to the curve can't silently crop the bake.
 */
const PIP_PAD = 1;
const PIP_BOUNDS = (() => {
  const pts = heartPoints(HP_CELL_W);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX: minX - PIP_PAD, minY: minY - PIP_PAD, maxX: maxX + PIP_PAD, maxY: maxY + PIP_PAD };
})();
const PIP_W = PIP_BOUNDS.maxX - PIP_BOUNDS.minX;
const PIP_H = PIP_BOUNDS.maxY - PIP_BOUNDS.minY;

/** Where each region starts along the atlas strip. */
const ATLAS_EMPTY_X = 0;
const ATLAS_FILL_X  = HP_BAR_W;
const ATLAS_WARN_X  = HP_BAR_W + PIP_W;
const ATLAS_W       = HP_BAR_W + PIP_W + WARN_W;
const ATLAS_H       = Math.max(PIP_H, WARN_H);

/** One empty (gray) heart at cell-local `x`, into `g`. */
function traceEmptyPip(g: PIXI.Graphics, x: number): void {
  g.lineStyle(1, PIP_LINE_COLOR, PIP_LINE_ALPHA);
  g.beginFill(PIP_BASE_FILL, PIP_BASE_ALPHA);
  g.drawPolygon(heartPoints(HP_CELL_W).map(p => new PIXI.Point(x + p.x, p.y)));
  g.endFill();
}

/** The ⚠ glyph at local origin (triangle top-left of the box), into `g`, at full alpha. */
function traceWarning(g: PIXI.Graphics, alpha = 1): void {
  g.beginFill(WARN_AMBER, alpha);
  g.moveTo(WARN_W / 2, 0);
  g.lineTo(0, WARN_H);
  g.lineTo(WARN_W, WARN_H);
  g.closePath();
  g.endFill();
  g.beginFill(WARN_INK, alpha); // the "!" inside
  g.drawRect(WARN_W / 2 - 1, 3, 2, WARN_H - 7);
  g.drawRect(WARN_W / 2 - 1, WARN_H - 3, 2, 2);
  g.endFill();
}

/**
 * The one texture every HP bar draws from: `[ten empty pips | one white pip | the ⚠ ]`.
 *
 * White, not faction-colored, for the fill pip — both bars `tint` the same texture, so the atlas
 * stays a single baseTexture and the whole bar batches into one draw call.
 *
 * Not `pageScale` (ADR-073): a few kilobytes of shared chrome, and the HUD strip rides containers
 * that can animate above scale 1 during the game-over pop.
 */
function hpPipAtlas(): PIXI.Texture | null {
  return bakeLazy('hud hp pip atlas', () => {
    const root = new PIXI.Container();

    const empty = new PIXI.Graphics();
    for (let i = 0; i < HP_CELLS; i++) traceEmptyPip(empty, i * (HP_CELL_W + HP_CELL_GAP));
    empty.x = ATLAS_EMPTY_X - PIP_BOUNDS.minX;
    empty.y = -PIP_BOUNDS.minY;

    const fill = new PIXI.Graphics();
    fill.beginFill(0xffffff);
    fill.drawPolygon(heartPoints(HP_CELL_W).map(p => new PIXI.Point(p.x, p.y)));
    fill.endFill();
    fill.x = ATLAS_FILL_X - PIP_BOUNDS.minX;
    fill.y = -PIP_BOUNDS.minY;

    const warn = new PIXI.Graphics();
    traceWarning(warn);
    warn.x = ATLAS_WARN_X;

    root.addChild(empty, fill, warn);
    return root;
  }, ATLAS_W, ATLAS_H);
}

// ── The bar ───────────────────────────────────────────────────────────────────

/**
 * Danger tiers. Two of them, and the hue NEVER changes: our own low-HP alarm must not be mistakable
 * for the enemy's red (art-direction §3.2), so danger is signalled by the filled pips *blinking*.
 *   low      (≤3 cells): gentle blink.
 *   critical (last cell): urgent fast blink + an amber ⚠ above the bar. The last cell is the "one
 *     haste-rush from over" moment for BOTH bases, so the enemy bar escalates too (it also gets a
 *     base ring on the board).
 */
function fillAlphaFor(filledCeil: number, hp: number, pulse: number, pulseFast: number): number {
  const critical = hp > 0 && filledCeil <= 1;
  const low      = hp > 0 && filledCeil <= 3 && !critical;
  return critical ? 0.25 + 0.75 * pulseFast : low ? 0.35 + 0.6 * pulse : 0.9;
}

/**
 * One HP bar. Origin is the bar's top-left; the ⚠ sits above it in negative y, as it always has.
 *
 * `sync()` is called every frame and must stay allocation-free and geometry-free on the common
 * path: it writes `frame` / `tint` / `alpha` / `visible` and nothing else. The only work that can
 * touch geometry is the fallback's fill layer, and that is gated on the HP signature.
 */
export class HpBarView {
  readonly container: PIXI.Container;

  private readonly color: number;

  /** Sprite path (a bake renderer exists). */
  private fillSprites: PIXI.Sprite[] = [];
  private warnSprite: PIXI.Sprite | null = null;

  /** Fallback path (headless): a static base layer + a fill layer re-stroked only on HP change. */
  private baseGfx: PIXI.Graphics | null = null;
  private fillGfx: PIXI.Graphics | null = null;
  /** Last HP fraction the fallback's fill layer was stroked for — `-1` forces the first draw. */
  private fillSig = -1;

  constructor(color: number) {
    this.container = new PIXI.Container();
    this.color     = color;

    const atlas = hpPipAtlas();
    if (atlas) this.buildSprites(atlas);
    else       this.buildFallback();
  }

  private buildSprites(atlas: PIXI.Texture): void {
    const base = atlas.baseTexture;

    const empty = new PIXI.Sprite(new PIXI.Texture(base, new PIXI.Rectangle(ATLAS_EMPTY_X, 0, HP_BAR_W, PIP_H)));
    empty.x = PIP_BOUNDS.minX;
    empty.y = PIP_BOUNDS.minY;
    this.container.addChild(empty);

    for (let i = 0; i < HP_CELLS; i++) {
      const s = new PIXI.Sprite(new PIXI.Texture(base, new PIXI.Rectangle(ATLAS_FILL_X, 0, PIP_W, PIP_H)));
      s.x = i * (HP_CELL_W + HP_CELL_GAP) + PIP_BOUNDS.minX;
      s.y = PIP_BOUNDS.minY;
      s.tint = this.color;
      s.visible = false;
      this.fillSprites.push(s);
      this.container.addChild(s);
    }

    const warn = new PIXI.Sprite(new PIXI.Texture(base, new PIXI.Rectangle(ATLAS_WARN_X, 0, WARN_W, WARN_H)));
    warn.x = (HP_BAR_W - WARN_W) / 2;
    warn.y = WARN_TOP_Y;
    warn.visible = false;
    this.warnSprite = warn;
    this.container.addChild(warn);
  }

  private buildFallback(): void {
    const base = new PIXI.Graphics();
    for (let i = 0; i < HP_CELLS; i++) traceEmptyPip(base, i * (HP_CELL_W + HP_CELL_GAP));
    const fill = new PIXI.Graphics();
    this.baseGfx = base;
    this.fillGfx = fill;
    this.container.addChild(base, fill);
  }

  /** Per-frame update. `pulse`/`pulseFast` are 0..1 blink phases owned by the caller. */
  sync(hp: number, maxHp: number, pulse: number, pulseFast: number): void {
    const totalFrac  = Math.max(0, hp / maxHp) * HP_CELLS;
    const filledFull = Math.floor(totalFrac);
    const partial    = totalFrac - filledFull;
    const filledCeil = Math.ceil(totalFrac);
    const critical   = hp > 0 && filledCeil <= 1;
    const alpha      = fillAlphaFor(filledCeil, hp, pulse, pulseFast);

    if (this.warnSprite) {
      this.warnSprite.visible = critical;
      if (critical) this.warnSprite.alpha = 0.4 + 0.6 * pulseFast;
    }

    if (this.fillSprites.length > 0) {
      for (let i = 0; i < HP_CELLS; i++) {
        const s = this.fillSprites[i]!;
        const frac = i < filledFull ? 1 : i === filledFull ? partial : 0;
        s.visible = setFillCrop(s, frac);
        if (s.visible) s.alpha = alpha;
      }
      return;
    }

    // Fallback: blink on the layer, geometry only when the fill actually changes shape.
    const fill = this.fillGfx;
    if (!fill) return;
    fill.alpha = alpha;
    const sig = Math.round(totalFrac * 1000);
    if (sig === this.fillSig) return;
    this.fillSig = sig;
    fill.clear();
    for (let i = 0; i < HP_CELLS; i++) {
      const frac = i < filledFull ? 1 : i === filledFull ? partial : 0;
      if (frac <= 0) continue;
      const x = i * (HP_CELL_W + HP_CELL_GAP);
      const pts = heartPoints(HP_CELL_W);
      const clipped = frac >= 1 ? pts : clipPolygonRight(pts, frac * HP_CELL_W);
      if (clipped.length < 3) continue;
      fill.lineStyle(frac >= 1 ? 1 : 0, PIP_LINE_COLOR, PIP_LINE_ALPHA);
      fill.beginFill(this.color);
      fill.drawPolygon(clipped.map(p => new PIXI.Point(x + p.x, p.y)));
      fill.endFill();
    }
    if (critical) traceWarning(fill, 1);
  }

  /**
   * The per-pip `PIXI.Texture` objects are this view's own (sub-frames of the SHARED, cached atlas
   * baseTexture), so they are destroyed here with `destroy(false)` — destroying the base would take
   * the bake cache's entry down with it and break every later battle.
   */
  destroy(): void {
    for (const s of this.fillSprites) s.texture.destroy(false);
    this.warnSprite?.texture.destroy(false);
    this.container.destroy({ children: true });
  }
}

/**
 * Crop a fill pip to `frac` of the heart's width, left to right — the sprite-path equivalent of
 * `clipPolygonRight`. Returns whether anything is left to show.
 *
 * Moving a `frame` rebuilds four UVs; the polygon version rebuilt 24 points through earcut. The
 * rect is MUTATED rather than replaced so a pip whose fraction changes every frame (a base under
 * sustained fire) still allocates nothing.
 *
 * `frac` is measured in CELL coordinates (0..HP_CELL_W, as the clip always was), while the frame is
 * measured from the pip's padded left edge — hence the `PIP_BOUNDS.minX` shift. A fraction small
 * enough that the clip line falls left of the heart's own leading edge yields nothing to draw,
 * which is the sprite-path spelling of the old `clipped.length < 3` guard.
 */
function setFillCrop(s: PIXI.Sprite, frac: number): boolean {
  const w = Math.max(0, Math.min(PIP_W, frac * HP_CELL_W - PIP_BOUNDS.minX));
  if (w <= 0) return false;
  const f = s.texture.frame;
  if (f.width !== w) {
    f.width = w;
    s.texture.updateUvs();
  }
  return true;
}
