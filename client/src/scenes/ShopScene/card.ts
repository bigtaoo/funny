// Product-card cell rendering, shared by both tabs (shop.ts's icon-card grid and coins.ts's tier
// grid) — split out of core.ts (2026-08-11, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep core.ts under the 500-line
// convention. Only ever called from ShopPanel/CoinsPanel's drawXGrid methods, so these take `core`
// explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';
import { buildMaterialIcon } from '../../render/atlas/materialAtlas';
import { getArtTexture, containScale } from '../../render/cardArt';
import { snapFont } from '../../render/fontScale';
import type { ShopSceneCore, CardSpec, BtnSpec } from './core';

/**
 * Draw one product card as an image-dominant vertical tile: a big square art/icon fills the top,
 * then title, price (coins or $ with optional strike-through), any status lines, and the action
 * button(s) stack full-width below it. A savings badge sits in the top-right corner over the art.
 * Everything is horizontally centered so several narrow cards read cleanly across a row.
 */
export function drawCard(
  core: ShopSceneCore,
  body: PIXI.Container,
  spec: CardSpec,
  x: number,
  y: number,
  cw: number,
  ch: number
): void {
  const box = sketchPanel(cw, ch, {
    fill: spec.highlight ? 0xfff8e8 : C.paper,
    border: spec.highlight ? C.gold : C.line,
    width: spec.highlight ? 2 : 1.6,
    seed: seedFor(x, y, cw),
  });
  box.x = x; box.y = y;
  if (!spec.highlight) sketchAccentBar(box, ch, C.accent, seedFor(x, ch, 3));
  body.addChild(box);

  const pad = Math.round(cw * 0.06);
  const cx = x + cw / 2; // card horizontal centre — everything centres on this
  const innerW = cw - pad * 2;

  // ── Action button(s), pinned at the bottom and reserved first (full-width, stacked when >1) so the
  //    text band above can be clamped to whatever room is left and never overlaps them. ──
  const n = spec.buttons.length;
  const btnH = Math.round(ch * 0.13);
  const bGap = Math.round(ch * 0.02);
  const btnAreaH = n * btnH + Math.max(0, n - 1) * bGap;
  const btnTop = y + ch - pad - btnAreaH;
  spec.buttons.forEach((b, i) => {
    drawButton(core, body, b, x + pad, btnTop + i * (btnH + bGap), innerW, btnH);
  });

  // ── Top: big square art / icon, centred. Shrunk when status lines are present (e.g. item
  //    descriptions) so the wrapped text band below has room without spilling onto the buttons. ──
  const hasLines = (spec.lines?.length ?? 0) > 0;
  const imgSize = Math.min(Math.round(ch * (hasLines ? 0.2 : 0.46)), innerW);
  const imgX = Math.round(cx - imgSize / 2);
  const imgY = y + pad;
  if (spec.artUrl) {
    // Wait for the texture to finish loading before sizing the sprite — setting width/height against
    // an unloaded (0/1px) baseTexture yields a garbage scale and the art never appears; re-render on
    // 'loaded' (mirrors CardScene.drawArtFit).
    const tex = getArtTexture(spec.artUrl);
    if (tex.baseTexture.valid) {
      const art = new PIXI.Sprite(tex);
      const scale = containScale(tex.width, tex.height, imgSize, imgSize);
      art.anchor.set(0.5);
      art.scale.set(scale);
      art.position.set(imgX + imgSize / 2, imgY + imgSize / 2);
      body.addChild(art);
    } else if (!core.artHooked.has(spec.artUrl)) {
      core.artHooked.add(spec.artUrl);
      tex.baseTexture.once('loaded', () => core.render());
    }
  } else {
    const icon = spec.materialKind
      ? buildMaterialIcon(spec.materialKind, imgSize, spec.iconColor)
      : buildCoinIcon(spec.icon, imgSize, spec.iconColor);
    icon.x = imgX; icon.y = imgY;
    body.addChild(icon);
  }

  // "Expiring soon" ink stamp, printed at an angle straight onto the art — same rubber-stamp
  // treatment as GachaScene's "NEW" badge (drawResultCard), reused here for visual consistency.
  if (spec.expiringSoonStamp) {
    const stamp = new PIXI.Container();
    const stampW = Math.round(imgSize * 0.92);
    const stampH = Math.round(imgSize * 0.26);
    const ink = 0xaf2430;
    const border = new PIXI.Graphics();
    border.lineStyle(Math.max(2, Math.round(imgSize * 0.02)), ink, 0.9);
    border.drawRoundedRect(-stampW / 2, -stampH / 2, stampW, stampH, stampH * 0.3);
    stamp.addChild(border);
    const label = txt(t('shop.expiringSoonStamp'), snapFont(Math.round(imgSize * 0.13)), ink, true);
    label.anchor.set(0.5, 0.5);
    if (label.width > stampW * 0.88) label.scale.set((stampW * 0.88) / label.width);
    stamp.addChild(label);
    stamp.rotation = -0.3;
    stamp.alpha = 0.88;
    stamp.x = imgX + imgSize / 2;
    stamp.y = imgY + imgSize / 2;
    body.addChild(stamp);
  }

  // Savings / best-value badge: top-right corner over the art.
  if (spec.badge) {
    const badge = txt(spec.badge.text, snapFont(Math.round(ch * 0.075)), spec.badge.color, true);
    badge.anchor.set(1, 0); badge.x = x + cw - pad; badge.y = y + pad;
    body.addChild(badge);
  }

  // ── Middle text band: title, then price, then status lines — all centred, top-aligned from just
  //    below the art down to just above the buttons. ──
  let ty = imgY + imgSize + Math.round(ch * 0.03);
  const bandBottom = btnTop - Math.round(ch * 0.02);
  const rowGap = Math.round(ch * 0.02);

  // Pre-build whatever price row(s) follow the title so their real measured height is known before
  // sizing the title below — positioned once ty (and any title shrink) is settled.
  let coinRow: { ci: PIXI.DisplayObject; amt: PIXI.Text; cs: number; rowW: number; h: number } | undefined;
  if (spec.coinAmount !== undefined) {
    const cs = Math.round(ch * 0.11);
    const amt = txt(spec.coinAmount.toLocaleString(), snapFont(cs), C.gold, true);
    const rowW = cs + Math.round(cw * 0.02) + amt.width;
    const ci = buildCoinIcon('coin', cs, C.gold);
    coinRow = { ci, amt, cs, rowW, h: Math.max(cs, amt.height) };
  }
  let usdRow: { price: PIXI.Text; strike?: PIXI.Text; h: number } | undefined;
  if (spec.usdCents !== undefined) {
    const price = txt(`$${(spec.usdCents / 100).toFixed(2)}`, snapFont(Math.round(ch * 0.11)), C.gold, true);
    const strike = spec.usdStrikeCents !== undefined
      ? txt(`$${(spec.usdStrikeCents / 100).toFixed(2)}`, snapFont(Math.round(ch * 0.07)), C.mid, false)
      : undefined;
    usdRow = { price, strike, h: price.height };
  }
  const priceReserve = (coinRow ? coinRow.h + rowGap : 0) + (usdRow ? usdRow.h + rowGap : 0);

  // Title can wrap to 3 lines on narrow columns (e.g. portrait's grid) when the product name is long
  // at the "wide card" font — shrink it a step at a time until the wrapped title plus the price row(s)
  // below it actually fit above bandBottom, instead of always drawing at the same size and letting the
  // price land wherever the title happened to end (found 2026-08-11 on the starter_draw card in
  // portrait: the title wrapped to 3 lines and "$0.99" landed on top of the Buy button below it).
  let titleFontPx = Math.round(ch * (hasLines ? 0.06 : 0.085));
  const minTitleFontPx = Math.round(ch * 0.05);
  let title = txt(spec.title, snapFont(titleFontPx), C.dark, true, innerW);
  while (ty + title.height + rowGap + priceReserve > bandBottom && titleFontPx > minTitleFontPx) {
    title.destroy();
    titleFontPx = Math.max(minTitleFontPx, titleFontPx - Math.max(1, Math.round(ch * 0.006)));
    title = txt(spec.title, snapFont(titleFontPx), C.dark, true, innerW);
  }
  title.anchor.set(0.5, 0); title.x = cx; title.y = ty;
  body.addChild(title);
  ty += title.height + rowGap;

  // Even after shrinking, clamp each price row's own start so it can never spill past bandBottom —
  // the same guard the status/bonus lines block right below already applies.
  if (coinRow) {
    const { ci, amt, cs, rowW, h } = coinRow;
    const py = Math.min(ty, bandBottom - h);
    ci.x = Math.round(cx - rowW / 2); ci.y = py;
    body.addChild(ci);
    amt.anchor.set(0, 0); amt.x = ci.x + cs + Math.round(cw * 0.02); amt.y = py + (h - amt.height) / 2;
    body.addChild(amt);
    ty = py + h + rowGap;
  }
  if (usdRow) {
    const { price, strike, h } = usdRow;
    const py = Math.min(ty, bandBottom - h);
    if (strike) {
      const gap = Math.round(cw * 0.03);
      const rowW = strike.width + gap + price.width;
      strike.anchor.set(0, 0.5); strike.x = Math.round(cx - rowW / 2); strike.y = py + price.height / 2;
      body.addChild(strike);
      const line = new PIXI.Graphics();
      line.lineStyle(2, C.mid, 1);
      line.moveTo(strike.x, strike.y).lineTo(strike.x + strike.width, strike.y);
      body.addChild(line);
      price.anchor.set(0, 0); price.x = strike.x + strike.width + gap; price.y = py;
      body.addChild(price);
    } else {
      price.anchor.set(0.5, 0); price.x = cx; price.y = py;
      body.addChild(price);
    }
    ty = py + h + rowGap;
  }

  // Status / bonus lines (Active, Free, item description…) — centred, wrapped, clamped to the band.
  const lines = spec.lines ?? [];
  if (lines.length > 0 && ty < bandBottom) {
    const fontSize = snapFont(Math.round(ch * 0.06));
    for (const ln of lines) {
      if (ty >= bandBottom) break;
      const l = txt(ln.text, fontSize, ln.color, true, innerW);
      // Wrapped text can span multiple physical lines — check the whole block's bottom (not just
      // its start y) against the button area so a long description never spills onto the buttons.
      if (ty + l.height > bandBottom) { l.destroy(); break; }
      l.anchor.set(0.5, 0); l.x = cx; l.y = ty;
      body.addChild(l);
      ty += l.height + Math.round(ch * 0.01);
    }
  }
}

export function drawButton(
  core: ShopSceneCore,
  body: PIXI.Container,
  b: BtnSpec,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const btn = sketchPanel(w, h, {
    fill: b.enabled ? C.dark : C.btnOff,
    border: b.enabled ? (b.primary ? C.green : C.accent) : C.light,
    width: 2, seed: seedFor(x, y, w),
  });
  btn.x = x; btn.y = y;
  body.addChild(btn);
  const lbl = txt(b.label, snapFont(Math.round(h * 0.42)), b.enabled ? 0xffffff : C.mid, true);
  lbl.anchor.set(0.5, 0.5); lbl.x = x + w / 2; lbl.y = y + h / 2;
  body.addChild(lbl);
  if (b.enabled && b.fn) core.hits.push({ rect: { x, y, w, h }, fn: b.fn });
}
