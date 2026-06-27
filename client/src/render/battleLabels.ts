/**
 * battleLabels.ts — the battlefield corner hand-lettering layer (art-direction
 * §6.2, B 组). Snaps the B-group labels (`labelDecor`) into the paper margins
 * flanking the grid: `[START]` scrawled by the local player's base, `BOSS` by the
 * enemy base on boss campaign levels. Pure scene-setting marginalia — like the
 * A-group doodle layer (`decorLayer`) it sits OUTSIDE the board rect, so it never
 * touches a cell, base, or HUD, and it never eats pointer events.
 *
 * Unlike the dense A-group scatter this is at most a couple of static sprites, so
 * there is nothing worth baking — they cost nothing per frame and the live-sprite
 * path also works in headless tests (no renderer needed). Labels keep their baked
 * ink colour and are NOT tinted (§6.2 注).
 *
 * `WIN!` (label_win) lives on the victory overlay (HUDView.showGameOver) and the
 * `→ here` arrow (label_arrow_here) is reserved for tutorial pointing, so neither
 * is placed here.
 */
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../layout/ILayout';
import { Side } from '../game';
import { getLabelTexture, isLabelDecorReady, type LabelName } from './labelDecor';

/** What scene-setting labels this battle should scrawl in the margins. */
export interface BattleLabelContext {
  /** Show `[START]` by the local base (every battle; PvP uses only this). */
  start?: boolean;
  /** Show `BOSS` by the enemy base (boss campaign levels). */
  boss?: boolean;
}

// ── Tuning ───────────────────────────────────────────────────────────────────
const MIN_BAND_W   = 24;     // narrower strips aren't worth lettering
const LABEL_LONG   = 128;    // cap on a label's longest rendered side
const HORIZ_MIN_BW = 88;     // band at least this wide → letter horizontally, else sideways
const ALPHA        = 0.66;   // an intentional annotation — bolder than ambient doodles, still marginalia
const TILT         = -0.05;  // a touch of careless hand
const EDGE_PAD     = 8;      // gap from the band's far end

interface Band { side: 'left' | 'right'; rect: Rect; }

/** The two paper strips flanking the grid, within the board's vertical extent. */
function marginBands(layout: ILayout): Band[] {
  const r = layout.boardRect;
  return ([
    { side: 'left',  rect: { x: 0, y: r.y, w: r.x, h: r.h } },
    { side: 'right', rect: { x: r.x + r.w, y: r.y, w: layout.designWidth - (r.x + r.w), h: r.h } },
  ] as Band[]).filter((b) => b.rect.w >= MIN_BAND_W);
}

/**
 * Build a sprite for `name`, fitted into `band` and anchored toward the band's
 * top or bottom end. Returns null if the texture isn't loaded. Wide bands get
 * horizontal lettering; narrow side margins rotate it to run along the strip.
 */
function makeLabel(name: LabelName, band: Band, end: 'top' | 'bottom'): PIXI.Sprite | null {
  const tex = getLabelTexture(name);
  if (!tex) return null;
  const bw = band.rect.w, bh = band.rect.h;
  const spr = new PIXI.Sprite(tex);
  spr.anchor.set(0.5);
  spr.alpha = ALPHA;

  let scale: number;
  let alongExtent: number;  // the label's extent ALONG the band (used for the end offset)
  if (bw >= HORIZ_MIN_BW) {
    // Horizontal: fit the label's width across the band.
    scale = Math.min(LABEL_LONG / Math.max(tex.width, tex.height), (bw * 0.92) / tex.width);
    spr.rotation = TILT;
    alongExtent = tex.height * scale;
  } else {
    // Sideways margin note: rotate −90° so the text runs up the strip.
    scale = Math.min((bw * 0.85) / tex.height, (bh * 0.5) / tex.width);
    spr.rotation = -Math.PI / 2 + TILT;
    alongExtent = tex.width * scale;
  }
  spr.scale.set(scale);

  spr.x = band.rect.x + bw / 2;
  const off = EDGE_PAD + alongExtent / 2;
  spr.y = end === 'top' ? band.rect.y + off : band.rect.y + bh - off;
  return spr;
}

/**
 * Build the static corner-label container for this layout + context, or null if
 * there is nothing to draw (labels not loaded yet, no usable margin, or empty
 * context). Caller adds the returned container to the scene.
 *
 * `[START]` goes near the local base, `BOSS` near the enemy base. The local base
 * is at the bottom of the screen when `localSide === Side.Bottom` (the usual
 * single-player / host case); we pick the band END accordingly so each label
 * actually sits beside the base it annotates. The two labels take opposite side
 * strips when both are present so they don't clump.
 */
export function buildBattleLabels(layout: ILayout, ctx: BattleLabelContext): PIXI.Container | null {
  if (!ctx.start && !ctx.boss) return null;
  if (!isLabelDecorReady()) return null;

  const bands = marginBands(layout);
  if (bands.length === 0) return null;
  const left  = bands.find((b) => b.side === 'left')  ?? bands[0]!;
  const right = bands.find((b) => b.side === 'right') ?? bands[0]!;

  const localAtBottom = layout.localSide === Side.Bottom;
  const startEnd: 'top' | 'bottom' = localAtBottom ? 'bottom' : 'top';
  const bossEnd:  'top' | 'bottom' = localAtBottom ? 'top'    : 'bottom';

  const root = new PIXI.Container();
  if (ctx.start) {
    const spr = makeLabel('label_start', left, startEnd);
    if (spr) root.addChild(spr);
  }
  if (ctx.boss) {
    const spr = makeLabel('label_boss', right, bossEnd);
    if (spr) root.addChild(spr);
  }

  if (root.children.length === 0) { root.destroy({ children: true }); return null; }
  root.interactiveChildren = false;  // pure ambience — never eats pointer events
  return root;
}
