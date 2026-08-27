// Market list tab: left sidebar (Market/My Auctions/My Bids), the category filter bar, the auction row list,
// and the bottom "create listing" button.
// Converted from ListMixin(Base) to composition (2026-08-11) — see core.ts's file-header comment.
// Depends one-directionally on Bid/TradeActions/CreateListing (row actions open their flows; none of
// those three ever call back into List) via the narrow interfaces below, mirroring
// DefenseEditorScene/render.ts's `saveActions: SaveActionsHandlers` pattern.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { t } from '../../i18n';
import type { AuctionView } from '../../net/WorldApiClient';
import type { EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildLevelStars } from '../../render/levelStars';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { serverNow } from '../../net/serverClock';
import { cardInstanceArtUrl, getArtTexture, unitPortraitUrl } from '../../render/cardArt';
import { SKIN_TARGET_UNIT } from '../../game/meta/skinDefs';
import { FILTER_H, AUC_CELL_GAP, AUC_CELL_H, AUC_CELL_W_TARGET, FILTERS, type AucFilter, type AucTab } from './types';
import type { AuctionSceneCore } from './core';
import { itemKind, saleModeKind, auctionLabel, auctionItemLevel, auctionItemMaxLevel } from './itemLabels';

/** Narrow slice of BidPanel that List's row actions need — opening the bid modal for an auction-mode listing. */
export interface BidOpener {
  openBidForm(auc: AuctionView): void;
}

/** Narrow slice of TradeActionsPanel that List's row actions need — confirm-then-buy/cancel. */
export interface TradeOpener {
  confirmBuy(auctionId: string, price: number): void;
  confirmCancel(auctionId: string): void;
}

/** Narrow slice of CreateListingPanel that List's "+ List Item" button needs. */
export interface CreateFormOpener {
  openCreateForm(): void;
}

// card/skin filter chips → rosterIcon/skinIcon (AI art pilot batch 2, design/product/tab-icon-art-prompts.md
// §batch2): same "卡"/"皮肤" concept the [Cards|Equipment|Skins] peer tabs already draw with dedicated AI
// art. itemKind() itself stays generic 'cards'/'brush' — it also feeds the per-row item-type badge and
// the create-listing content badge (different render context, not part of this tab-icon batch).
const FILTER_ICON_OVERRIDE: Partial<Record<AucFilter, IconKind>> = { card: 'rosterIcon', skin: 'skinIcon' };

export class ListPanel {
  constructor(
    private readonly core: AuctionSceneCore,
    private readonly bid: BidOpener,
    private readonly trade: TradeOpener,
    private readonly createListing: CreateFormOpener,
  ) {}

  /**
   * Listings for the "My Bids" tab: every auction I have bid on, in the order the server ranked them
   * (live first, soonest to end first; then closed history newest-first).
   *
   * Was a client-side filter over `allAuctions` on `topBid.bidderId === myAccountId`, which could only
   * ever surface listings I was LEADING — being outbid made the listing disappear from the tab entirely,
   * exactly when the player most needs to see it. Now server data (GET /auction/myBids, backed by bid
   * records), so being outbid, winning and losing are all still listed; the per-cell badge below reads
   * `core.myBidIndex` for which of those it is.
   */
  myBids(): AuctionView[] {
    return this.core.myBids.map((b) => b.auction);
  }

  /**
   * Market / My Auctions / My Bids. Landscape: a left nav rail (`sidebarNavW`, matching every
   * other hub's left tab rail) below the header — returns its width so body content (filter bar /
   * list / create button) starts clear of it. Portrait: a bottom nav bar instead (§18) — returns
   * 0 (no width reservation); the list/create-button height math reserves `bottomNavH` off the
   * bottom instead (see renderList/renderCreateButton).
   */
  renderSidebar(): number {
    const core = this.core;
    const { w, h, landscape } = core;
    const tabs: AucTab[] = ['all', 'mine', 'bids'];
    const labelKeys: Record<AucTab, 'auction.tabAll' | 'auction.tabMine' | 'auction.tabBids'> = {
      all: 'auction.tabAll', mine: 'auction.tabMine', bids: 'auction.tabBids',
    };
    // 'mine' keeps the generic 'cards' glyph deliberately (AI art pilot batch 2 judged this NOT the
    // same "卡" concept as rosterIcon — "My Auctions" covers cards/equipment/materials/skins alike, not
    // specifically cards; see design/product/tab-icon-art-prompts.md §batch2 for the reasoning).
    // 'all' → shopTabIcon (AI art batch 3, pure reuse): same literal "price tag" concept as the shop-group
    // hub's own tab, reused here rather than minting a second price-tag icon. 'bids' → bidTabIcon (AI
    // art batch 3, new concept: auction gavel), a pure recognizability upgrade — no reuse conflict on
    // 'hammer' itself (elsewhere it's only ever the equipment-enhance action button).
    const icons: Record<AucTab, IconKind> = { all: 'shopTabIcon', mine: 'cards', bids: 'bidTabIcon' };
    const hubTabs: HubTab[] = tabs.map((tab) => ({ label: t(labelKeys[tab]), active: tab === core.activeTab, icon: icons[tab] }));
    const onSelect = (i: number): void => {
      const tab = tabs[i]!;
      if (core.activeTab !== tab) { core.activeTab = tab; core.scrollY = 0; core.render(); }
    };
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, hubTabs, onSelect);
      for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
      return 0;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(core.bodyLayer, sidebarW, core.headerH, h, hubTabs, onSelect);
    for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
    return sidebarW;
  }

  renderFilterBar(contentX: number): number {
    const core = this.core;
    const { w } = core;
    const y = core.headerH;
    const contentW = w - contentX;
    const chipW = contentW / FILTERS.length;
    const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterMaterial' | 'auction.filterEquipment' | 'auction.filterCard' | 'auction.filterSkin'> = {
      '': 'auction.filterAll', material: 'auction.filterMaterial', equipment: 'auction.filterEquipment', card: 'auction.filterCard', skin: 'auction.filterSkin',
    };
    // 1.5x the original chip metrics (padding/icon/font) — approved 15.07.2026 category-bar
    // enlargement pass. Chip width itself is unchanged (still contentW / FILTERS.length), so the
    // label is measured and scaled down if it would otherwise overflow the chip (see maxLblW below).
    const pad = 9;
    const iconSize = 30;
    const fontSize = FS.bodyLg;
    for (let i = 0; i < FILTERS.length; i++) {
      const f = FILTERS[i]!;
      const active = f === core.allFilter;
      const chip = sketchPanel(chipW - pad, FILTER_H - 12, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 3, chipW) });
      chip.x = contentX + i * chipW + pad / 2; chip.y = y + 3;
      core.bodyLayer.addChild(chip);
      const midY = y + 3 + (FILTER_H - 12) / 2;
      const hasIcon = f !== '';
      const iconGap = hasIcon ? iconSize + 8 : 0;
      // Category glyph prefix (the 'all' filter stays text-only).
      if (hasIcon) {
        const fi = buildIcon(FILTER_ICON_OVERRIDE[f] ?? itemKind(f), iconSize, active ? C.light : C.dark);
        fi.x = contentX + i * chipW + pad / 2 + 12; fi.y = midY - iconSize / 2;
        core.bodyLayer.addChild(fi);
      }
      const lbl = txt(t(keys[f]), fontSize, active ? C.light : C.dark);
      const maxLblW = chipW - pad - 20 - iconGap;
      if (lbl.width > maxLblW) lbl.scale.set(Math.max(0.5, maxLblW / lbl.width));
      lbl.anchor.set(0.5, 0.5);
      lbl.x = contentX + i * chipW + pad / 2 + 12 + iconGap + maxLblW / 2;
      lbl.y = midY;
      core.bodyLayer.addChild(lbl);
      core.hitRects.push({
        rect: { x: contentX + i * chipW + pad / 2, y: y + 3, w: chipW - pad, h: FILTER_H - 12 },
        action: () => { if (core.allFilter !== f) { core.allFilter = f; core.scrollY = 0; void core.loadData(); } },
      });
    }
    return FILTER_H;
  }

  renderList(auctions: AuctionView[], contentX: number, filterH = 0): void {
    const core = this.core;
    const { w, h } = core;
    const listY = core.headerH + filterH;
    const createBtnH = 100; // reserves room for the 2x "+ List Item" button below
    // Portrait's tab nav is a bottom bar instead of a left rail (§18) — reserve bottomNavH off the
    // bottom, below the create button (which itself shifts up by the same amount).
    const availH = h - listY - createBtnH - 10 - (core.landscape ? 0 : bottomNavH(h));
    const contentW = w - contentX;
    const emptyKeys: Record<AucTab, 'auction.empty' | 'auction.myEmpty' | 'auction.bidsEmpty'> = {
      all: 'auction.empty', mine: 'auction.myEmpty', bids: 'auction.bidsEmpty',
    };
    // Default to "nothing to scroll" — overwritten below once the real grid geometry is known;
    // covers the loading/empty early-returns so a stale wheel event can't scroll a hidden list.
    core.scrollMax = 0;

    if (core.loading) {
      const lbl = txt(t('world.loading'), FS.small, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      return;
    }

    if (auctions.length === 0) {
      const lbl = txt(t(emptyKeys[core.activeTab]), FS.small, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = contentX + contentW / 2; lbl.y = listY + availH / 2;
      core.bodyLayer.addChild(lbl);
      return;
    }

    // Card grid (mirrors CardScene's roster grid): as many columns as fit AUC_CELL_W_TARGET, wrapping rows.
    const left = contentX + AUC_CELL_GAP;
    const avail = contentW - AUC_CELL_GAP * 2;
    const cols = Math.max(1, Math.floor((avail + AUC_CELL_GAP) / (AUC_CELL_W_TARGET + AUC_CELL_GAP)));
    const cellW = (avail - AUC_CELL_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(auctions.length / cols);
    const totalH = rows * (AUC_CELL_H + AUC_CELL_GAP) + AUC_CELL_GAP;
    // No PIXI mask backs this grid (draw-cull only, below) — a row is either drawn in full or
    // skipped entirely, never cropped, so peekViewportH's mid-row shrink would just exclude a
    // row that fits fine and leave a dead gap (2026-07-23 correction, UI_DESIGN.md §25). Use the
    // naive availH directly (also the wheel-scroll viewport bounds, see wheelScroll.ts).
    core.scrollMax = Math.max(0, totalH - availH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, core.scrollMax));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + availH;

    const now = serverNow();
    auctions.forEach((auc, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + AUC_CELL_GAP);
      const y = listY + AUC_CELL_GAP + row * (AUC_CELL_H + AUC_CELL_GAP) - core.scrollY;
      if (y + AUC_CELL_H >= listY && y <= listY + availH) {
        this.renderAuctionCell(auc, x, y, cellW, now);
      }
    });

    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: availH }, core.scrollY, Math.max(0, totalH - availH));
  }

  /**
   * Auction card cell: a framed item-class glyph on the left (CardScene roster-card treatment),
   * with name/price/status stacked to its right and the row action pinned bottom-right.
   */
  renderAuctionCell(auc: AuctionView, x: number, y: number, cellW: number, now: number): void {
    const core = this.core;
    const pad = 14;
    const isAuction = auc.saleMode === 'auction';

    const cell = sketchPanel(cellW, AUC_CELL_H, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    core.bodyLayer.addChild(cell);

    // ── Left: framed item picture (square, capped so a tall cell doesn't crowd out the text
    // column to its right — see renderItemPicture for the real per-item art). ──
    const imgSize = Math.min(AUC_CELL_H - pad * 2, 130);
    const imgX = x + pad; const imgY = y + (AUC_CELL_H - imgSize) / 2;
    // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind is already
    // the one background layer, this frame is a stroke-only outline.
    const frame = sketchPanel(imgSize, imgSize, { fill: 0xf0eee7, fillAlpha: 0, border: C.mid, seed: seedFor(x, y, imgSize) });
    frame.x = imgX; frame.y = imgY;
    core.bodyLayer.addChild(frame);
    this.renderItemPicture(auc, imgX + imgSize / 2, imgY + imgSize / 2, Math.round(imgSize * 0.62), seedFor(x, y, imgSize));

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
    const ax = imgX + imgSize + 16;
    const rightW = x + cellW - pad - ax;

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
        const bl = txt(isAuction ? t('auction.bid') : t('auction.buy'), FS.small, busy ? C.mid : C.light);
        bl.anchor.set(0.5, 0.5); bl.x = btnX + btnW / 2; bl.y = btnY + btnH / 2;
        core.bodyLayer.addChild(bl);
        if (!busy) {
          core.hitRects.push({
            rect: { x: btnX, y: btnY, w: btnW, h: btnH },
            action: isAuction ? () => this.bid.openBidForm(auc) : () => this.trade.confirmBuy(aucId, auc.price),
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
        if (!busy) core.hitRects.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, action: () => this.trade.confirmCancel(aucId) });
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
  private renderItemPicture(auc: AuctionView, cx: number, cy: number, size: number, seed: number): void {
    const core = this.core;
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

  renderCreateButton(contentX: number): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const contentW = w - contentX;
    // 2x the previous 200x44 button.
    const btnW = 400; const btnH = 88;
    // Portrait's tab nav is a bottom bar (§18) — this button sits just above it instead of at the
    // screen edge.
    const btnY = h - btnH - 12 - (landscape ? 0 : bottomNavH(h));
    const btn = sketchButton(btnW, btnH, seedFor(0, 0, btnW));
    btn.x = contentX + contentW / 2 - btnW / 2; btn.y = btnY;
    core.bodyLayer.addChild(btn);
    const bl = txt(`+ ${t('auction.create')}`, FS.title, C.light);
    bl.anchor.set(0.5, 0.5); bl.x = contentX + contentW / 2; bl.y = btnY + btnH / 2;
    core.bodyLayer.addChild(bl);
    core.hitRects.push({ rect: { x: contentX + contentW / 2 - btnW / 2, y: btnY, w: btnW, h: btnH }, action: () => this.createListing.openCreateForm() });
  }
}
