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
  const headerH = ctx.topInset;

  // Auction button — far right of the header bar. Width auto-fits the icon+label so the
  // text never clips, and the larger right margin (56) pulls it clear of the screen edge.
  const aucH = Math.round(headerH * 0.7);
  const aIconSize = Math.round(aucH * 0.4);
  const aIcon = buildIcon('tag', aIconSize, C.light);
  const aTxt = txt(t('world.auction'), snapFont(Math.round(aucH * 0.34)), C.light);
  aTxt.anchor.set(0, 0.5);
  const aGrpW = aIconSize + 4 + aTxt.width;
  const aucW = Math.ceil(aGrpW) + 24; // horizontal padding around the content group
  const aucBtn = sketchButton(aucW, aucH, seedFor(1, 0, aucW));
  aucBtn.x = w - aucW - 56;
  aucBtn.y = (headerH - aucH) / 2;
  layer.addChild(aucBtn);
  const aGx = aucBtn.x + (aucW - aGrpW) / 2;
  aIcon.x = aGx;
  aIcon.y = aucBtn.y + (aucH - aIconSize) / 2;
  aTxt.x = aGx + aIconSize + 4;
  aTxt.y = aucBtn.y + aucH / 2;
  layer.addChild(aIcon);
  layer.addChild(aTxt);
  ctx.aucBtnRect = { x: aucBtn.x, y: aucBtn.y, w: aucW, h: aucH };

  // Shop button — immediately left of the auction button, same sizing/style so the pair
  // reads as one entry-point group (2026-08-02: shop pulled out of the Territory Overview
  // panel into its own item-card catalog — see openShopPanel/renderShopPanel).
  const sIconSize = aIconSize;
  const sIcon = buildIcon('coinSack', sIconSize, C.light);
  const sTxt = txt(t('world.tabShop'), snapFont(Math.round(aucH * 0.34)), C.light);
  sTxt.anchor.set(0, 0.5);
  const sGrpW = sIconSize + 4 + sTxt.width;
  const shopW = Math.ceil(sGrpW) + 24;
  const shopBtn = sketchButton(shopW, aucH, seedFor(1, 1, shopW));
  shopBtn.x = aucBtn.x - shopW - 8;
  shopBtn.y = aucBtn.y;
  layer.addChild(shopBtn);
  const sGx = shopBtn.x + (shopW - sGrpW) / 2;
  sIcon.x = sGx;
  sIcon.y = shopBtn.y + (aucH - sIconSize) / 2;
  sTxt.x = sGx + sIconSize + 4;
  sTxt.y = shopBtn.y + aucH / 2;
  layer.addChild(sIcon);
  layer.addChild(sTxt);
  ctx.shopBtnRect = { x: shopBtn.x, y: shopBtn.y, w: shopW, h: aucH };

  // Per-resource readout — centered between the back button and the shop button,
  // replacing the old "World" title text. Two stacked lines per resource: production
  // rate on top, current stockpile total underneath (2026-08-09: the total used to live
  // only in the right-side troops/territory card — moved up here, alongside the rate it
  // feeds, so both numbers for a resource read together instead of in two separate panels).
  const yieldRate = ctx.me?.yieldRate ?? {};
  const resTotals = ctx.me?.resources ?? {};
  const iconSize = Math.round(headerH * 0.42);
  const fontSize = snapFont(Math.round(headerH * 0.2));
  const lineGap = 2;
  const gap = Math.round(headerH * 0.3);
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
  const leftBound = ctx.backRect.x + ctx.backRect.w + 8;
  const rightBound = shopBtn.x - 8;

  // Shrink-to-fit (2026-08-11 portrait clipping fix): at nominal sizes, 5 resources'
  // rate+total labels can badly overflow the narrow portrait design width (1080) once
  // stockpiles grow past a few digits — e.g. ~1550px of content vs ~560px available
  // between the back button and the shop/auction buttons. Previously nothing clamped
  // this, so the tail resources (and their totals) rendered past the visible canvas
  // edge and were cut off mid-digit. Scale the whole cluster down uniformly rather than
  // wrapping/reflowing — keeps every resource visible and legible instead of some being
  // silently unreadable off-screen. Floor of 0.55 keeps the smallest case still legible;
  // below that we accept a slight overflow rather than shrinking to illegible text.
  const availW = Math.max(0, rightBound - leftBound);
  const fitScale = cx > availW ? Math.max(0.55, availW / cx) : 1;
  if (fitScale < 1) cluster.scale.set(fitScale);
  const drawnW = cx * fitScale;

  cluster.x = leftBound + Math.max(0, (rightBound - leftBound - drawnW) / 2);
  cluster.y = headerH / 2;

  // Independent background panel behind the resource cluster, distinguishing it from the
  // shared header-bar chrome instead of floating directly on it.
  const padX = 10,
    padY = Math.round(headerH * 0.14);
  const bgPanel = sketchPanel(drawnW + padX * 2, headerH - padY * 2, {
    fill: C.paper,
    border: C.mid,
    seed: seedFor(2, 0, cx),
  });
  bgPanel.x = cluster.x - padX;
  bgPanel.y = padY;
  layer.addChild(bgPanel);
  layer.addChild(cluster);
  // Tappable: opens the Territory Overview panel (SLG_DESIGN_LOG.md §26).
  ctx.resClusterRect = {
    x: bgPanel.x,
    y: bgPanel.y,
    w: drawnW + padX * 2,
    h: headerH - padY * 2,
  };
}
