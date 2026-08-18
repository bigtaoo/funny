// WorldMap header-bar HUD content: per-resource production readout (centered in the bar) and
// the shop/auction entry-point buttons (pinned to its far right).
//
// Split out of hud.ts (2026-08-12, claudedocs/client-modules.md "单文件 500 行收敛"):
// independent-function-module extraction (form①) — renderHeaderHud only ever read/wrote
// `ctx` (no calls to HudPanel's other methods, no shared private state), so it's a pure
// function taking `ctx` as an explicit param instead of a class method on HudPanel.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import { snapFont } from '../../../render/fontScale';
import { getResTexture } from '../../../render/atlas/resAtlasLoader';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * Header-bar content (drawn into ctx.headerHudLayer, above the static topLayer chrome):
 * per-resource production rate centered in the bar, and the auction button pinned to its
 * far right. Rebuilt alongside hudLayer on every ~5s march poll so production stays live.
 */
export function renderHeaderHud(ctx: WorldMapContext): void {
  const layer = ctx.headerHudLayer;
  tearDownChildren(layer);
  const { w } = ctx;
  // Bar height alone; `topInset` also covers the portrait resource strip (see build()). The
  // fallback keeps harnesses that only set `topInset` working.
  const headerH = ctx.headerBarH || ctx.topInset;
  // Portrait: the readout lives on its own strip below the bar, and the entry buttons drop their
  // labels so three of them fit next to the back button on a 1080-wide design (see build()).
  const stripH = ctx.resStripH;
  const iconOnly = stripH > 0;

  // Icon-only buttons are square, so their height is also their width budget: three of them plus
  // two 8px gaps have to fit between the back button and the 56px right margin. Without the clamp a
  // taller bar (or a wider back button, whose size also tracks the bar) walks them back over it.
  const btnRowW = w - 56 - (ctx.backRect.x + ctx.backRect.w + 8);
  const btnH = iconOnly
    ? Math.min(Math.round(headerH * 0.7), Math.floor((btnRowW - 16) / 3))
    : Math.round(headerH * 0.7);
  const btnIconSize = Math.round(btnH * 0.4);
  const btnY = (headerH - btnH) / 2;

  /**
   * One header entry button (icon + label, or icon alone in portrait), right-anchored: pass the x
   * its right edge should end at. Returns the rect so the next button can chain off its left edge.
   */
  const entryBtn = (icon: 'tag' | 'coinSack' | 'home', label: string, seedIdx: number, rightEdge: number) => {
    const glyph = buildIcon(icon, btnIconSize, C.light);
    const lbl = iconOnly ? null : txt(label, snapFont(Math.round(btnH * 0.34)), C.light);
    lbl?.anchor.set(0, 0.5);
    const grpW = btnIconSize + (lbl ? 4 + lbl.width : 0);
    const btnW = iconOnly ? btnH : Math.ceil(grpW) + 24; // square when icon-only, else padded group
    const btn = sketchButton(btnW, btnH, seedFor(1, seedIdx, btnW));
    btn.x = rightEdge - btnW;
    btn.y = btnY;
    layer.addChild(btn);
    const gx = btn.x + (btnW - grpW) / 2;
    glyph.x = gx;
    glyph.y = btn.y + (btnH - btnIconSize) / 2;
    layer.addChild(glyph);
    if (lbl) {
      lbl.x = gx + btnIconSize + 4;
      lbl.y = btn.y + btnH / 2;
      layer.addChild(lbl);
    }
    return { x: btn.x, y: btn.y, w: btnW, h: btnH };
  };

  // Auction — far right of the header bar; the 56px margin pulls it clear of notched screen edges.
  ctx.aucBtnRect = entryBtn('tag', t('world.auction'), 0, w - 56);
  // Shop — immediately left of it, same sizing/style so the pair reads as one entry-point group
  // (2026-08-02: shop pulled out of the Territory Overview panel into its own item-card catalog —
  // see openShopPanel/renderShopPanel).
  ctx.shopBtnRect = entryBtn('coinSack', t('world.tabShop'), 1, ctx.aucBtnRect.x - 8);
  // Home — recenters the camera on the player's own base (mainBaseTile) without leaving the world
  // map, for whenever panning/zooming has drifted the view away from it. Omitted before the player
  // has actually joined/placed a base.
  ctx.homeBtnRect = ctx.me?.mainBaseTile
    ? entryBtn('home', t('world.home'), 2, ctx.shopBtnRect.x - 8)
    : { x: 0, y: 0, w: 0, h: 0 };

  // Per-resource readout — in landscape centered between the back button and the shop button
  // (replacing the old "World" title text); in portrait on its own strip under the bar. Two
  // stacked lines per resource: production rate on top, current stockpile total underneath
  // (2026-08-09: the total used to live only in the right-side troops/territory card — moved up
  // here, alongside the rate it feeds, so both numbers for a resource read together instead of in
  // two separate panels).
  const yieldRate = ctx.me?.yieldRate ?? {};
  const resTotals = ctx.me?.resources ?? {};
  // Sized against whichever band the readout actually sits in — the portrait strip is shorter than
  // the bar, so bar-derived sizes would overflow it vertically.
  const bandRef = ctx.resStripH > 0 ? ctx.resStripH : headerH;
  const iconSize = Math.round(bandRef * (ctx.resStripH > 0 ? 0.62 : 0.42));
  const fontSize = snapFont(Math.round(bandRef * (ctx.resStripH > 0 ? 0.28 : 0.2)));
  const lineGap = 2;
  const gap = Math.round(bandRef * 0.3);
  const cluster = new PIXI.Container();
  let cx = 0;
  for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
    const rate = Math.round(yieldRate[rt] ?? 0);
    const tex = getResTexture(rt);
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      sp.width = sp.height = iconSize;
      sp.x = cx;
      sp.y = -iconSize / 2;
      cluster.addChild(sp);
      cx += iconSize + 3;
    }
    const rateLbl = txt(`+${rate}`, fontSize, C.dark);
    const totalLbl = txt(resTotals[rt] !== undefined ? `${resTotals[rt]}` : '', fontSize, C.mid);
    const blockH = rateLbl.height + lineGap + totalLbl.height;
    rateLbl.x = cx;
    rateLbl.y = -blockH / 2;
    totalLbl.x = cx;
    totalLbl.y = -blockH / 2 + rateLbl.height + lineGap;
    cluster.addChild(rateLbl);
    cluster.addChild(totalLbl);
    cx += Math.max(rateLbl.width, totalLbl.width) + gap;
  }
  cx -= gap;
  // Portrait puts the readout on its own full-width strip under the bar; landscape keeps it inside
  // the bar, between the back button and the leftmost entry button.
  const leftBound = iconOnly ? 16 : ctx.backRect.x + ctx.backRect.w + 8;
  const rightBound = iconOnly
    ? w - 16
    : (ctx.homeBtnRect.w > 0 ? ctx.homeBtnRect.x : ctx.shopBtnRect.x) - 8;
  const bandTop = iconOnly ? headerH : 0;
  const bandH = iconOnly ? stripH : headerH;

  // Shrink-to-fit (2026-08-11 portrait clipping fix): at nominal sizes, 5 resources'
  // rate+total labels can badly overflow the narrow portrait design width (1080) once
  // stockpiles grow past a few digits — e.g. ~1550px of content vs ~560px available
  // between the back button and the shop/auction buttons. Previously nothing clamped
  // this, so the tail resources (and their totals) rendered past the visible canvas
  // edge and were cut off mid-digit. Scale the whole cluster down uniformly rather than
  // wrapping/reflowing — keeps every resource visible and legible instead of some being
  // silently unreadable off-screen. The scale is now a hard fit with no floor: portrait's own
  // strip is nearly the full design width, so the shrink it needs is mild (~0.8), and the old
  // 0.55 floor — which deliberately accepted overflow — was what let the readout run over the
  // entry buttons and past the right edge on tall phones.
  const availW = Math.max(0, rightBound - leftBound);
  const fitScale = cx > availW && cx > 0 ? availW / cx : 1;
  if (fitScale < 1) cluster.scale.set(fitScale);
  const drawnW = cx * fitScale;

  cluster.x = leftBound + Math.max(0, (rightBound - leftBound - drawnW) / 2);
  cluster.y = bandTop + bandH / 2;

  // Independent background panel behind the resource cluster, distinguishing it from the
  // shared header-bar chrome instead of floating directly on it.
  const padX = 10,
    padY = Math.round(bandH * 0.14);
  const panelH = bandH - padY * 2;
  const bgPanel = sketchPanel(drawnW + padX * 2, panelH, {
    fill: C.paper,
    border: C.mid,
    seed: seedFor(2, 0, cx),
  });
  bgPanel.x = cluster.x - padX;
  bgPanel.y = bandTop + padY;
  layer.addChild(bgPanel);
  layer.addChild(cluster);
  // Tappable: opens the Territory Overview panel (SLG_DESIGN_LOG.md §26).
  ctx.resClusterRect = {
    x: bgPanel.x,
    y: bgPanel.y,
    w: drawnW + padX * 2,
    h: panelH,
  };
}
