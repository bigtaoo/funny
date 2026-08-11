// GachaScene reveal overlay: the post-draw card fan, per-card rendering, and the legendary
// border trail (see ./trail.ts for the geometry/colour math this drives).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import type { GachaResultEntry } from '../../net/ApiClient';
import { ui as C, txt, txtOutlined } from '../../render/sketchUi';
import { gachaCardTexture, gachaFrameTexture } from '../../render/gachaArt';
import { FS, snapFont } from '../../render/fontScale';
import { getCachedTexture } from '../../ui/widgets/uiCache';
import { RARITY_COLOR } from './core';
import { LegendaryTrail, RectPerim, buildRectPerim, pointOnPerim, drawTrailDotGraphic, TRAIL_INSET, TRAIL_DOTS, TRAIL_SPAN, TRAIL_PAIR_OFFSET, hslToHex, trailHue, trailDotFalloff } from './trail';
import type { GachaSceneCore } from './core';

export interface RevealHandlers {
  drawReveal(results: GachaResultEntry[]): void;
}

/** The one method RevealPanel needs from OddsPanel — narrowed per claudedocs/client-modules.md's
 *  composition rule (constructor takes the smallest interface that covers the actual cross-domain
 *  calls, not the whole sibling class). */
export interface EntryPictureSource {
  drawEntryPicture(itemId: string, rarity: GachaResultEntry['rarity'], cx: number, cy: number, size: number, seed: number): void;
}

/** Draw-reveal domain (see ../GachaScene.ts assembly + ./core.ts for the shared state). */
export class RevealPanel implements RevealHandlers {
  constructor(
    private readonly core: GachaSceneCore,
    private readonly entryPictures: EntryPictureSource,
  ) {}

  drawReveal(results: GachaResultEntry[]): void {
    const core = this.core;
    const { w, h } = core;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.82);
    dim.drawRect(0, 0, w, h);
    dim.endFill();
    core.container.addChild(dim);

    const header = txt(t('gacha.results'), FS.headline, 0xffffff, true);
    header.anchor.set(0.5, 0.5);
    header.x = w / 2;
    header.y = Math.round(h * 0.12);
    core.container.addChild(header);

    // Grid: landscape always uses the flat 5-wide wrap (a ten-pull → 2 rows of 5; single →
    // 1 card centred). Portrait ten-pulls use a 3/4/3 "diamond" instead — see rowSizesFor()'s
    // doc comment for why: a flat 5×2 squeezes each card to 16% of the (narrower) portrait
    // width, and epic+ pulls are already sorted to the front (GACHA_DESIGN §4.4), so shrinking
    // the widest row to 4 also gives the eye-catching early pulls a visually larger card.
    const n = results.length;
    const gapX = Math.round(w * 0.02);
    const gapY = Math.round(h * 0.02);
    const rowSizes = this.rowSizesFor(n);
    const maxCols = Math.max(...rowSizes);
    // Keep the same overall grid footprint the flat 5-col layout used (5 cards @ 16% width each
    // + 4 gaps), just redistributed across fewer columns per row — so a 3/4/3 row's cards grow
    // instead of the whole grid shrinking or growing unexpectedly.
    const flatCellW = Math.round(w * 0.16);
    const targetGridW = 5 * flatCellW + 4 * gapX;
    const cellW = Math.round((targetGridW - (maxCols - 1) * gapX) / maxCols);
    const cellH = Math.round(cellW * 1.3);
    const gridH = rowSizes.length * cellH + (rowSizes.length - 1) * gapY;
    const startY = (h - gridH) / 2;

    let idx = 0;
    rowSizes.forEach((count, rowIdx) => {
      const rowW = count * cellW + (count - 1) * gapX;
      const rowStartX = (w - rowW) / 2;
      const cy = startY + rowIdx * (cellH + gapY);
      for (let c = 0; c < count; c++) {
        const r = results[idx];
        const cx = rowStartX + c * (cellW + gapX);
        this.drawResultCard(r, cx, cy, cellW, cellH, idx + 1);
        idx++;
      }
    });

    // A 10-pull's grid (2 rows landscape, 3 rows portrait) can reach as far down as the
    // default hint slot; anchor below the actual grid bottom instead of a fixed fraction,
    // and outline the text so it reads over both dark (epic/legendary) and light (common)
    // card stock.
    const gridBottom = startY + gridH;
    const hint = txtOutlined(t('gacha.tapContinue'), FS.label, C.light, C.dark, 3);
    hint.anchor.set(0.5, 0.5);
    hint.x = w / 2;
    hint.y = Math.min(Math.round(h * 0.97), Math.max(Math.round(h * 0.92), Math.round(gridBottom + h * 0.03)));
    core.container.addChild(hint);
  }

  /**
   * How many cards go in each row of the reveal grid, top to bottom. `draw()` only ever
   * returns 1 or 10 results (GachaSceneCallbacks.draw's `count: 1 | 10`), so in practice this
   * is either a single centred card or a ten-pull; the flat wrap-at-5 chunking below is just
   * a defensive fallback if that ever changes. Landscape keeps the original flat 5-wide wrap
   * (a ten-pull → [5, 5]). Portrait ten-pulls get a 3/4/3 "diamond" instead (2026-08-10,
   * user-requested): narrower portrait screens squeezed each of 5-across down to 16% width
   * with barely-legible name plates, and dropping the widest row to 4 lets every card grow
   * ~1/4 larger for the same total grid footprint (see targetGridW in drawReveal).
   */
  private rowSizesFor(n: number): number[] {
    if (!this.core.landscape && n === 10) return [3, 4, 3];
    const cols = Math.min(5, n) || 1;
    const rows = Math.ceil(n / cols);
    const sizes = new Array(rows).fill(cols);
    sizes[rows - 1] = n - cols * (rows - 1); // last row may be shorter (defensive; not hit by 1/10)
    return sizes;
  }

  private drawResultCard(r: GachaResultEntry, x: number, y: number, w: number, h: number, seed: number): void {
    const core = this.core;
    // Card background texture (rarity-specific — epic/legendary art is a dark
    // purple/gold wash that swallows dark ink text, so the id/badge sit on
    // their own paper-coloured plate rather than directly on the art).
    const cardSpr = new PIXI.Sprite(gachaCardTexture(r.rarity));
    cardSpr.x = x;
    cardSpr.y = y;
    cardSpr.width = w;
    cardSpr.height = h;
    core.container.addChild(cardSpr);

    // Item picture — same per-item representation used in the odds-detail grid
    // (material icon / equipment glyph / real unit art / skin portrait / rarity
    // star fallback), so a glance shows *what* was drawn, not just its id string.
    // Pulled down from the card top (portrait art was clipping heads against the
    // frame decoration otherwise) and sized to leave a small name plate at the
    // bottom rather than a half-card white gutter.
    const picSize = Math.round(Math.min(w, h) * 0.68);
    const picTop = y + h * 0.15;
    this.entryPictures.drawEntryPicture(r.itemId, r.rarity, x + w / 2, picTop + picSize / 2, picSize, seed);

    // Name plate — a tight pill just big enough for the text, not a half-card
    // gutter, with its own bordered background so the name reads as a label.
    const plateH = Math.round(h * 0.12);
    const plateY = y + h * 0.87 - plateH;
    const plate = new PIXI.Graphics();
    plate.lineStyle(Math.max(1.5, Math.round(h * 0.006)), RARITY_COLOR[r.rarity], 0.9);
    plate.beginFill(C.paper, 0.92);
    plate.drawRoundedRect(x + w * 0.08, plateY, w * 0.84, plateH, plateH * 0.3);
    plate.endFill();
    core.container.addChild(plate);

    // Item name (translated display name, not the raw itemId), centred in the plate.
    const idLbl = txt(core.displayName(r.itemId), snapFont(Math.round(h * 0.065)), C.dark);
    idLbl.anchor.set(0.5, 0.5);
    idLbl.x = x + w / 2;
    idLbl.y = plateY + plateH * 0.5;
    if (idLbl.width > w * 0.78) idLbl.scale.set((w * 0.78) / idLbl.width);
    core.container.addChild(idLbl);

    // NEW stamp — duplicates get nothing (a "Dup" label read as noise). Printed
    // straight onto the picture at an angle, like a rubber ink stamp, rather
    // than sitting as a separate plate label.
    if (!r.duplicate) {
      const stamp = new PIXI.Container();
      const stampW = Math.round(w * 0.86);
      const stampH = Math.round(h * 0.13);
      const ink = 0xaf2430;
      const border = new PIXI.Graphics();
      border.lineStyle(Math.max(2, Math.round(h * 0.012)), ink, 0.9);
      border.drawRoundedRect(-stampW / 2, -stampH / 2, stampW, stampH, stampH * 0.3);
      stamp.addChild(border);
      const label = txt(t('gacha.new'), snapFont(Math.round(h * 0.085)), ink, true);
      label.anchor.set(0.5, 0.5);
      stamp.addChild(label);
      stamp.rotation = -0.3;
      stamp.alpha = 0.88;
      stamp.x = x + w / 2;
      stamp.y = picTop + picSize - h * 0.05;
      core.container.addChild(stamp);
    }

    // Frame overlay — drawn last so it sits on top of the card art.
    const frameSpr = new PIXI.Sprite(gachaFrameTexture(r.rarity));
    frameSpr.x = x;
    frameSpr.y = y;
    frameSpr.width = w;
    frameSpr.height = h;
    core.container.addChild(frameSpr);

    // Legendary (orange) cards get a clockwise-looping border trail, advanced each frame in
    // update(). Purple/blue/grey tiers stay static.
    if (r.rarity === 'legendary') this.addLegendaryTrail(x, y, w, h);
  }

  /**
   * Add two comet-like dot trails looping clockwise around a legendary reveal card's rounded-rect
   * border, additively blended with a holographic-foil hue cycle (TRAIL_HUE_CYCLES) so the streak
   * reads as shimmering foil rather than a flat gold tint. The second trail starts a half-lap ahead
   * (TRAIL_PAIR_OFFSET = 0.5) — for the reveal grid's portrait card ratio that half-lap lands almost
   * exactly on the opposite corner (u=0 ≈ top-left, u=0.5 ≈ bottom-right), so the pair reads as two
   * comets chasing each other from diagonally opposite corners rather than one trail with a twin
   * riding right behind it. Built once per card as TRAIL_DOTS pooled sprites of a single baked
   * radial-gradient texture (see uiCache) per trail; update() repositions and re-tints them each frame
   * by walking the border's perimeter analytically (pointOnPerim) — cheap per-dot transform + colour
   * math, no Graphics redraw. No mask needed either: the dots are mathematically constrained to the
   * border so they never bleed off-card. Both trails are pushed onto `revealFx`; cleaned up with the
   * container on the next render()/destroy().
   */
  private addLegendaryTrail(x: number, y: number, w: number, h: number): void {
    const core = this.core;
    const iw = w - TRAIL_INSET * 2;
    const ih = h - TRAIL_INSET * 2;
    const perim = buildRectPerim(x + TRAIL_INSET, y + TRAIL_INSET, iw, ih, Math.min(iw, ih) * 0.06);
    const tex = getCachedTexture('gacha:legendary-trail-dot', drawTrailDotGraphic, 64, 64) ?? PIXI.Texture.WHITE;
    core.revealFx.push(this.buildTrailDots(perim, tex, 0));
    core.revealFx.push(this.buildTrailDots(perim, tex, TRAIL_PAIR_OFFSET));
  }

  /** Build one comet trail's pooled dot sprites, head starting at perimeter fraction `startPhase`. */
  private buildTrailDots(perim: RectPerim, tex: PIXI.Texture, startPhase: number): LegendaryTrail {
    const n = TRAIL_DOTS;
    const dots: PIXI.Sprite[] = [];
    for (let i = 0; i < n; i++) {
      const spr = new PIXI.Sprite(tex);
      spr.anchor.set(0.5);
      const u = startPhase - (i / n) * TRAIL_SPAN; // initial position at phase startPhase, matches update()'s formula
      const eased = trailDotFalloff(i, n); // squared falloff → soft comet-like tail (see its doc comment)
      spr.alpha = eased;
      spr.scale.set(0.35 + 0.65 * eased);
      spr.tint = hslToHex(trailHue(u, startPhase), 0.62, 0.78);
      spr.blendMode = PIXI.BLEND_MODES.ADD;
      const p = pointOnPerim(perim, u);
      spr.position.set(p.x, p.y);
      this.core.container.addChild(spr);
      dots.push(spr);
    }
    return { dots, perim, phase: startPhase };
  }
}
