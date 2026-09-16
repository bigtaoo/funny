// listCell.ts — how ONE auction market cell is drawn: the framed item picture, the info column
// (name / level stars / price / my bid / buyout / countdown) and the bottom-right action button or
// status badge. Split out of ./list.ts (2026-09-12) to bring that file back under the 500-line
// convention, form① (independent function module — the split-form priority in
// claudedocs/client-modules.md), the same boundary CardScene/rosterCell.ts took out of its own
// list.ts. Unlike rosterCell.ts there is no cell-local coordinate frame and no signature contract:
// everything here draws in SCENE coordinates (the caller passes the cell's top-left) onto
// `core.bodyLayer`, which ListPanel.renderList has already swapped for the masked grid layer,
// because this grid is rebuilt wholesale on every render() rather than incrementally.
//
// The row actions are reached through the same narrow one-directional interfaces ListPanel itself
// holds (Bid/TradeActions never call back into List); they are declared here rather than in
// ./list.ts so the dependency stays list → listCell with no cycle.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import type { EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { buildIcon } from '../../render/icons';
import { buildLevelStars } from '../../render/levelStars';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { cardInstanceArtUrl, getArtTexture, unitPortraitUrl } from '../../render/cardArt';
import { SKIN_TARGET_UNIT } from '../../game/meta/skinDefs';
import { AUC_CELL_H, AUC_CELL_PAD, AUC_CELL_IMG_GAP, AUC_CELL_IMG_MAX, aucInfoColumnW } from './types';
import type { AuctionSceneCore } from './core';
import { itemKind, saleModeKind, auctionLabel, auctionItemLevel, auctionItemMaxLevel } from './itemLabels';

/** Narrow slice of BidPanel a cell's row action needs — opening the bid modal for an auction-mode listing. */
export interface BidOpener {
  openBidForm(auc: AuctionView): void;
}

/** Narrow slice of TradeActionsPanel a cell's row actions need — confirm-then-buy/cancel. */
export interface TradeOpener {
  confirmBuy(auctionId: string, price: number): void;
  confirmCancel(auctionId: string): void;
}

/** The two panels a cell's bottom-right button dispatches into. */
export interface CellActions {
  bid: BidOpener;
  trade: TradeOpener;
}

/**
 * Auction card cell: a framed item-class glyph on the left (CardScene roster-card treatment),
 * with name/price/status stacked to its right and the row action pinned bottom-right.
 */
export function renderAuctionCell(
  core: AuctionSceneCore, actions: CellActions,
  auc: AuctionView, x: number, y: number, cellW: number, now: number,
): void {
  const pad = AUC_CELL_PAD;
  const isAuction = auc.saleMode === 'auction';

  const cell = sketchPanel(cellW, AUC_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
  cell.x = x; cell.y = y;
  core.bodyLayer.addChild(cell);

  // ── Left: framed item picture (square, capped so a tall cell doesn't crowd out the text
  // column to its right — see renderItemPicture for the real per-item art). ──
  const imgSize = Math.min(AUC_CELL_H - pad * 2, AUC_CELL_IMG_MAX);
  const imgX = x + pad; const imgY = y + (AUC_CELL_H - imgSize) / 2;
  // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind is already
  // the one background layer, this frame is a stroke-only outline.
  const frame = sketchPanel(imgSize, imgSize, { fill: 0xf0eee7, fillAlpha: 0, border: C.mid, seed: seedFor(x, y, imgSize) });
  frame.x = imgX; frame.y = imgY;
  core.bodyLayer.addChild(frame);
  renderItemPicture(core, auc, imgX + imgSize / 2, imgY + imgSize / 2, Math.round(imgSize * 0.62), seedFor(x, y, imgSize));

  // Sale-mode glyph badge, top-right corner of the frame (tag = buy-now, gavel = auction).
  const modeIcon = buildIcon(saleModeKind(isAuction ? 'auction' : 'fixed'), 22, isAuction ? C.red : C.mid);
  modeIcon.x = imgX + imgSize - 22; modeIcon.y = imgY;
  core.bodyLayer.addChild(modeIcon);

  // Designated-buyer badge: shown in "Market" when I'm the account this listing is exclusive to
  // (server already hides it from everyone else; this just distinguishes it from the open market).
  if (core.activeTab === 'all' && auc.designatedBuyerId && auc.designatedBuyerId === core.cb.myAccountId) {
    const badge = txt(t('auction.exclusive'), FS.tiny, C.light, true);
    badge.anchor.set(0, 0);
    const bx = x + pad; const by = y + pad;
    const bw = badge.width + 12; const bh = badge.height + 8;
    const badgeBg = sketchPanel(bw, bh, { fill: C.accent, border: C.accent, seed: seedFor(x, y, bw) });
    badgeBg.x = bx; badgeBg.y = by;
    core.bodyLayer.addChild(badgeBg);
    badge.x = bx + 6; badge.y = by + 4;
    core.bodyLayer.addChild(badge);
  }

  // ── Right: info column (name, price, buyout, countdown) ──
  const ax = imgX + imgSize + AUC_CELL_IMG_GAP;
  const rightW = aucInfoColumnW(cellW);

  const itemLbl = txt(auctionLabel(auc), FS.bodyLg, C.dark, true);
  itemLbl.x = ax; itemLbl.y = y + pad;
  itemLbl.style.wordWrap = true; itemLbl.style.wordWrapWidth = Math.max(20, rightW);
  core.bodyLayer.addChild(itemLbl);

  let ay = y + pad + Math.max(28, itemLbl.height + 8);

  // Equipment enhancement level / card level as a row of gold star icons beneath the name —
  // matches the EquipmentScene/CardScene bag-card treatment (buildLevelStars) instead of text
  // ("+N"/"Lv.N" — see 08.08.2026 report: the auction house still showed "Lv.3" text for cards
  // after equipment had already moved to stars).
  const itemLevel = Math.max(0, Math.min(auctionItemMaxLevel(auc), auctionItemLevel(auc)));
  if (itemLevel > 0) {
    const { container: stars } = buildLevelStars(itemLevel, rightW, 12, 2);
    stars.name = 'levelStars'; // test hook: one child per level star (mirrors CardScene's convention)
    stars.x = ax; stars.y = ay;
    core.bodyLayer.addChild(stars);
    ay += Math.max(20, stars.height + 6);
  }

  // Fixed-price: show the unit sale price; auction: the current bid (or the starting price when no bids
  // yet), except on a settled one where that bid is no longer "current" — it's what the item went for.
  // Closed auction rows were rare before My Bids became server-backed (My Listings only ever shows the
  // seller's own); now every won/lost row is one, and "current bid" on a finished sale reads wrong.
  const auctionPriceKey = auc.status === 'sold'
    ? 'auction.finalPrice'
    : auc.topBid ? 'auction.currentBid' : 'auction.startPrice';
  const priceText = isAuction
    ? `${t(auctionPriceKey)}: ${auc.price}`
    : `${t('auction.price')}: ${auc.price}`;
  const priceLbl = txt(priceText, FS.body, C.accent, true);
  priceLbl.x = ax; priceLbl.y = ay;
  priceLbl.style.wordWrap = true; priceLbl.style.wordWrapWidth = Math.max(20, rightW);
  core.bodyLayer.addChild(priceLbl);
  ay += Math.max(26, priceLbl.height + 8);

  // My Bids tab: my own bid, but only when it differs from the listing's current price — while I'm
  // leading the two are the same number and printing it twice reads as a rendering bug. When I've been
  // outbid (or lost) they diverge, and that gap is the whole point of the tab.
  //
  // ONE LINE in every locale, same contract as `auction.timeLeft` below and for the same reason: it
  // is the line that decides whether the countdown clears the badge. German's "Mein Gebot: 706500"
  // was 18 characters in a 15-character column, and the extra line it wrapped to pushed the
  // countdown down onto "Überboten" on every outbid row of the sweep (§55.2). `test/auctionCellInfoWidth.test.ts`
  // holds all three of these strings to the column; English is at 15 of 15, so there is no slack to
  // spend here.
  if (core.activeTab === 'bids') {
    const mine = core.myBidIndex.get(auc.auctionId);
    if (mine && mine.myBid !== auc.price) {
      const myLbl = txt(`${t('auction.myBid')}: ${mine.myBid}`, FS.tiny, C.mid);
      myLbl.x = ax; myLbl.y = ay;
      myLbl.style.wordWrap = true; myLbl.style.wordWrapWidth = Math.max(20, rightW);
      core.bodyLayer.addChild(myLbl);
      ay += Math.max(20, myLbl.height + 6);
    }
  }

  if (isAuction && auc.buyoutPrice) {
    const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), FS.tiny, C.mid);
    boLbl.x = ax; boLbl.y = ay;
    boLbl.style.wordWrap = true; boLbl.style.wordWrapWidth = Math.max(20, rightW);
    core.bodyLayer.addChild(boLbl);
    ay += Math.max(20, boLbl.height + 6);
  }

  // Countdown only makes sense for a live listing — closed history cells (sold/expired/cancelled) would
  // otherwise all read "0d 0h 0m 0s". Those show a status badge instead (My-Listings branch below).
  // Stacked right below the price/buyout block (not pinned to the card's bottom edge — that left a
  // dead gap and put it fighting the buy button for the same row, see 16.07.2026 "看起来太乱了" report)
  // and shown as days/hours/minutes/seconds since listings run up to 72h.
  //
  // `auction.timeLeft` MUST fit `rightW` on ONE line in every locale — 15 monospace characters at
  // a portrait phone's legibility floor, since `rightW` is 167 design px in the three-column grid.
  // This is the last line of the info column and the action button is pinned to the card's
  // bottom-right, so a second line lands ON that button: it is the only thing here the cell has no
  // room to absorb. Wrapping is therefore not an available answer and a long translation has to be
  // abbreviated instead — see the note on the German value (§50.12).
  //
  // The same is true one line up, which is what §55.2 cost: every line BELOW the two-line price
  // block spends the cell's last reserve of height, so `auction.myBid` and `auction.buyoutAt` carry
  // this contract too and `test/auctionCellInfoWidth.test.ts` is where all three are held to it.
  if (auc.status === 'open') {
    const remainingSec = Math.max(0, Math.floor((auc.expireAt - now) / 1000));
    const d = Math.floor(remainingSec / 86400);
    const h = Math.floor((remainingSec % 86400) / 3600);
    const m = Math.floor((remainingSec % 3600) / 60);
    const s = remainingSec % 60;
    const expLbl = txt(t('auction.timeLeft', { d, h, m, s }), FS.tiny, C.mid);
    expLbl.x = ax; expLbl.y = ay;
    expLbl.style.wordWrap = true; expLbl.style.wordWrapWidth = Math.max(20, rightW);
    core.bodyLayer.addChild(expLbl);
  }

  // ── Bottom-right: action button / status badge ──
  const btnW = 96; const btnH = 40;
  const btnX = x + cellW - pad - btnW; const btnY = y + AUC_CELL_H - pad - btnH;

  if (core.activeTab === 'all') {
    const aucId = auc.auctionId;
    // Own listings can surface in the market (e.g. a designated-buyer listing the seller is
    // allowed to see, see listAuctions). Self-purchase/self-bid is rejected server-side
    // (sellerId===buyerId → BAD_REQUEST), so show a passive marker instead of a dead Buy/Bid button.
    if (auc.sellerId === core.cb.myAccountId) {
      const ownLbl = txt(t('auction.yourListing'), FS.small, C.mid);
      ownLbl.anchor.set(1, 0.5); ownLbl.x = btnX + btnW; ownLbl.y = btnY + btnH / 2;
      core.bodyLayer.addChild(ownLbl);
    } else {
      const busy = core.bt.busy;
      const btn = busy
        ? sketchPanel(btnW, btnH, { fill: C.btnOff, border: C.mid, seed: seedFor(y, 0, btnW) })
        : sketchButton(btnW, btnH, seedFor(y, 0, btnW));
      btn.x = btnX; btn.y = btnY;
      core.bodyLayer.addChild(btn);
      drawButtonLabel(core.bodyLayer, btnX, btnY, btnW, btnH,
        isAuction ? t('auction.bid') : t('auction.buy'), isAuction ? 'bidTabIcon' : 'coin',
        busy ? C.mid : C.light, FS.small, { bold: false });
      if (!busy) {
        core.hitRects.push({
          rect: { x: btnX, y: btnY, w: btnW, h: btnH },
          fn: isAuction ? () => actions.bid.openBidForm(auc) : () => actions.trade.confirmBuy(aucId, auc.price),
        });
      }
    }
  } else if (core.activeTab === 'mine') {
    if (auc.status === 'open') {
      // Live listing → cancel action.
      const busy = core.bt.busy;
      const cancelColor = busy ? C.mid : C.red;
      const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xf0e0e0, border: cancelColor, seed: seedFor(y, 1, btnW) });
      cancelBtn.x = btnX; cancelBtn.y = btnY;
      core.bodyLayer.addChild(cancelBtn);
      const cl = txt(t('auction.cancel'), FS.small, cancelColor);
      cl.anchor.set(0.5, 0.5); cl.x = btnX + btnW / 2; cl.y = btnY + btnH / 2;
      core.bodyLayer.addChild(cl);
      const aucId = auc.auctionId;
      if (!busy) core.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => actions.trade.confirmCancel(aucId) });
    } else {
      // Closed history cell → status badge (sold = accent, expired/cancelled = muted), no action.
      const statusKey = auc.status === 'sold'
        ? 'auction.statusSold'
        : auc.status === 'cancelled'
          ? 'auction.statusCancelled'
          : 'auction.statusExpired';
      const badge = txt(t(statusKey), FS.small, auc.status === 'sold' ? C.accent : C.mid, true);
      badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
      core.bodyLayer.addChild(badge);
    }
  } else {
    // My Bids: informational only (I'm a bidder, not the owner) — no action button, just an outcome
    // badge. Accent for the two states where the item is still mine or still winnable, muted for the
    // two where it isn't.
    const mine = core.myBidIndex.get(auc.auctionId);
    const outcome = mine?.outcome ?? 'leading';
    const badgeKeys = {
      leading: 'auction.leading', outbid: 'auction.outbid', won: 'auction.bidWon', lost: 'auction.bidLost',
    } as const;
    const badge = txt(t(badgeKeys[outcome]), FS.small, outcome === 'leading' || outcome === 'won' ? C.accent : C.mid, true);
    badge.anchor.set(1, 0.5); badge.x = x + cellW - pad; badge.y = btnY + btnH / 2;
    core.bodyLayer.addChild(badge);
  }
}

/**
 * Real per-item picture for a market cell (mirrors GachaScene.drawEntryPicture): equipment gets
 * its per-slot/rarity procedural glyph, cards get the real unit art PNG, materials keep their
 * dedicated icon glyph. Centered at (cx, cy) in a `size`×`size` box.
 */
function renderItemPicture(
  core: AuctionSceneCore, auc: AuctionView, cx: number, cy: number, size: number, seed: number,
): void {
  if (auc.itemType === 'equipment') {
    const inst = auc.item?.['instance'] as EquipmentInstance | undefined;
    const def = inst ? getEquipDef(inst.defId) : undefined;
    if (def) {
      const icon = buildEquipIcon(inst?.defId, def.slot, def.rarity, size, seed);
      icon.x = cx; icon.y = cy;
      core.bodyLayer.addChild(icon);
      return;
    }
  } else if (auc.itemType === 'card') {
    const inst = auc.item?.['instance'] as CardInstance | undefined;
    const artUrl = inst ? cardInstanceArtUrl(inst) ?? undefined : undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        core.bodyLayer.addChild(sp);
        return;
      }
      if (!core.artHooked.has(artUrl)) {
        core.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => core.render());
      }
    }
  } else if (auc.itemType === 'skin') {
    const skinId = auc.item?.['skinId'] as string | undefined;
    const unitType = skinId ? SKIN_TARGET_UNIT[skinId] : undefined;
    const artUrl = unitType && skinId ? unitPortraitUrl(unitType, skinId) ?? undefined : undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        core.bodyLayer.addChild(sp);
        return;
      }
      if (!core.artHooked.has(artUrl)) {
        core.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => core.render());
      }
    }
  }
  // Material listing (or an equipment/card def that vanished) → dedicated icon (bitmap-first,
  // mirrors every other material-icon site — EquipmentScene/GachaScene/DailyScene/etc, see
  // materialAtlas.ts's "every material-icon site MUST go through here" contract).
  const kind = itemKind(auc.itemType, auc.item?.['material'] as string | undefined);
  const icon = kind === 'scrap' || kind === 'lead' || kind === 'binding'
    ? buildMaterialIcon(kind as MaterialKind, size, C.dark)
    : buildIcon(kind, size, C.dark);
  icon.x = cx - size / 2; icon.y = cy - size / 2;
  core.bodyLayer.addChild(icon);
}
