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
import { drawConfirmDialog } from '../../render/confirmDialog';
import type { IconKind } from '../../render/icons';
import { showToastMessage } from '../../net/log';
import { FS, snapFont } from '../../render/fontScale';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, sceneHeaderHeight, HEADER_ACCENT, drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import type { WorldApiClient, AuctionView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import type { SaveData, EquipmentInstance, CardInstance } from '../../game/meta/SaveData';
import { caretDisplay } from '../../render/inputDisplay';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';

// ── AuctionScene (S8-5) — SLG auction scene ─────────────────────────────────
//
// Two tabs: all auctions / my listings; bottom actions: create listing / buy / cancel
// E5 / CC-5: listing supports three item classes — material, equipment instance, character card.
//   Equipment/card listings send { instanceId }; the server escrows the full instance snapshot (qty always 1).

export interface AuctionSceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
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
   * Current account id — used to derive "My Bids" (auctions I'm the current top bidder on)
   * client-side from the already-loaded market list. Optional; without it the tab is empty.
   */
  myAccountId?: string;
}

export type AucTab = 'all' | 'mine' | 'bids';
export type ItemClass = 'material' | 'equipment' | 'card';

export const HUD_H = 50;
// 1.5x the original 44 — approved 15.07.2026 category-bar enlargement pass.
export const FILTER_H = 66;

// Auction market grid: card cells (mirrors CardScene's roster-card treatment — a framed item glyph
// on the left, info stacked to the right) instead of thin list rows.
export const AUC_CELL_GAP = 14;
// Compact card height — the 285 from the 15.07.2026 1.5x pass left a large dead gap between the
// price block and the bottom-pinned countdown/buy row (16.07.2026 report: "看起来太乱了"). Shrunk
// back down so content and the bottom row sit close together, with more rows visible per screen.
export const AUC_CELL_H = 180;
export const AUC_CELL_W_TARGET = 340;

// Material types available for auction
export const MATERIALS = ['scrap', 'lead', 'binding'] as const;
// Fixed listing duration — must match server-side AUCTION_DURATIONS_SEC (shared/slg/auction.ts),
// otherwise createAuction throws BAD_REQUEST. No longer user-selectable (all listings run 72h).
export const AUCTION_DURATION_SEC = 72 * 3600;
// Category filter for the market tab — matches AuctionView.itemType ('' = no filter).
export const FILTERS = ['', 'material', 'equipment', 'card'] as const;
export type AucFilter = typeof FILTERS[number];

// Background-poll cadence. auctionsvc is a pure REST service with no push channel (own DB, port 18086,
// not wired into the gateway), so the open market goes stale the moment another player buys/bids/lists.
// We mirror WorldMapNet's setInterval refresh — but off the scene's own update(dt) tick so it stops
// automatically on destroy — to re-pull every few seconds. See loadData / pollRefresh.
export const AUCTION_POLL_SEC = 5;

// Lightweight change-signature for a listing set: re-render on a poll only when something visible
// actually changed (item sold/removed, new bid → price change, expiry, new listing), so an unchanged
// market doesn't tear down and rebuild the body (which would fight scrolling) every 5s.
export function auctionSig(list: AuctionView[]): string {
  return list.map((a) => `${a.auctionId}:${a.price}:${a.status}:${a.expireAt}:${a.buyerId ?? ''}`).join(',');
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type AuctionSceneBaseCtor = Constructor<AuctionSceneBase>;

export class AuctionSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly landscape: boolean;
  protected readonly cb: AuctionSceneCallbacks;

  // Title-bar height. Set in the constructor to the shared standard (sceneHeaderHeight, 12% of design
  // height) so the auction bar matches every other secondary scene; drives all body layout below it
  // (sidebar / filter bar / list / picker), replacing the old fixed HUD_H.
  protected headerH = HUD_H;
  /** Back-button hit rect from the shared SceneHeader (BACK_HIT_W-wide) — cached here since render()
   * rebuilds hitRects from scratch every call and must not narrow it. */
  protected backRect = { x: 0, y: 0, w: 80, h: this.headerH };

  protected activeTab: AucTab = 'all';
  protected allFilter: AucFilter = '';
  protected allAuctions: AuctionView[] = [];
  protected myListings: AuctionView[] = [];
  protected loading = true;
  /** Seconds since the last background poll (accumulated in update()); fires pollRefresh() every AUCTION_POLL_SEC. */
  protected pollTimer = 0;
  /** Change-signature of the last applied listing snapshot — a poll only re-renders when this changes. */
  protected lastSig = '';
  protected hiddenInput: HTMLInputElement | null = null;

  protected bodyLayer!: PIXI.Container;
  protected modalLayer!: PIXI.Container;
  /** Coin balance readout, drawn over the static header chrome and refreshed every render(). */
  protected headerOverlayLayer!: PIXI.Container;

  /** Async card-art texture URLs already hooked for a re-render on load (avoids double-subscribing). */
  protected readonly artHooked = new Set<string>();

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
  protected numEditKey: string | null = null; // which addNumInput field is being typed into (null = none)
  protected createOpen = false;

  // Price guardrail band for the item currently selected in the create form, fetched from the server
  // (GET /auction/refprice) so the seller sees the acceptable range before submitting. refBandCat is the
  // category the current state corresponds to (null = unguarded item like a card); refBand is the loaded
  // band (null = cold-start pass-through, any price allowed); refBandLoading gates the in-flight fetch.
  protected refBandCat: string | null = null;
  protected refBand: { ref: number; floor: number; ceil: number } | null = null;
  protected refBandLoading = false;

  // Unified item picker (scene-level overlay, reuses the body drag-scroll): true → show the picker
  // list (materials + equipment + cards, sorted by value desc) instead of the market/mine list.
  // Selecting an entry returns to the create form.
  protected itemPickerOpen = false;
  // Category filter for the picker's item grid (mirrors the market tab's allFilter) — '' = all classes.
  protected pickerFilter: AucFilter = '';

  // Bid form state (auction listings)
  protected bidAuction: AuctionView | null = null;
  protected bidAmount = 0;

  // Scroll
  protected scrollY = 0;
  /**
   * Max scrollY for the currently-visible scrollable region (market/mine/bids list in list.ts, or the
   * item picker in picker.ts — only one is ever visible at once, so they share scrollY/scrollMax).
   * Refreshed every render() by whichever of renderList/renderItemPicker actually ran.
   */
  protected scrollMax = 0;
  /** Vertical bounds (design px) of the currently-visible scrollable region, refreshed alongside
   *  scrollMax — used to gate PC mouse-wheel scrolling to the actual list/picker area (see onWheel below). */
  protected scrollRegionTop = 0;
  protected scrollRegionBottom = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a listing card's hit action to pointer-up and drops it if the
   * pointer dragged (so a drag starting on a card scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;

  // Hit rects
  protected hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  protected modalOpen = false;

  protected destroyed = false;
  protected readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: AuctionSceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.headerH = sceneHeaderHeight(this.h);
    this.container = new PIXI.Container();
    this.build();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));
  }

  private build(): void {
    const { w, h, landscape } = this;
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    const bg = buildPaperBackground('auction', w, h, { railX });
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    // Static header — shared standard height/title size (matches every other secondary scene); only the
    // SLG-red accent rule distinguishes it. headerH drives the body layout below.
    const hdr = drawSceneHeader(this.container, w, this.h, t('auction.title'), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.headerH = hdr.headerH;
    this.backRect = hdr.backRect;
    this.hitRects.push({ rect: this.backRect, action: () => this.cb.onBack() });

    this.headerOverlayLayer = new PIXI.Container();
    this.container.addChild(this.headerOverlayLayer);
  }

  /** Coin balance (top-right), drawn on top of the static header chrome; called every render() so a
   * buy/bid immediately reflects the new balance without rebuilding the whole header. */
  protected renderHeaderCurrency(): void {
    tearDownChildren(this.headerOverlayLayer);
    const coins = this.cb.getSave?.()?.wallet.coins ?? 0;
    drawHeaderCurrency(this.headerOverlayLayer, this.w, this.headerH, coins);
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  protected async loadData(): Promise<void> {
    if (this.destroyed) return;
    this.loading = true;
    this.render();
    try {
      const [all, mine] = await Promise.all([
        this.cb.worldApi.listAuctions(this.allFilter ? { itemType: this.allFilter } : undefined),
        this.cb.worldApi.getMyListings(),
      ]);
      this.allAuctions = all;
      this.myListings = mine;
      this.lastSig = auctionSig(all) + '|' + auctionSig(mine);
    } catch { /* offline */ }
    this.loading = false;
    this.pollTimer = 0; // just refreshed — restart the background-poll clock
    if (!this.destroyed) this.render();
  }

  /**
   * Silent background re-pull (no loading flash, keeps scrollY): fetch the market + my listings and
   * re-render only when the signature changed, so another player's buy/bid/cancel/new-listing shows up
   * while the panel stays open. Called from update() every AUCTION_POLL_SEC; update() skips it while a
   * modal/picker is open, and we double-check after the await in case one opened mid-fetch (don't stomp
   * an in-progress create/bid form). On network failure we keep the last snapshot and retry next tick.
   */
  protected async pollRefresh(): Promise<void> {
    if (this.destroyed) return;
    let all: AuctionView[];
    let mine: AuctionView[];
    try {
      [all, mine] = await Promise.all([
        this.cb.worldApi.listAuctions(this.allFilter ? { itemType: this.allFilter } : undefined),
        this.cb.worldApi.getMyListings(),
      ]);
    } catch { return; /* offline — keep last snapshot */ }
    if (this.destroyed || this.modalOpen || this.itemPickerOpen) return;
    const sig = auctionSig(all) + '|' + auctionSig(mine);
    if (sig === this.lastSig) return; // nothing changed → skip the teardown/re-render
    this.allAuctions = all;
    this.myListings = mine;
    this.lastSig = sig;
    this.render();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer);
    // Keep static header; only rebuild body hits (not back button)
    this.hitRects = [];
    this.renderHeaderCurrency();

    // Item picker overlay: back button cancels the picker and returns to the create form.
    if (this.itemPickerOpen) {
      this.hitRects.push({ rect: this.backRect, action: () => this.cancelItemPicker() });
      this.renderItemPicker();
      return;
    }

    this.hitRects.push({ rect: this.backRect, action: () => this.cb.onBack() });

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

  // ── Price guardrail band (create-form reference price) ───────────────────────

  /**
   * Server price-guard category for the item currently selected in the create form
   * (`material:<mat>` / `equip:<defId>:<level>`), or null for classes with no guardrail (cards). Mirrors
   * the server's categoryOf so the band we fetch matches the band createAuction will enforce.
   */
  protected currentListingCategory(): string | null {
    if (this.createClass === 'material') return `material:${this.createMaterial}`;
    if (this.createClass === 'equipment') {
      const inst = this.listableEquipment().find((e) => e.id === this.createEquipId);
      return inst ? `equip:${inst.defId}:${inst.level}` : null;
    }
    return null; // card: no price window (server passes through)
  }

  /**
   * Fetch (once per category) the price guardrail band for the given category and cache it, then re-render
   * the create form so the seller sees the acceptable range. Called from openCreateForm on every render;
   * short-circuits when the category is already synced, so it fires exactly one request per item selection.
   */
  protected ensureRefBand(category: string | null): void {
    if (category === this.refBandCat) return; // already loaded / loading for this category
    this.refBandCat = category;
    this.refBand = null;
    this.refBandLoading = false;
    if (category === null) return; // unguarded item (card): any price allowed
    this.refBandLoading = true;
    void this.cb.worldApi.getAuctionRefBand(category)
      .then((band) => { if (!this.destroyed && this.refBandCat === category) { this.refBand = band; this.refBandLoading = false; if (this.modalOpen) this.openCreateForm(); } })
      .catch(() => { if (!this.destroyed && this.refBandCat === category) { this.refBandLoading = false; if (this.modalOpen) this.openCreateForm(); } });
  }

  // ── Shared widgets ──────────────────────────────────────────────────────────

  protected addNumInput(
    layer: PIXI.Container,
    mx: number, y: number,
    label: string,
    value: number,
    onChange: (v: number) => void,
    scale = 1,
    // When `editKey` is set the value becomes a tappable text field (type a number directly); `clamp`
    // (if given) is applied when the user commits the typed value on blur — used to snap out-of-range
    // prices back into the allowed band.
    opts?: { editKey?: string; clamp?: (v: number) => number },
  ): void {
    const btnSize = 24 * scale;
    const gap = 8 * scale;
    const half = btnSize / 2;

    const lbl = txt(label, snapFont(12 * scale), C.dark);
    lbl.x = mx + 10 * scale; lbl.y = y;
    layer.addChild(lbl);

    const minusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 0, btnSize) });
    minusBtn.x = mx + 10 * scale + lbl.width + gap; minusBtn.y = y - 2 * scale;
    layer.addChild(minusBtn);
    const ml = txt('−', snapFont(14 * scale), C.dark);
    ml.anchor.set(0.5, 0.5); ml.x = minusBtn.x + half; ml.y = y + 10 * scale;
    layer.addChild(ml);
    this.modalHits.push({ rect: { x: minusBtn.x, y: minusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value - 1) });

    const editing = opts?.editKey != null && this.numEditKey === opts.editKey;
    if (opts?.editKey != null) {
      // Editable field: tap to type a value directly (mirrors the buyer-id field pattern).
      const fieldW = 64 * scale;
      const fieldH = btnSize;
      const fieldX = minusBtn.x + btnSize + gap;
      const field = sketchPanel(fieldW, fieldH, { fill: 0xfaf9f5, border: editing ? C.accent : C.mid, seed: seedFor(y, 2, fieldW) });
      field.x = fieldX; field.y = y - 2 * scale;
      layer.addChild(field);
      const valLbl = txt(caretDisplay(String(value), editing && this.caretOn, String(value)), snapFont(13 * scale), C.dark);
      valLbl.anchor.set(0.5, 0.5); valLbl.x = fieldX + fieldW / 2; valLbl.y = y + 10 * scale;
      layer.addChild(valLbl);
      this.modalHits.push({ rect: { x: fieldX, y: field.y, w: fieldW, h: fieldH }, action: () => this.openNumInput(opts.editKey!, value, onChange, opts.clamp) });

      const plusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, btnSize) });
      plusBtn.x = fieldX + fieldW + gap; plusBtn.y = y - 2 * scale;
      layer.addChild(plusBtn);
      const pl = txt('+', snapFont(14 * scale), C.dark);
      pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + half; pl.y = y + 10 * scale;
      layer.addChild(pl);
      this.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value + 1) });
      return;
    }

    const valLbl = txt(String(value), snapFont(13 * scale), C.dark);
    valLbl.anchor.set(0, 0.5);
    valLbl.x = minusBtn.x + btnSize + gap; valLbl.y = y + 10 * scale;
    layer.addChild(valLbl);

    const plusBtn = sketchPanel(btnSize, btnSize, { fill: 0xeeeeee, border: C.mid, seed: seedFor(y, 1, btnSize) });
    plusBtn.x = minusBtn.x + btnSize + gap + valLbl.width + gap; plusBtn.y = y - 2 * scale;
    layer.addChild(plusBtn);
    const pl = txt('+', snapFont(14 * scale), C.dark);
    pl.anchor.set(0.5, 0.5); pl.x = plusBtn.x + half; pl.y = y + 10 * scale;
    layer.addChild(pl);
    this.modalHits.push({ rect: { x: plusBtn.x, y: plusBtn.y, w: btnSize, h: btnSize }, action: () => onChange(value + 1) });
  }

  // Hidden-input driver for a tappable numeric field: live-updates the value as digits are typed and, on
  // blur, applies the optional clamp so an out-of-range price snaps to the nearest allowed bound.
  protected openNumInput(key: string, current: number, onChange: (v: number) => void, clamp?: (v: number) => number): void {
    this.numEditKey = key;
    this.caretOn = true;
    this.caretTimer = 0;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.inputMode = 'numeric';
    inp.value = String(current);
    inp.maxLength = 12;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.select();
    const parse = (): number => {
      const digits = inp.value.replace(/[^0-9]/g, '');
      return digits === '' ? 0 : parseInt(digits, 10);
    };
    inp.addEventListener('input', () => {
      const digits = inp.value.replace(/[^0-9]/g, '');
      if (inp.value !== digits) inp.value = digits;
      onChange(parse());
    });
    // Enter commits the value the same way blur does (PC keyboard convenience — mobile taps
    // elsewhere to blur, so this is additive, not a replacement path).
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    inp.addEventListener('blur', () => {
      const v = parse();
      this.numEditKey = null;
      inp.remove();
      if (this.hiddenInput === inp) this.hiddenInput = null;
      onChange(clamp ? clamp(v) : v);
    });
    this.hiddenInput = inp;
  }

  // ── Modal / toast primitives ────────────────────────────────────────────────

  protected showConfirmModal(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    this.modalHits = [];
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(ml, w, h, msg, () => onOk(), () => this.closeModal());
  }

  protected closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  protected errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        AUCTION_CLOSED:          t('auction.err.closed'),
        AUCTION_NOT_FOUND:       t('auction.err.closed'),
        NOT_DESIGNATED_BUYER:    t('auction.err.notDesignatedBuyer'),
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
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a listing card scrolls instead of firing it.
    let hit: (() => void) | null = null;
    for (const { rect, action } of this.hitRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { hit = action; break; }
    }
    this.gesture.down(this.scrollY, y, hit);
  }

  handleMove(_x: number, y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll !== null) { this.scrollY = scroll; this.scrollDirty = true; }
  }

  handleUp(_x: number, _y: number): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** Mouse-wheel scroll over the market/mine/bids list or the item picker (browser only, see
   *  InputManager.onWheel). Skipped while a modal (create form/bid/confirm) sits on top — modals aren't
   *  scrollable, and scrolling the list underneath while one is open would be confusing. */
  handleWheel(y: number, deltaY: number): void {
    if (this.modalOpen) return;
    const next = wheelScrollY(this.scrollRegionTop, this.scrollRegionBottom, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
  }

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.buyerActive || this.numEditKey) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; if (this.modalOpen) this.openCreateForm(); }
    }
    // Background poll: keep the open market fresh (auctionsvc has no push). Hold the clock while loading
    // or while a modal/picker is open so we never re-render over an in-progress form or the user's input.
    if (!this.loading && !this.modalOpen && !this.itemPickerOpen) {
      this.pollTimer += dt;
      if (this.pollTimer >= AUCTION_POLL_SEC) { this.pollTimer = 0; void this.pollRefresh(); }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    // Free descendant Text baseTextures before dropping the container (overlay over the live
    // WorldMapScene → leaks a screenful of Text per close otherwise). See sketchUi.tearDownChildren.
    tearDownChildren(this.container);
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
  renderAuctionCell(auc: AuctionView, x: number, y: number, cellW: number, now: number): void;
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
