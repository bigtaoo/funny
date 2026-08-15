// Shared foundation for the AuctionScene composition (see ../AuctionScene.ts assembly).
//
// AuctionSceneCore holds every instance field (all public, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.allAuctions, this.core.createClass, …) + the layer
// scaffold (build), data loading, the shared numeric-stepper widget (addNumInput), modal/toast
// primitives (closeModal/showConfirmModal/showToast/errorMsg), and the pointer-input/lifecycle
// plumbing. Core wires all four InputManager subscriptions itself AND owns handleDown/handleMove/
// handleUp/handleWheel directly — they only ever dispatch through pre-registered `hitRects`/
// `modalHits` closures (set by whichever domain rendered them), never calling a domain method by
// name, so there's no two-phase-construction concern there (unlike the two lazy hooks below). Core
// does NOT own the render() dispatcher (which calls into ListPanel's/CreateListingPanel's
// mode-specific methods) or the initial loadData() call — both live on the outer ../AuctionScene.ts
// assembly since only it knows about every domain instance (Core takes a `render` callback injected
// at construction instead of owning render() itself, mirroring SectSceneCore).
//
// Two call sites still need to reach into the not-yet-constructed CreateListingPanel from inside
// Core's own async/timer code (ensureRefBand's fetch callback, update()'s caret-blink tick) — both go
// through the lazy `reopenCreateForm` field (default no-op, overwritten by the outer assembly right
// after CreateListingPanel is constructed), the same "default no-op then overwrite" pattern
// SectSceneCore's `allianceHooks` uses (see claudedocs/client-modules.md's split-form priority note).
//
// Each domain (bid / trade actions / create-listing+item-picker / list) is its own independent class
// in a sibling file, constructed with `core` (2026-08-11: converted from the former `XMixin(Base)`
// inheritance chain — the cross-mixin calls this used to reach via interface declaration merging are
// now explicit constructor params instead). Dependency shape: List → Bid, TradeActions,
// CreateListingPanel (one-directional: List's row actions open the bid/buy/cancel/create-listing
// flows; none of those three ever call back into List) — see list.ts's narrow BidOpener/TradeOpener/
// CreateFormOpener interfaces. picker.ts and createForm.ts were merged into a single
// CreateListingPanel (create-listing.ts) during this conversion: the two used to call each other's
// methods directly (picker→openCreateForm, createForm→selectedItemLabel/openItemPicker) — a genuine
// bidirectional dependency, which per the composition-priority rule means the file boundary was drawn
// wrong, not that it needs a resolved-dependency workaround. They're two faces of one "create a
// listing" flow (pick an item → fill in the form), so merging them into one class with one shared
// bottom layer (buildPickEntries/listable*/selectedItemLabel) removes the cycle entirely.
//
// Pure item-class label/icon helpers (equipName/cardName/itemKind/saleModeKind/auctionLabel/
// auctionItemLevel/auctionItemMaxLevel/auctionLabelText) never touched `this` beyond calling each
// other, so they moved out to itemLabels.ts as plain form① functions instead of Core methods —
// list.ts/bid.ts/create-listing.ts import them directly.

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { drawConfirmDialog } from '../../ui/dialogs/confirmDialog';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSceneHeader, sceneHeaderHeight, HEADER_ACCENT, drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import type { AuctionView } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import { BusyTracker, TimeoutError } from '../../ui/busyTracker';
import {
  type AuctionSceneCallbacks, type AucTab, type ItemClass, type AucFilter,
  HUD_H, MATERIALS, AUCTION_POLL_SEC, auctionSig,
} from './types';

export * from './types';

// ── AuctionScene (S8-5) — SLG auction scene ─────────────────────────────────
//
// Two tabs: all auctions / my listings; bottom actions: create listing / buy / cancel
// E5 / CC-5: listing supports three item classes — material, equipment instance, character card.
//   Equipment/card listings send { instanceId }; the server escrows the full instance snapshot (qty always 1).

export class AuctionSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: AuctionSceneCallbacks;

  // Title-bar height. Set in the constructor to the shared standard (sceneHeaderHeight, 12% of design
  // height) so the auction bar matches every other secondary scene; drives all body layout below it
  // (sidebar / filter bar / list / picker), replacing the old fixed HUD_H.
  headerH = HUD_H;
  /** Back-button hit rect from the shared SceneHeader (BACK_HIT_W-wide) — cached here since render()
   * rebuilds hitRects from scratch every call and must not narrow it. */
  backRect = { x: 0, y: 0, w: 80, h: this.headerH };

  activeTab: AucTab = 'all';
  allFilter: AucFilter = '';
  allAuctions: AuctionView[] = [];
  myListings: AuctionView[] = [];
  loading = true;
  /** Seconds since the last background poll (accumulated in update()); fires pollRefresh() every AUCTION_POLL_SEC. */
  pollTimer = 0;
  /** Change-signature of the last applied listing snapshot — a poll only re-renders when this changes. */
  lastSig = '';
  hiddenInput: HTMLInputElement | null = null;

  bodyLayer!: PIXI.Container;
  modalLayer!: PIXI.Container;
  /** Coin balance readout, drawn over the static header chrome and refreshed every render(). */
  headerOverlayLayer!: PIXI.Container;

  /** Async card-art texture URLs already hooked for a re-render on load (avoids double-subscribing). */
  readonly artHooked = new Set<string>();

  // Create form state
  createClass: ItemClass = 'material';
  createMaterial: typeof MATERIALS[number] = 'scrap';
  createEquipId: string | null = null; // selected equipment instance (class='equipment')
  createCardId: string | null = null;   // selected card instance (class='card')
  createSkinId: string | null = null;   // selected skin id (class='skin')
  createSaleMode: 'fixed' | 'auction' = 'fixed';
  createQty = 1;
  createPrice = 10;        // fixed buy-now unit price
  createStartPrice = 10;   // auction starting unit price
  createBuyoutPrice = 0;   // auction buyout (0 = none)
  createBuyer = '';
  buyerActive = false;
  caretOn = true;
  caretTimer = 0;
  numEditKey: string | null = null; // which addNumInput field is being typed into (null = none)
  createOpen = false;

  // Price guardrail band for the item currently selected in the create form, fetched from the server
  // (GET /auction/refprice) so the seller sees the acceptable range before submitting. refBandCat is the
  // category the current state corresponds to (null = unguarded item like a card); refBand is the loaded
  // band (null = cold-start pass-through, any price allowed); refBandLoading gates the in-flight fetch.
  refBandCat: string | null = null;
  refBand: { ref: number; floor: number; ceil: number } | null = null;
  refBandLoading = false;

  // Unified item picker (scene-level overlay, reuses the body drag-scroll): true → show the picker
  // list (materials + equipment + cards, sorted by value desc) instead of the market/mine list.
  // Selecting an entry returns to the create form.
  itemPickerOpen = false;
  // Category filter for the picker's item grid (mirrors the market tab's allFilter) — '' = all classes.
  pickerFilter: AucFilter = '';

  // Bid form state (auction listings)
  bidAuction: AuctionView | null = null;
  bidAmount = 0;

  // Scroll
  scrollY = 0;
  /**
   * Max scrollY for the currently-visible scrollable region (market/mine/bids list in list.ts, or the
   * item picker in create-listing.ts — only one is ever visible at once, so they share scrollY/scrollMax).
   * Refreshed every render() by whichever of renderList/renderItemPicker actually ran.
   */
  scrollMax = 0;
  /** Vertical bounds (design px) of the currently-visible scrollable region, refreshed alongside
   *  scrollMax — used to gate PC mouse-wheel scrolling to the actual list/picker area (see onWheel below). */
  scrollRegionTop = 0;
  scrollRegionBottom = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a listing card's hit action to pointer-up and drops it if the
   * pointer dragged (so a drag starting on a card scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;

  // Hit rects
  hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  modalOpen = false;

  destroyed = false;
  readonly unsubs: (() => void)[] = [];

  /** Guards doBuy/doCancel: blocks a repeat click while one is in flight and drives the
   *  busy-button greying in list.ts. */
  readonly bt = new BusyTracker();

  /**
   * Set once by the outer assembly right after CreateListingPanel is constructed (Core is
   * constructed first, so a direct `createListing.openCreateForm` reference isn't available yet —
   * same lazy-binding trick as SectSceneCore's `allianceHooks`). Used by ensureRefBand's async
   * fetch callback and update()'s caret-blink tick, both of which need to rebuild the create-form
   * modal in place rather than just re-running the outer render() dispatcher.
   */
  reopenCreateForm: () => void = () => {};

  /** @param render Injected by the outer AuctionScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about every domain instance) — Core and the
   *  domain classes call `this.render()`/`core.render()` wherever the old flattened class called its
   *  own `render()` method verbatim. Does NOT auto-fire the initial loadData() — the outer assembly
   *  does that after all domain instances exist. */
  constructor(layout: ILayout, input: InputManager, cb: AuctionSceneCallbacks, readonly render: () => void) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.headerH = sceneHeaderHeight(this.h);
    this.container = new PIXI.Container();
    this.build();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));
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
  renderHeaderCurrency(): void {
    tearDownChildren(this.headerOverlayLayer);
    const coins = this.cb.getSave?.()?.wallet.coins ?? 0;
    drawHeaderCurrency(this.headerOverlayLayer, this.w, this.headerH, coins);
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  async loadData(): Promise<void> {
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
  async pollRefresh(): Promise<void> {
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

  // ── Price guardrail band (create-form reference price) ───────────────────────

  /**
   * Fetch (once per category) the price guardrail band for the given category and cache it, then re-render
   * the create form so the seller sees the acceptable range. Called from CreateListingPanel.openCreateForm
   * on every render; short-circuits when the category is already synced, so it fires exactly one request
   * per item selection.
   */
  ensureRefBand(category: string | null): void {
    if (category === this.refBandCat) return; // already loaded / loading for this category
    this.refBandCat = category;
    this.refBand = null;
    this.refBandLoading = false;
    if (category === null) return; // unguarded item (card): any price allowed
    this.refBandLoading = true;
    void this.cb.worldApi.getAuctionRefBand(category)
      .then((band) => { if (!this.destroyed && this.refBandCat === category) { this.refBand = band; this.refBandLoading = false; if (this.modalOpen) this.reopenCreateForm(); } })
      .catch(() => { if (!this.destroyed && this.refBandCat === category) { this.refBandLoading = false; if (this.modalOpen) this.reopenCreateForm(); } });
  }

  // ── Modal / toast primitives ────────────────────────────────────────────────
  // (addNumInput/openNumInput — the shared numeric-stepper widget bid.ts/create-listing.ts both call —
  // live in ./numInput.ts as free functions taking `core` explicitly; see that file's header comment.)

  showConfirmModal(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    this.modalHits = [];
    this.modalOpen = true;
    this.modalHits = drawConfirmDialog(ml, w, h, msg, () => onOk(), () => this.closeModal());
  }

  closeModal(): void {
    tearDownChildren(this.modalLayer);
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  errorMsg(e: unknown): string {
    if (e instanceof TimeoutError) return t('common.networkTimeout');
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
        SKIN_IN_USE:             t('auction.err.skinInUse'),
        SKIN_NOT_FOUND:          t('auction.err.closed'),
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
    if (this.bt.tick(dt)) this.render();
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.buyerActive || this.numEditKey) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; if (this.modalOpen) this.reopenCreateForm(); }
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
