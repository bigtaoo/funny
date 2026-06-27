// AuctionScene — SLG 拍卖场景（S8-5）
// 两个 Tab：所有拍卖 / 我的挂单；底部操作：挂拍 / 购买 / 取消

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import type { WorldApiClient, AuctionView } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';

export interface AuctionSceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
}

type AucTab = 'all' | 'mine';

const ROW_H = 56;
const HUD_H = 50;
const TAB_H = 36;
const FILTER_H = 34;

// Material types available for auction
const MATERIALS = ['scrap', 'lead', 'binding'] as const;
// 须与服务端 AUCTION_DURATIONS_SEC（shared/slg.ts）一致，否则 createAuction 抛 BAD_REQUEST。
const DURATIONS = [21600, 43200, 86400] as const; // 6h, 12h, 24h
// Category filter for the market tab — matches AuctionView.itemType ('' = no filter).
const FILTERS = ['', 'material', 'equipment'] as const;
type AucFilter = typeof FILTERS[number];

export class AuctionScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: AuctionSceneCallbacks;

  private activeTab: AucTab = 'all';
  private allFilter: AucFilter = '';
  private allAuctions: AuctionView[] = [];
  private myListings: AuctionView[] = [];
  private loading = true;
  private hiddenInput: HTMLInputElement | null = null;

  private bodyLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;

  // Create form state
  private createMaterial: typeof MATERIALS[number] = 'scrap';
  private createSaleMode: 'fixed' | 'auction' = 'fixed';
  private createQty = 1;
  private createPrice = 10;        // fixed buy-now unit price
  private createStartPrice = 10;   // auction starting unit price
  private createBuyoutPrice = 0;   // auction buyout (0 = none)
  private createDuration: typeof DURATIONS[number] = 21600;
  private createBuyer = '';
  private createOpen = false;

  // Bid form state (auction listings)
  private bidAuction: AuctionView | null = null;
  private bidAmount = 0;

  // Scroll
  private scrollY = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;

  // Hit rects
  private hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalOpen = false;

  // Toast
  private toastTimer = 0;
  private destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: AuctionSceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
  }

  private build(): void {
    const { w, h } = this;
    const bg = buildPaperBackground('auction', w, h);
    this.container.addChild(bg);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    // Static header
    const hdr = drawSceneHeader(this.container, w, this.h, t('auction.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 15,
    });
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    if (this.destroyed) return;
    this.loading = true;
    this.render();
    try {
      const [all, mine] = await Promise.all([
        this.cb.worldApi.listAuctions(this.cb.worldId, this.allFilter ? { itemType: this.allFilter } : undefined),
        this.cb.worldApi.getMyListings(this.cb.worldId),
      ]);
      this.allAuctions = all;
      this.myListings = mine;
    } catch { /* offline */ }
    this.loading = false;
    if (!this.destroyed) this.render();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer);
    // Keep static header; only rebuild body hits (not back button)
    this.hitRects = [];
    this.hitRects.push({ rect: { x: 0, y: 0, w: 80, h: HUD_H }, action: () => this.cb.onBack() });

    this.renderTabs();
    const filterH = this.activeTab === 'all' ? this.renderFilterBar() : 0;
    const list = this.activeTab === 'all' ? this.allAuctions : this.myListings;
    this.renderList(list, filterH);
    this.renderCreateButton();
  }

  private renderFilterBar(): number {
    const { w } = this;
    const y = HUD_H + TAB_H;
    const chipW = w / FILTERS.length;
    const keys: Record<AucFilter, 'auction.filterAll' | 'auction.filterMaterial' | 'auction.filterEquipment'> = {
      '': 'auction.filterAll', material: 'auction.filterMaterial', equipment: 'auction.filterEquipment',
    };
    for (let i = 0; i < FILTERS.length; i++) {
      const f = FILTERS[i]!;
      const active = f === this.allFilter;
      const chip = sketchPanel(chipW - 6, FILTER_H - 8, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 3, chipW) });
      chip.x = i * chipW + 3; chip.y = y + 2;
      this.bodyLayer.addChild(chip);
      const lbl = txt(t(keys[f]), 11, active ? C.light : C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = i * chipW + chipW / 2; lbl.y = y + 2 + (FILTER_H - 8) / 2;
      this.bodyLayer.addChild(lbl);
      this.hitRects.push({
        rect: { x: i * chipW + 3, y: y + 2, w: chipW - 6, h: FILTER_H - 8 },
        action: () => { if (this.allFilter !== f) { this.allFilter = f; this.scrollY = 0; void this.loadData(); } },
      });
    }
    return FILTER_H;
  }

  private renderTabs(): void {
    const { w } = this;
    const tabs: AucTab[] = ['all', 'mine'];
    const tw = w / tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]!;
      const active = tab === this.activeTab;
      const tp = sketchPanel(tw, TAB_H, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tw) });
      tp.x = i * tw; tp.y = HUD_H;
      this.bodyLayer.addChild(tp);
      const tl = txt(t(tab === 'all' ? 'auction.tabAll' : 'auction.tabMine'), 13, active ? C.accent : C.dark);
      tl.anchor.set(0.5, 0.5); tl.x = i * tw + tw / 2; tl.y = HUD_H + TAB_H / 2;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: i * tw, y: HUD_H, w: tw, h: TAB_H }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
    }
  }

  private renderList(auctions: AuctionView[], filterH = 0): void {
    const { w, h } = this;
    const listY = HUD_H + TAB_H + filterH;
    const createBtnH = 44;
    const listH = h - listY - createBtnH - 10;

    if (this.loading) {
      const lbl = txt(t('world.loading'), 13, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    if (auctions.length === 0) {
      const lbl = txt(t(this.activeTab === 'all' ? 'auction.empty' : 'auction.myEmpty'), 13, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + listH / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    const totalH = auctions.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - listH)));

    const now = Date.now();
    let cy = listY - this.scrollY;
    for (const auc of auctions) {
      if (cy + ROW_H < listY || cy > listY + listH) { cy += ROW_H; continue; }

      const row = sketchPanel(w - 12, ROW_H - 4, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, w) });
      row.x = 6; row.y = cy;
      this.bodyLayer.addChild(row);

      const isAuction = auc.saleMode === 'auction';

      // 材料名在 item.material（itemType 恒为 'material'/'equipment'）；装备暂无 material 字段时回退 itemType。
      const matKey = (auc.item?.['material'] as string | undefined) ?? auc.itemType;
      const itemLbl = txt(`${t(`auction.${matKey as 'scrap' | 'lead' | 'binding'}`)} ×${auc.qty}`, 13, C.dark);
      itemLbl.x = 14; itemLbl.y = cy + 6;
      this.bodyLayer.addChild(itemLbl);

      if (isAuction) {
        const tag = txt(`[${t('auction.auctionTag')}]`, 10, C.red);
        tag.x = itemLbl.x + itemLbl.width + 6; tag.y = cy + 8;
        this.bodyLayer.addChild(tag);
      }

      // 一口价：显示成交单价；竞拍：显示当前出价（无人出价则起拍价）。
      const priceText = isAuction
        ? `${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`
        : `${t('auction.price')}: ${auc.price}`;
      const priceLbl = txt(priceText, 12, C.accent);
      priceLbl.x = 14; priceLbl.y = cy + 24;
      this.bodyLayer.addChild(priceLbl);

      if (isAuction && auc.buyoutPrice) {
        const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), 10, C.mid);
        boLbl.x = 14; boLbl.y = cy + 40;
        this.bodyLayer.addChild(boLbl);
      }

      const remaining = Math.max(0, Math.ceil((auc.expireAt - now) / 60000));
      const expLbl = txt(`${remaining}m`, 11, C.mid);
      expLbl.x = w - 70; expLbl.y = cy + 6;
      this.bodyLayer.addChild(expLbl);

      if (this.activeTab === 'all') {
        const aucId = auc.auctionId;
        const btn = sketchPanel(54, 26, { fill: C.dark, border: C.accent, seed: seedFor(cy, 0, 54) });
        btn.x = w - 62; btn.y = cy + 14;
        this.bodyLayer.addChild(btn);
        const bl = txt(isAuction ? t('auction.bid') : t('auction.buy'), 12, C.light);
        bl.anchor.set(0.5, 0.5); bl.x = w - 35; bl.y = cy + 27;
        this.bodyLayer.addChild(bl);
        this.hitRects.push({
          rect: { x: w - 62, y: cy + 14, w: 54, h: 26 },
          action: isAuction ? () => this.openBidForm(auc) : () => this.confirmBuy(aucId, auc.price),
        });
      } else {
        const cancelBtn = sketchPanel(54, 26, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 1, 54) });
        cancelBtn.x = w - 62; cancelBtn.y = cy + 14;
        this.bodyLayer.addChild(cancelBtn);
        const cl = txt(t('auction.cancel'), 12, C.red);
        cl.anchor.set(0.5, 0.5); cl.x = w - 35; cl.y = cy + 27;
        this.bodyLayer.addChild(cl);
        const aucId = auc.auctionId;
        this.hitRects.push({ rect: { x: w - 62, y: cy + 14, w: 54, h: 26 }, action: () => this.confirmCancel(aucId) });
      }

      cy += ROW_H;
    }
  }

  private renderCreateButton(): void {
    const { w, h } = this;
    const btnY = h - 48;
    const btn = sketchPanel(160, 36, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 160) });
    btn.x = w / 2 - 80; btn.y = btnY;
    this.bodyLayer.addChild(btn);
    const bl = txt(`+ ${t('auction.create')}`, 13, C.light);
    bl.anchor.set(0.5, 0.5); bl.x = w / 2; bl.y = btnY + 18;
    this.bodyLayer.addChild(bl);
    this.hitRects.push({ rect: { x: w / 2 - 80, y: btnY, w: 160, h: 36 }, action: () => this.openCreateForm() });
  }

  // ── Create form (modal) ────────────────────────────────────────────────────

  private openCreateForm(): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const auctionMode = this.createSaleMode === 'auction';
    const ROW = 40;
    const mw = Math.min(320, w - 24);
    const priceRowsH = auctionMode ? ROW * 2 : ROW; // auction: startPrice + buyout
    // item + saleMode + qty + price(s) + duration + buyer(label+field=52) + info(24) + buttons(44) + pads(22)
    const mh = 14 + ROW * 4 + priceRowsH + 52 + 24 + 44 + 8;
    const mx = (w - mw) / 2;
    const my = Math.max(HUD_H + 4, (h - mh) / 2);

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let cy = my + 14;

    // Item type selector (materials only for now; equipment listing is E5)
    const tl0 = txt(t('auction.item') + ':', 12, C.dark);
    tl0.x = mx + 10; tl0.y = cy;
    ml.addChild(tl0);
    let bx = mx + 10 + tl0.width + 8;
    for (const mat of MATERIALS) {
      const active = mat === this.createMaterial;
      const matIdx = MATERIALS.indexOf(mat);
      const btn = sketchPanel(60, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(matIdx, 0, 60) });
      btn.x = bx; btn.y = cy - 2;
      ml.addChild(btn);
      const bl = txt(t(`auction.${mat}` as 'auction.scrap' | 'auction.lead' | 'auction.binding'), 11, active ? C.light : C.dark);
      bl.anchor.set(0.5, 0.5); bl.x = bx + 30; bl.y = cy + 10;
      ml.addChild(bl);
      const m = mat;
      this.modalHits.push({ rect: { x: bx, y: cy - 2, w: 60, h: 24 }, action: () => { this.createMaterial = m; this.openCreateForm(); } });
      bx += 64;
    }
    cy += ROW;

    // Sale mode toggle (fixed buy-now / auction)
    const sm0 = txt(t('auction.saleMode') + ':', 12, C.dark);
    sm0.x = mx + 10; sm0.y = cy;
    ml.addChild(sm0);
    let sx = mx + 10 + sm0.width + 8;
    const modes: { key: 'fixed' | 'auction'; label: string }[] = [
      { key: 'fixed', label: t('auction.saleFixed') },
      { key: 'auction', label: t('auction.saleAuction') },
    ];
    for (let i = 0; i < modes.length; i++) {
      const md = modes[i]!;
      const active = md.key === this.createSaleMode;
      const btn = sketchPanel(72, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(i, 5, 72) });
      btn.x = sx; btn.y = cy - 2;
      ml.addChild(btn);
      const bl = txt(md.label, 11, active ? C.light : C.dark);
      bl.anchor.set(0.5, 0.5); bl.x = sx + 36; bl.y = cy + 10;
      ml.addChild(bl);
      this.modalHits.push({ rect: { x: sx, y: cy - 2, w: 72, h: 24 }, action: () => { this.createSaleMode = md.key; this.openCreateForm(); } });
      sx += 76;
    }
    cy += ROW;

    // Qty
    this.addNumInput(ml, mx, cy, t('auction.qty') + ':', this.createQty, (v) => { this.createQty = Math.max(1, v); this.openCreateForm(); });
    cy += ROW;

    // Price(s) — fixed: single buy-now price; auction: startPrice + optional buyout
    if (auctionMode) {
      this.addNumInput(ml, mx, cy, t('auction.startPrice') + ':', this.createStartPrice, (v) => { this.createStartPrice = Math.max(1, v); this.openCreateForm(); });
      cy += ROW;
      this.addNumInput(ml, mx, cy, t('auction.buyout') + ':', this.createBuyoutPrice, (v) => { this.createBuyoutPrice = Math.max(0, v); this.openCreateForm(); });
      cy += ROW;
    } else {
      this.addNumInput(ml, mx, cy, t('auction.price') + ':', this.createPrice, (v) => { this.createPrice = Math.max(1, v); this.openCreateForm(); });
      cy += ROW;
    }

    // Duration
    const dl0 = txt(t('auction.duration') + ':', 12, C.dark);
    dl0.x = mx + 10; dl0.y = cy;
    ml.addChild(dl0);
    const durKeys: Record<typeof DURATIONS[number], 'auction.dur6h' | 'auction.dur12h' | 'auction.dur24h'> = { 21600: 'auction.dur6h', 43200: 'auction.dur12h', 86400: 'auction.dur24h' };
    let dx = mx + 10 + dl0.width + 8;
    for (const dur of DURATIONS) {
      const active = dur === this.createDuration;
      const btn = sketchPanel(52, 24, { fill: active ? C.dark : 0xeeeeee, border: active ? C.accent : C.mid, seed: seedFor(dur, 0, 52) });
      btn.x = dx; btn.y = cy - 2;
      ml.addChild(btn);
      const bl = txt(t(durKeys[dur]), 10, active ? C.light : C.dark);
      bl.anchor.set(0.5, 0.5); bl.x = dx + 26; bl.y = cy + 10;
      ml.addChild(bl);
      const d = dur as typeof DURATIONS[number];
      this.modalHits.push({ rect: { x: dx, y: cy - 2, w: 52, h: 24 }, action: () => { this.createDuration = d; this.openCreateForm(); } });
      dx += 56;
    }
    cy += ROW;

    // Designated buyer (optional) — private sale to a specific account.
    const bl0 = txt(t('auction.buyer') + ':', 11, C.dark);
    bl0.x = mx + 10; bl0.y = cy;
    ml.addChild(bl0);
    const buyerField = sketchPanel(mw - 20, 26, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 20) });
    buyerField.x = mx + 10; buyerField.y = cy + 16;
    ml.addChild(buyerField);
    const bfl = txt(this.createBuyer || t('auction.buyerPlaceholder'), 11, this.createBuyer ? C.dark : C.mid);
    bfl.x = mx + 16; bfl.y = cy + 23;
    ml.addChild(bfl);
    this.modalHits.push({ rect: { x: mx + 10, y: cy + 16, w: mw - 20, h: 26 }, action: () => this.openBuyerInput() });
    cy += 52;

    // Tax info — estimate seller proceeds at the floor price (start/buy-now).
    const refPrice = auctionMode ? this.createStartPrice : this.createPrice;
    const youGet = refPrice - Math.floor(refPrice * 0.1);
    const taxLbl = txt(`${t('auction.youGet')}: ${youGet}`, 11, C.mid);
    taxLbl.x = mx + 10; taxLbl.y = cy;
    ml.addChild(taxLbl);
    cy += 24;

    // OK / Cancel
    const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 80) });
    okBtn.x = mx + mw / 2 - 88; okBtn.y = cy;
    ml.addChild(okBtn);
    const ol = txt(t('auction.create'), 12, C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = cy + 14;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: () => void this.doCreate() });

    const caBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 1, 80) });
    caBtn.x = mx + mw / 2 + 8; caBtn.y = cy;
    ml.addChild(caBtn);
    const cl = txt('✕', 12, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = mx + mw / 2 + 48; cl.y = cy + 14;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  private addNumInput(
    layer: PIXI.Container,
    mx: number, y: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
  ): void {
    const lbl = txt(label, 12, C.dark);
    lbl.x = mx + 10; lbl.y = y;
    layer.addChild(lbl);

    const minusBtn = sketchPanel(24, 24, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 0, 24) });
    minusBtn.x = mx + 10 + lbl.width + 8; minusBtn.y = y - 2;
    layer.addChild(minusBtn);
    const ml = txt('−', 14, C.dark);
    ml.anchor.set(0.5, 0.5); ml.x = minusBtn.x + 12; ml.y = y + 10;
    layer.addChild(ml);
    this.modalHits.push({ rect: { x: minusBtn.x, y: minusBtn.y, w: 24, h: 24 }, action: () => onChange(value - 1) });

    const valLbl = txt(String(value), 13, C.dark);
    valLbl.anchor.set(0, 0.5);
    valLbl.x = minusBtn.x + 28; valLbl.y = y + 10;
    layer.addChild(valLbl);

    const plusBtn = sketchPanel(24, 24, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, 24) });
    plusBtn.x = minusBtn.x + 28 + valLbl.width + 8; plusBtn.y = y - 2;
    layer.addChild(plusBtn);
    const pl = txt('+', 14, C.dark);
    pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + 12; pl.y = y + 10;
    layer.addChild(pl);
    this.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: 24, h: 24 }, action: () => onChange(value + 1) });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private openBuyerInput(): void {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = this.createBuyer;
    inp.maxLength = 64;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('input', () => { this.createBuyer = inp.value.trim(); });
    inp.addEventListener('blur', () => {
      document.body.removeChild(inp);
      if (this.hiddenInput === inp) this.hiddenInput = null;
      if (!this.destroyed && this.modalOpen) this.openCreateForm();
    });
    this.hiddenInput = inp;
  }

  private async doCreate(): Promise<void> {
    const buyer = this.createBuyer.trim();
    const auctionMode = this.createSaleMode === 'auction';
    this.closeModal();
    try {
      await this.cb.worldApi.createAuction(
        this.cb.worldId, 'material', { material: this.createMaterial },
        this.createQty, this.createDuration,
        auctionMode
          ? {
              saleMode: 'auction',
              startPrice: this.createStartPrice,
              buyoutPrice: this.createBuyoutPrice > 0 ? this.createBuyoutPrice : undefined,
              designatedBuyerId: buyer || undefined,
            }
          : { saleMode: 'fixed', price: this.createPrice, designatedBuyerId: buyer || undefined },
      );
      this.createBuyer = '';
      this.showToast(t('auction.created'));
      await this.loadData();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // ── Bid (auction listings) ──────────────────────────────────────────────────

  /** auc.price = 当前最高出价（有出价时）或起拍价。有出价则要求至少 +5% 加价（服务端权威）。 */
  private minBidFor(auc: AuctionView): number {
    return auc.topBid ? Math.max(auc.price + 1, Math.ceil(auc.price * 1.05)) : auc.price;
  }

  private openBidForm(auc: AuctionView): void {
    const fresh = this.bidAuction?.auctionId !== auc.auctionId;
    const minBid = this.minBidFor(auc);
    this.bidAuction = auc;
    if (fresh) this.bidAmount = minBid;
    this.bidAmount = Math.max(this.bidAmount, minBid);

    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(300, w - 30);
    const mh = 184;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.4).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    let cy = my + 14;
    const matKey = (auc.item?.['material'] as string | undefined) ?? auc.itemType;
    const titleLbl = txt(`${t(`auction.${matKey as 'scrap' | 'lead' | 'binding'}`)} ×${auc.qty}`, 13, C.dark);
    titleLbl.x = mx + 12; titleLbl.y = cy;
    ml.addChild(titleLbl);
    cy += 24;

    const curLbl = txt(`${t(auc.topBid ? 'auction.currentBid' : 'auction.startPrice')}: ${auc.price}`, 11, C.accent);
    curLbl.x = mx + 12; curLbl.y = cy;
    ml.addChild(curLbl);
    cy += 20;

    if (auc.buyoutPrice) {
      const boLbl = txt(t('auction.buyoutAt').replace('{price}', String(auc.buyoutPrice)), 10, C.mid);
      boLbl.x = mx + 12; boLbl.y = cy;
      ml.addChild(boLbl);
      cy += 18;
    }

    this.addNumInput(ml, mx, cy + 6, t('auction.bid') + ':', this.bidAmount, (v) => { this.bidAmount = Math.max(minBid, v); this.openBidForm(auc); });

    const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 3, 80) });
    okBtn.x = mx + mw / 2 - 88; okBtn.y = my + mh - 36;
    ml.addChild(okBtn);
    const ol = txt(t('auction.bid'), 12, C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = my + mh - 22;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: () => this.confirmBid(auc) });

    const caBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 4, 80) });
    caBtn.x = mx + mw / 2 + 8; caBtn.y = my + mh - 36;
    ml.addChild(caBtn);
    const cl = txt('✕', 12, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = mx + mw / 2 + 48; cl.y = my + mh - 22;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeBidModal() });
  }

  private confirmBid(auc: AuctionView): void {
    const amount = this.bidAmount;
    const msg = t('auction.confirmBid').replace('{price}', String(amount));
    this.showConfirmModal(msg, () => void this.doBid(auc.auctionId, amount));
  }

  private async doBid(auctionId: string, amount: number): Promise<void> {
    this.closeBidModal();
    try {
      await this.cb.worldApi.placeBid(auctionId, this.cb.worldId, amount);
      this.showToast(t('auction.bidPlaced'));
      await this.loadData();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private closeBidModal(): void {
    this.bidAuction = null;
    this.closeModal();
  }

  private confirmBuy(auctionId: string, price: number): void {
    const msg = t('auction.confirmBuy').replace('{price}', String(price));
    this.showConfirmModal(msg, () => void this.doBuy(auctionId));
  }

  private async doBuy(auctionId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.buyAuction(auctionId, this.cb.worldId);
      this.showToast(t('auction.bought'));
      await this.loadData();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmCancel(auctionId: string): void {
    this.showConfirmModal(t('auction.confirmCancel'), () => void this.doCancel(auctionId));
  }

  private async doCancel(auctionId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.cancelAuction(auctionId, this.cb.worldId);
      this.showToast(t('auction.cancelled'));
      await this.loadData();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private showConfirmModal(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(280, w - 40);
    const mh = 110;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const lbl = txt(msg, 13, C.dark);
    lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + 14;
    ml.addChild(lbl);

    const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 1, 80) });
    okBtn.x = mx + mw / 2 - 88; okBtn.y = my + mh - 36;
    ml.addChild(okBtn);
    const ol = txt('OK', 12, C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = my + mh - 22;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: onOk });

    const caBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 2, 80) });
    caBtn.x = mx + mw / 2 + 8; caBtn.y = my + mh - 36;
    ml.addChild(caBtn);
    const cl = txt('✕', 12, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = mx + mw / 2 + 48; cl.y = my + mh - 22;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = this.w / 2; lbl.y = this.h - 80;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        AUCTION_CLOSED:          t('auction.err.closed'),
        AUCTION_NOT_FOUND:       t('auction.err.closed'),
        NOT_DESIGNATED_BUYER:    t('auction.err.selfBuy'),
        AUCTION_LIMIT_REACHED:   t('auction.err.limitReached'),
        INSUFFICIENT_FUNDS:      t('auction.err.insufficientFunds'),
        INSUFFICIENT_RESOURCES:  t('auction.err.insufficientFunds'),
        NOT_OWNER:               t('auction.err.notOwner'),
        NO_PERMISSION:           t('auction.err.notOwner'),
        INSUFFICIENT_MATERIALS:  t('auction.err.noMaterial'),
        NOT_IMPLEMENTED:         t('auction.err.notImpl'),
        BID_TOO_LOW:             t('auction.err.bidTooLow'),
        PRICE_OUT_OF_RANGE:      t('auction.err.priceRange'),
        MATERIAL_NOT_TRADEABLE:  t('auction.err.notTradeable'),
        WORLD_CLOSED:            t('auction.err.worldClosed'),
        EQUIP_LOCKED:            t('auction.err.equipLocked'),
        EQUIP_IN_USE:            t('auction.err.equipInUse'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action(); return;
        }
      }
      return;
    }
    for (const { rect, action } of this.hitRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action(); return;
      }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
  }

  handleMove(_x: number, y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  handleUp(_x: number, _y: number): void {
    this.dragStart = null;
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.container.destroy({ children: true });
  }
}
