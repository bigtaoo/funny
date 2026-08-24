// Shared foundation for the ShopScene composition (see ../ShopScene.ts assembly).
//
// ShopSceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.tab, this.core.items, this.core.bt, …) + the
// constructor, the layer scaffold, the shared header/tab/card/button rendering primitives, and the
// hidden-input + input/lifecycle plumbing — but NOT the render() dispatcher, which lives on the
// outer ../ShopScene.ts assembly since only it knows about both domain classes (Core takes a
// `render` callback injected at construction instead of owning render() itself). Unlike
// DefenseEditorScene, Core wires input.onDown/onMove/onUp/onWheel itself: handleDown/handleMove/
// handleUp are Core's own methods (they only ever touch `hits`/`gesture`/`scrollY`, no domain-panel
// delegation needed), so there's no two-phase-construction concern here.
//
// drawCard/drawButton (the product-card cell renderer, shared by both tabs) live in ./card.ts as
// free functions taking `core` explicitly (2026-08-11, form ① per claudedocs/client-modules.md's
// split-form priority note) purely to keep this file under the 500-line convention. The network
// actions (buy/redeem/recharge/…) live in ./actions.ts's ActionsPanel — an independent class over
// `core` with no dependency on either tab, referenced by both tabs through the narrow ActionHandlers
// interface it already implements 1:1 (2026-08-11: converted from the former `XMixin(Base)`
// inheritance chain — the upward calls this used to reach via interface declaration merging are now
// explicit constructor params/callbacks instead, see claudedocs/client-modules.md's split-form
// priority note).
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import type { ShopItem } from '../../net/ApiClient';
import { ui as C, buildPaperBackground, marginLineX } from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { type IconKind } from '../../render/icons';
import { type MaterialKind } from '../../render/atlas/materialAtlas';
import { drawSceneHeader, drawHeaderCurrency, headerCurrencyWidth, sceneHeaderHeight, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';

/** Outcome of a buy — ok, or a message key to surface as a toast. */
export type ShopActionResult =
  | { ok: true; coins?: number }
  | { ok: false; key: TranslationKey };

export interface ShopSceneCallbacks {
  onBack(): void;
  /** Current server-authoritative coin balance (read from SaveData). */
  getCoins(): number;
  /**
   * Subscribe to SaveManager writes (SaveManager.subscribe) — re-renders this scene when another
   * concurrently-mounted scene (e.g. this Shop overlay's peer or a sibling tab) changes the wallet.
   * Returns an unsubscribe function; caller must push it onto `unsubs` and let destroy() call it.
   */
  onSaveChanged?(listener: () => void): () => void;
  /** Owned skin ids (to mark already-purchased items). */
  getOwnedSkins(): string[];
  loadItems(): Promise<ShopItem[]>;
  /** `qty` (bulk-buy, e.g. onBuyBulk's "×10" button) charges/delivers several units in one request. */
  buy(itemId: string, qty?: number): Promise<ShopActionResult>;
  /** Dev-only virtual top-up. Not rendered in production; exposed for E2E tests. */
  recharge?(code: string): Promise<ShopActionResult>;
  /** Promo-code redemption (B-PROMO). Absent = row not shown (offline / not logged in). */
  redeemPromo?(code: string): Promise<ShopActionResult>;
  openGacha(): void;
  /**
   * Battle Pass entry point (LOBBY_IA_REDESIGN §3: paid main axis merged into the "shop" tab,
   * no banner on the home screen). Only provided when logged in and online; absent = button not drawn.
   * Tapping navigates to BattlePassScene (back returns to the shop).
   */
  openBattlePass?(): void;
  /** Whether the BattlePass peer tab has a claimable level reward at the current XP (mirrors GachaScene's own peer-tab badges, LOBBY_IA_REDESIGN P1.5). */
  getBattlePassBadge?(): boolean;
  /** Cumulative recharge milestone entry point (GACHA_DESIGN §13, ADR-045). Only provided when logged in online; absent = tab not drawn. */
  openRecharge?(): void;
  /** Whether the Recharge peer tab has a claimable milestone reward at the current cumulative spend. */
  getRechargeBadge?(): boolean;
  /**
   * Initiate a Paddle coin-recharge checkout for the given tier ID (e.g. 't499').
   * Implementation calls /shop/paddle/checkout to get a transactionId, then opens Paddle.js.
   * Absent = Coins tab not shown (offline / not on web platform).
   */
  rechargeCoins?(tierId: string): Promise<ShopActionResult>;
  // ── Monetization deals (GACHA_DESIGN §5–§6). All optional; absent = section not shown (offline / not logged in). ──
  /** Monthly/year card + starter state (subscription end ms, purchased one-off product ids). */
  getMonetization?(): {
    subscriptionExpiry: number;
    subscriptionLastClaimDay?: string;
    starterUsed: string[];
    starterGrowthEligible?: boolean;
    firstPurchaseUsed?: boolean;
  };
  buyMonthlyCard?(): Promise<ShopActionResult>;
  /** Buy the year card (365-day subscription). Absent = year card not shown. */
  buyYearCard?(): Promise<ShopActionResult>;
  claimMonthlyCard?(): Promise<ShopActionResult>;
  buyStarter?(productId: 'starter_draw' | 'starter_growth'): Promise<ShopActionResult>;
  /** Tab to open on (defaults to 'shop'). 'coins' is only honored when rechargeCoins is provided. */
  initialTab?: 'shop' | 'coins';
}

export interface Hit { rect: Rect; fn: () => void; }

/** One action button inside a product card. */
export interface BtnSpec { label: string; enabled: boolean; primary: boolean; fn?: () => void; }

/** Declarative spec for one product card cell; drawCard() lays it out uniformly. */
export interface CardSpec {
  icon: IconKind;
  iconColor: number;
  /**
   * Real art texture URL, drawn instead of the vector `icon` glyph when set (placeholder skin
   * art borrows the base unit's card PNG — see ShopPanel.buildShopCards skin section).
   */
  artUrl?: string;
  /**
   * Crafting-material bitmap (scrap/lead/binding), drawn instead of `icon` when set — takes
   * precedence over `icon` but not `artUrl`. Materials must go through buildMaterialIcon (not the
   * generic buildCoinIcon→buildIcon procedural-glyph fallback) so they match the AI bitmap art
   * already used everywhere else materials appear (equipment page, gacha reveal/odds, daily/event/
   * battle-pass reward rows) — see materialAtlas.ts's doc comment.
   */
  materialKind?: MaterialKind;
  title: string;
  /** Prominent gold coin amount (coin glyph + number), shown under the title (skins / coin tiers). */
  coinAmount?: number;
  /** USD price in cents (subscription cards / starter packs). strike = original list price, line-through. */
  usdCents?: number;
  usdStrikeCents?: number;
  /** Small stacked info lines beside the icon (status / bonus / badges). */
  lines?: { text: string; color: number }[];
  /** Top-right corner badge (savings / best value). */
  badge?: { text: string; color: number };
  /** Gold panel highlight (featured / best value). */
  highlight?: boolean;
  /** Ink-stamp overlay on the art image, angled like GachaScene's "NEW" stamp (monthly-card expiring-soon state). */
  expiringSoonStamp?: boolean;
  buttons: BtnSpec[];
}

export class ShopSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly landscape: boolean;
  readonly cb: ShopSceneCallbacks;

  items: ShopItem[] | null = null;
  loading = true;
  readonly bt = new BusyTracker();
  tab: 'shop' | 'coins';

  hits: Hit[] = [];
  /** URLs whose texture-load re-render has already been hooked (mirrors CardScene.drawArtFit). */
  readonly artHooked = new Set<string>();
  readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async re-render can't paint into a torn-down container. */
  destroyed = false;

  // ── Scroll state (grid may overflow the body region) ──────────────────────
  scrollY = 0;
  /** Max scrollY for whichever tab (shop/coins) is currently active — set by that tab's own grid
   *  renderer alongside its clamp of scrollY, so the wheel handler below can read it without
   *  recomputing the grid layout. */
  maxScroll = 0;
  /** This render's body mask, sized per-tab by {@link maskBody} once its grid's peek-adjusted viewH is known. */
  bodyMask: PIXI.Graphics | null = null;
  /** Vertical bounds of the body mask set by {@link maskBody} — reused by the wheel handler to gate
   *  scroll to the visible list region. */
  private regionTop = 0;
  private regionBottom = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a cell's hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a shop card scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;

  // ── Promo-code state ──────────────────────────────────────────────────────
  promoCode = '';
  promoFocused = false;
  /** Hidden DOM input capturing keystrokes for promo-code entry (null on non-DOM platforms). */
  hiddenInput: HTMLInputElement | null = null;

  /** @param render Injected by the outer ShopScene assembly (which owns the actual render
   *  dispatcher, since it's the only thing that knows about both tab-domain classes) — Core calls
   *  `this.render()` wherever the old flattened class called its own `render()` method verbatim. */
  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks, readonly render: () => void) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.tab = cb.initialTab === 'coins' && cb.rechargeCoins ? 'coins' : 'shop';
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      const next = wheelScrollY(this.regionTop, this.regionBottom, y, deltaY, this.scrollY, this.maxScroll);
      if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
    }));
    if (cb.redeemPromo) this.setupHiddenInput();
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
    this.container.destroy({ children: true });
  }

  // ── Hidden input (promo-code text capture) ────────────────────────────────

  private setupHiddenInput(): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('input');
    el.type = 'text';
    el.autocomplete = 'off';
    el.setAttribute('autocapitalize', 'characters');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('spellcheck', 'false');
    Object.assign(el.style, {
      position: 'absolute', left: '-9999px', top: '-9999px',
      opacity: '0', width: '1px', height: '1px',
    });
    el.addEventListener('input', () => {
      this.promoCode = el.value.toUpperCase();
      el.value = this.promoCode;
      this.render();
    });
    el.addEventListener('blur', () => {
      this.promoFocused = false;
      this.render();
    });
    el.addEventListener('focus', () => {
      this.promoFocused = true;
      this.render();
    });
    // Enter-to-redeem is wired by the outer assembly, not here: it calls ActionsPanel.onRedeem(),
    // which doesn't exist yet at Core-construction time — see ../ShopScene.ts.
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  focusPromo(): void {
    this.promoFocused = true;
    if (this.hiddenInput) {
      this.hiddenInput.value = this.promoCode;
      this.hiddenInput.focus();
    }
    this.render();
  }

  blurPromo(): void {
    this.promoFocused = false;
    this.hiddenInput?.blur();
    this.render();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    // Capture the hit action and defer it to pointer-up — if the pointer drags past the threshold
    // it becomes a scroll and the tap is dropped, so a drag starting on a shop card scrolls the
    // list instead of instantly firing that card.
    let hit: (() => void) | null = null;
    for (const h of this.hits) {
      const r = h.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit = h.fn; break; }
    }
    // No hit — blur the promo field if it was focused (matches the old miss-only behaviour).
    if (!hit && this.promoFocused) this.blurPromo();
    this.gesture.down(this.scrollY, y, hit);
  }

  private handleMove(y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll !== null) { this.scrollY = scroll; this.scrollDirty = true; }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  // ── Render helpers (shared by both tabs) ───────────────────────────────────

  /** Size this render's body mask to `top..top+viewH` — called by each grid method once it knows its
   *  own peek-adjusted viewH, so the clip line (and the deliberate partial-row peek above it) is exact. */
  maskBody(top: number, viewH: number): void {
    this.bodyMask?.clear().beginFill(0xffffff).drawRect(0, top, this.w, viewH).endFill();
    this.regionTop = top;
    this.regionBottom = top + viewH;
  }

  drawBackground(): void {
    // Landscape: the notebook's red margin rule is repositioned to the rail's actual edge
    // (sidebarNavW) instead of the classic 9%-of-width line, which used to cut through the middle
    // of this scene's (wider) rail. Portrait has no left-edge rail at all now (the group nav is a
    // bottom bar, §18), so it keeps the legacy line (railX undefined → default).
    const railX = this.landscape ? sidebarNavW(this.w, this.h, true) : undefined;
    this.container.addChild(buildPaperBackground('shopbg', this.w, this.h, { railX }));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  /** Header bar with title, back, and coin balance. Returns its height. */
  drawHeader(): number {
    const { w, h } = this;
    // Reserve the coin readout's real width before the title is laid out, so a centred title cannot
    // run under it on a narrow portrait bar (2026-08-24). Drawn right after the header, so the
    // measurement is always current and drawHeaderCurrency's own fit backstop never has to engage.
    const coins = this.cb.getCoins();
    const hdr = drawSceneHeader(this.container, w, h, t('shop.title'), {
      accent: HEADER_ACCENT.spend, icon: 'shopTabIcon',
      rightReserve: headerCurrencyWidth(sceneHeaderHeight(h), coins),
    });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): shared header readout so it reads identically across every scene.
    drawHeaderCurrency(this.container, w, tbH, coins, [], undefined, 1, hdr.titleRight);

    return tbH;
  }

  /**
   * Shop group nav (LOBBY_IA_REDESIGN P1.5): [Shop|Coins|Gacha|BattlePass]. Landscape draws it as a
   * vertical rail stacked in the left rail (`sidebarNavW`), below the header — same convention as
   * CardScene/EquipmentScene's sidebar nav. Portrait draws it as a bottom nav bar instead (§18).
   * Coins tab only appears when rechargeCoins is provided (logged in, web platform); BattlePass tab
   * only when openBattlePass is provided. Returns the body start y (just the header height — neither
   * the rail nor the bottom bar occupies space at the top).
   */
  drawGroupTabs(tbH: number): number {
    const { w, h, landscape } = this;
    const showCoins = !!this.cb.rechargeCoins;

    const { active, claimedToday } = this.monthlyCardStatus();
    const monthlyClaimable = !!this.cb.claimMonthlyCard && active && !claimedToday;

    const tabs: HubTab[] = [
      { label: t('shop.title'), active: this.tab === 'shop', icon: 'shopTabIcon', badge: monthlyClaimable },
    ];
    if (showCoins) tabs.push({ label: t('shop.coinsTab'), active: this.tab === 'coins', icon: 'coinTabIcon' });
    tabs.push({ label: t('gacha.title'), active: false, icon: 'gachaTabIcon' });
    const actions: Array<() => void> = [() => this.cb.openGacha()];
    if (this.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'battlepassTabIcon', badge: this.cb.getBattlePassBadge?.() ?? false });
      actions.push(() => this.cb.openBattlePass?.());
    }
    if (this.cb.openRecharge) {
      tabs.push({ label: t('recharge.title'), active: false, icon: 'rechargeTabIcon', badge: this.cb.getRechargeBadge?.() ?? false });
      actions.push(() => this.cb.openRecharge?.());
    }

    const switchTab = (tab: 'shop' | 'coins') => { this.tab = tab; this.scrollY = 0; this.render(); };
    // Fixed [Shop, Coins?] leading tabs switch locally; the rest (Gacha/BattlePass?/Recharge?) dispatch via `actions`.
    const fixedCount = showCoins ? 2 : 1;
    const onSelect = (i: number): void => {
      if (i === 0) { switchTab('shop'); return; }
      if (showCoins && i === 1) { switchTab('coins'); return; }
      actions[i - fixedCount]?.();
    };
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(this.container, w, h - barH, barH, tabs, onSelect);
      this.hits.push(...hits);
      return tbH;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, onSelect);
    this.hits.push(...hits);
    return tbH;
  }

  /** Monthly/year card status derived from the mirrored monetization save (shared by the sidebar badge and the card itself). */
  monthlyCardStatus(): { active: boolean; claimedToday: boolean; expiringSoon: boolean } {
    const mon = this.cb.getMonetization?.() ?? { subscriptionExpiry: 0, starterUsed: [] };
    const active = mon.subscriptionExpiry > Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);
    const claimedToday = active && mon.subscriptionLastClaimDay === todayKey;
    // 3-day lead window, mirroring platform/localReminders.ts's EXPIRY_LEAD_MS (the push/toast
    // reminder fires on the same threshold) — duplicated here rather than imported so this
    // pure-render scene layer stays free of the Capacitor-touching platform module.
    const expiringSoon = active && mon.subscriptionExpiry - Date.now() <= 3 * 24 * 60 * 60 * 1000;
    return { active, claimedToday, expiringSoon };
  }

  // ── Grid layout ────────────────────────────────────────────────────────────

  /**
   * Responsive column count + cell size for the image-dominant vertical product cards (big square art
   * up top, then title / price / action button(s) stacked below). Narrower target than the old wide
   * text-row card so several icon-cards sit per row (mirrors the roster/gacha card grids); cellH is
   * derived from cellW to keep a consistent portrait aspect.
   */
  gridMetrics(): { listX: number; listW: number; gap: number; cols: number; cellW: number; cellH: number } {
    const { w, h, landscape } = this;
    const gap = Math.round(w * 0.015);
    // Portrait's group nav is a bottom bar instead of a left rail (§18) — no width reservation.
    const listX = (landscape ? sidebarNavW(w, h, true) : marginLineX(w)) + gap;
    const listW = w - listX - Math.round(w * 0.04);
    // Both orientations pack ~3 across: wider cards keep product titles (e.g. "Monthly Card",
    // "Skin · …") on one line so the price row below can't get pushed down onto the bottom buttons.
    const targetW = Math.round(w * (landscape ? 0.24 : 0.30));
    const cols = Math.max(1, Math.floor((listW + gap) / (targetW + gap)));
    const cellW = Math.round((listW - gap * (cols - 1)) / cols);
    // Cap the 1.5x portrait aspect against the *height* budget, not just derived from width: on a
    // wide-but-vertically-short landscape window (LandscapeLayout grows designWidth to match the
    // safe-area aspect while designHeight stays pinned, see ILayout), cellW keeps growing with the
    // widened design width with nothing to check it, so an uncapped cellH can grow to rival the whole
    // scrollable viewport height — leaving no room for scrollPeek's guaranteed next-row peek (or, at
    // the extreme, clipping the row's own buttons). h * 0.6 keeps at least ~2 rows' worth of headroom
    // below the body's ~0.84h viewport at any aspect.
    const cellH = Math.min(Math.round(cellW * 1.5), Math.round(h * 0.6));
    return { listX, listW, gap, cols, cellW, cellH };
  }
}
