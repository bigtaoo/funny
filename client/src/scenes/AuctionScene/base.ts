// Shared foundation for the AuctionScene mixin chain (see ../AuctionScene.ts assembly).
// AuctionSceneBase holds every instance field (all `protected`, so panel/network mixin method bodies keep
// referencing them verbatim: this.allAuctions, this.createClass, …) + the constructor, data loading, the
// render dispatcher, shared item-label/icon helpers (equipName/cardName/itemKind/saleModeKind/auctionLabel),
// the shared numeric-stepper widget (addNumInput), modal/toast primitives (closeModal/showConfirmModal/
// showToast/errorMsg), and the Scene interface (input handling/update/destroy). Each domain lives in its own
// sibling file as an `XMixin(Base)` and is chained together into the final AuctionScene.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader } from '../../ui/widgets/SceneHeader';
import type { WorldApiClient, AuctionView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import type { SaveData, EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { buildIcon, type IconKind } from '../../render/icons';

// ── AuctionScene (S8-5) — SLG auction scene ─────────────────────────────────
//
// Two tabs: all auctions / my listings; bottom actions: create listing / buy / cancel
// E5 / CC-5: listing supports three item classes — material, equipment instance, character card.
//   Equipment/card listings send { instanceId }; the server escrows the full instance snapshot (qty always 1).

export interface AuctionSceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  /**
   * Read the current authoritative save — source for the equipment/card listing picker
   * (equipmentInv / cardInv). Optional: without it, only material listing is offered.
   */
  getSave?(): SaveData;
  /**
   * Re-pull the authoritative save after an equipment/card listing (the server escrows the
   * instance, removing it from inventory). Optional; no-op when absent (e.g. tests).
   */
  reloadSave?(): Promise<void>;
  /**
   * Current account id — used to derive "我的收购" (auctions I'm the current top bidder on)
   * client-side from the already-loaded market list. Optional; without it the tab is empty.
   */
  myAccountId?: string;
}

export type AucTab = 'all' | 'mine' | 'bids';
export type ItemClass = 'material' | 'equipment' | 'card';

export const ROW_H = 76;
export const HUD_H = 50;
export const FILTER_H = 44;

// Material types available for auction
export const MATERIALS = ['scrap', 'lead', 'binding'] as const;
// Fixed listing duration — must match server-side AUCTION_DURATIONS_SEC (shared/slg/auction.ts),
// otherwise createAuction throws BAD_REQUEST. No longer user-selectable (all listings run 72h).
export const AUCTION_DURATION_SEC = 72 * 3600;
// Category filter for the market tab — matches AuctionView.itemType ('' = no filter).
export const FILTERS = ['', 'material', 'equipment', 'card'] as const;
export type AucFilter = typeof FILTERS[number];

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type AuctionSceneBaseCtor = Constructor<AuctionSceneBase>;

export class AuctionSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly cb: AuctionSceneCallbacks;

  protected activeTab: AucTab = 'all';
  protected allFilter: AucFilter = '';
  protected allAuctions: AuctionView[] = [];
  protected myListings: AuctionView[] = [];
  protected loading = true;
  protected hiddenInput: HTMLInputElement | null = null;

  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;
  protected toastLayer!: PIXI.Container;

  // Create form state
  protected createClass: ItemClass = 'material';
  protected createMaterial: typeof MATERIALS[number] = 'scrap';
  protected createEquipId: string | null = null; // selected equipment instance (class='equipment')
  protected createCardId: string | null = null;   // selected card instance (class='card')
  protected createSaleMode: 'fixed' | 'auction' = 'fixed';
  protected createQty = 1;
  protected createPrice = 10;        // fixed buy-now unit price
  protected createStartPrice = 10;   // auction starting unit price
  protected createBuyoutPrice = 0;   // auction buyout (0 = none)
  protected createBuyer = '';
  protected buyerActive = false;
  protected caretOn = true;
  protected caretTimer = 0;
  protected createOpen = false;

  // Unified item picker (scene-level overlay, reuses the body drag-scroll): true → show the picker
  // list (materials + equipment + cards, sorted by value desc) instead of the market/mine list.
  // Selecting an entry returns to the create form.
  protected itemPickerOpen = false;

  // Bid form state (auction listings)
  protected bidAuction: AuctionView | null = null;
  protected bidAmount = 0;

  // Scroll
  protected scrollY = 0;
  protected dragStart: { x: number; y: number; scroll: number } | null = null;

  // Hit rects
  protected hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalOpen = false;

  // Toast
  protected toastTimer = 0;
  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

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
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    // Static header
    const hdr = drawSceneHeader(this.container, w, this.h, t('auction.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 18,
    });
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  protected async loadData(): Promise<void> {
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

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer);
    // Keep static header; only rebuild body hits (not back button)
    this.hitRects = [];

    // Item picker overlay: back button cancels the picker and returns to the create form.
    if (this.itemPickerOpen) {
      this.hitRects.push({ rect: { x: 0, y: 0, w: 80, h: HUD_H }, action: () => this.cancelItemPicker() });
      this.renderItemPicker();
      return;
    }

    this.hitRects.push({ rect: { x: 0, y: 0, w: 80, h: HUD_H }, action: () => this.cb.onBack() });

    const contentX = this.renderSidebar();
    const filterH = this.activeTab === 'all' ? this.renderFilterBar(contentX) : 0;
    const list = this.activeTab === 'all' ? this.allAuctions : this.activeTab === 'mine' ? this.myListings : this.myBids();
    this.renderList(list, contentX, filterH);
    this.renderCreateButton(contentX);
  }

  // ── Item labels & inventory (equipment / card) ─────────────────────────────

  /** Equipment display name from i18n (`equip.<defId>.name`); falls back to the raw defId. */
  protected equipName(defId: string): string {
    const key = `equip.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  /** Card display name from i18n (`card.<defId>.name`); falls back to the raw defId. */
  protected cardName(defId: string): string {
    const key = `card.${defId}.name` as TranslationKey;
    const s = t(key);
    return s === key ? defId : s;
  }

  // ── Icon resolution ────────────────────────────────────────────────────────
  // Reuses existing icons.ts glyphs (no new definitions): equipment→shield, card→card
  // stack, material→its own material glyph; sale-mode fixed→price tag, auction→gavel(hammer).

  /** Glyph for an item class / listing item type. */
  protected itemKind(itemType: string | undefined, material?: string): IconKind {
    if (itemType === 'equipment') return 'armor';
    if (itemType === 'card') return 'cards';
    return (material ?? 'scrap') as IconKind;
  }

  /** Glyph for a sale mode: fixed buy-now → price tag, auction → gavel. */
  protected saleModeKind(mode: 'fixed' | 'auction'): IconKind {
    return mode === 'auction' ? 'hammer' : 'tag';
  }

  /** Human label for a listing row/title, per item class. */
  protected auctionLabel(auc: AuctionView): string {
    if (auc.itemType === 'equipment') {
      const inst = auc.item?.['instance'] as EquipmentInstance | undefined;
      return inst ? `${this.equipName(inst.defId)} +${inst.level}` : t('auction.filterEquipment');
    }
    if (auc.itemType === 'card') {
      const inst = auc.item?.['instance'] as CardInstance | undefined;
      return inst ? `${this.cardName(inst.defId)} Lv.${inst.level}` : t('auction.filterCard');
    }
    const mat = (auc.item?.['material'] as string | undefined) ?? 'scrap';
    return `${t(`auction.${mat as 'scrap' | 'lead' | 'binding'}`)} ×${auc.qty}`;
  }

  // ── Shared widgets ──────────────────────────────────────────────────────────

  protected addNumInput(
    layer: PIXI.Container,
    mx: number, y: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
    scale = 1,
  ): void {
    const btnSize = 24 * scale;
    const gap = 8 * scale;
    const half = btnSize / 2;

    const lbl = txt(label, 12 * scale, C.dark);
    lbl.x = mx + 10 * scale; lbl.y = y;
    layer.addChild(lbl);

    const minusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 0, btnSize) });
    minusBtn.x = mx + 10 * scale + lbl.width + gap; minusBtn.y = y - 2 * scale;
    layer.addChild(minusBtn);
    const ml = txt('−', 14 * scale, C.dark);
    ml.anchor.set(0.5, 0.5); ml.x = minusBtn.x + half; ml.y = y + 10 * scale;
    layer.addChild(ml);
    this.modalHits.push({ rect: { x: minusBtn.x, y: minusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value - 1) });

    const valLbl = txt(String(value), 13 * scale, C.dark);
    valLbl.anchor.set(0, 0.5);
    valLbl.x = minusBtn.x + btnSize + gap; valLbl.y = y + 10 * scale;
    layer.addChild(valLbl);

    const plusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, btnSize) });
    plusBtn.x = minusBtn.x + btnSize + gap + valLbl.width + gap; plusBtn.y = y - 2 * scale;
    layer.addChild(plusBtn);
    const pl = txt('+', 14 * scale, C.dark);
    pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + half; pl.y = y + 10 * scale;
    layer.addChild(pl);
    this.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value + 1) });
  }

  // ── Modal / toast primitives ────────────────────────────────────────────────

  protected showConfirmModal(msg: string, onOk: () => void): void {
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
    const cl = buildIcon('close', 14, C.dark);
    cl.x = mx + mw / 2 + 48 - 7; cl.y = my + mh - 22 - 7;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: caBtn.x, y: caBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  protected closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = this.w / 2; lbl.y = this.h - 80;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  protected errorMsg(e: unknown): string {
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
        CARD_HAS_GEAR:           t('auction.err.cardHasGear'),
        CARD_NOT_FOUND:          t('auction.err.closed'),
        EQUIP_NOT_FOUND:         t('auction.err.closed'),
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
    if (this.buyerActive) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; if (this.modalOpen) this.openCreateForm(); }
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

// ── Cross-mixin entrypoints dispatched to from base-level code (render()/update()/handleDown() reach into
// picker/list/create-form/bid/trade mixins that are invisible to each other and to the base), plus cross-mixin
// calls between domain mixins themselves. Declared via interface/class declaration merging so base-level
// `this.renderList()` / `this.openCreateForm()` / … type-check as METHODS (not properties, which would clash
// with the mixin's method override — TS2425). Emits NOTHING at runtime, so the real prototype methods
// provided by the mixins run and all method bodies stay verbatim.
export interface AuctionSceneBase {
  // list.ts
  renderSidebar(): number;
  renderFilterBar(contentX: number): number;
  renderList(auctions: AuctionView[], contentX: number, filterH?: number): void;
  renderCreateButton(contentX: number): void;
  myBids(): AuctionView[];
  // picker.ts
  renderItemPicker(): void;
  listableEquipment(): EquipmentInstance[];
  listableCards(): CardInstance[];
  selectedItemLabel(): string | null;
  openItemPicker(): void;
  cancelItemPicker(): void;
  // createForm.ts
  openCreateForm(): void;
  doCreate(): Promise<void>;
  // bid.ts
  openBidForm(auc: AuctionView): void;
  confirmBid(auc: AuctionView): void;
  doBid(auctionId: string, amount: number): Promise<void>;
  closeBidModal(): void;
  // tradeActions.ts
  confirmBuy(auctionId: string, price: number): void;
  doBuy(auctionId: string): Promise<void>;
  confirmCancel(auctionId: string): void;
  doCancel(auctionId: string): Promise<void>;
}
