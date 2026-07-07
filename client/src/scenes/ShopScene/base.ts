// Shared foundation for the ShopScene mixin chain (see ../ShopScene.ts assembly).
//
// ShopSceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.bt, this.items, this.tab, …) + the constructor, the layer
// scaffold, the render dispatcher, the shared card/button/toast primitives, and the hidden-input +
// input/lifecycle plumbing. Each domain (shop tab / coins tab / network actions) lives in its own
// sibling file as `XMixin(Base)` and is chained into the final ShopScene.
//
// ── ShopScene (S2-6 + B-PROMO) — direct-purchase shop ────────────────────────
//
// Canvas-drawn (mirrors LoginScene/RoomScene): a render()-on-change tree with a flat hit-list. The economy is
// server-authoritative — every buy returns a fresh SaveData that the app adopts; this scene only reads the current
// wallet via getCoins() and re-renders. Gacha lives in its own scene, reached via the capsule tab.
//
// Layout: products are icon-cards laid out in a responsive grid (mirrors CardScene/EquipmentScene). The group nav
// [Shop|Coins|Gacha|BattlePass] is a vertical rail in the left notebook-margin gutter (marginLineX), so the grid
// starts to its right and scrolls (drag) inside a masked body region while the header + rail stay fixed. Subscription
// cards (monthly / year) are globally single-slot: while any card is active, both Buy buttons read "生效中" and are
// disabled (server enforces the same via ALREADY_ACTIVE). Promo-code redemption (B-PROMO) is a full-width row below
// the Coins tab's tier grid; text entry uses the same hidden-<input> technique as LoginScene (works on both desktop
// keyboards and mobile soft keyboards).
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import type { ShopItem } from '../../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren, marginLineX } from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { type IconKind } from '../../render/icons';
import { loadCoinIconAtlas, buildCoinIcon } from '../../render/coinIconAtlas';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, type HubTab } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';

/** Outcome of a buy — ok, or a message key to surface as a toast. */
export type ShopActionResult =
  | { ok: true; coins?: number }
  | { ok: false; key: TranslationKey };

export interface ShopSceneCallbacks {
  onBack(): void;
  /** Current server-authoritative coin balance (read from SaveData). */
  getCoins(): number;
  /** Owned skin ids (to mark already-purchased items). */
  getOwnedSkins(): string[];
  loadItems(): Promise<ShopItem[]>;
  buy(itemId: string): Promise<ShopActionResult>;
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
  /**
   * Initiate a Paddle coin-recharge checkout for the given tier ID (e.g. 't499').
   * Implementation calls /shop/paddle/checkout to get a transactionId, then opens Paddle.js.
   * Absent = Coins tab not shown (offline / not on web platform).
   */
  rechargeCoins?(tierId: string): Promise<ShopActionResult>;
  // ── Monetization deals (GACHA_DESIGN §5–§6). All optional; absent = section not shown (offline / not logged in). ──
  /** Monthly/year card + starter state (subscription end ms, purchased one-off product ids). */
  getMonetization?(): { subscriptionExpiry: number; subscriptionLastClaimDay?: string; starterUsed: string[] };
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
  title: string;
  /** Prominent gold coin amount (coin glyph + number), shown under the title (skins / coin tiers). */
  coinAmount?: number;
  /** Yuan price (subscription cards). strike = original list price rendered with a line through it. */
  yuanPrice?: number;
  yuanStrike?: number;
  /** Small stacked info lines beside the icon (status / bonus / badges). */
  lines?: { text: string; color: number }[];
  /** Top-right corner badge (savings / best value). */
  badge?: { text: string; color: number };
  /** Gold panel highlight (featured / best value). */
  highlight?: boolean;
  buttons: BtnSpec[];
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type ShopSceneBaseCtor = Constructor<ShopSceneBase>;

export class ShopSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly cb: ShopSceneCallbacks;

  protected items: ShopItem[] | null = null;
  protected loading = true;
  protected readonly bt = new BusyTracker();
  protected tab: 'shop' | 'coins';

  /** Transient toast message (success / error), cleared on next action. */
  protected toast: { text: string; color: number } | null = null;

  protected hits: Hit[] = [];
  protected readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async re-render can't paint into a torn-down container. */
  protected destroyed = false;

  // ── Scroll state (grid may overflow the body region) ──────────────────────
  protected scrollY = 0;
  protected dragStart: { y: number; scroll: number } | null = null;

  // ── Promo-code state ──────────────────────────────────────────────────────
  protected promoCode = '';
  protected promoFocused = false;
  /** Hidden DOM input capturing keystrokes for promo-code entry (null on non-DOM platforms). */
  protected hiddenInput: HTMLInputElement | null = null;

  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.tab = cb.initialTab === 'coins' && cb.rechargeCoins ? 'coins' : 'shop';
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    if (cb.redeemPromo) this.setupHiddenInput();
    this.render();
    void this.loadItems();
    loadCoinIconAtlas()
      .catch((err) => console.warn('[ShopScene] coin icon atlas load failed:', err))
      .then(() => this.render());
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  update(dt: number): void {
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
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.onRedeem(); }
    });
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  protected focusPromo(): void {
    this.promoFocused = true;
    if (this.hiddenInput) {
      this.hiddenInput.value = this.promoCode;
      this.hiddenInput.focus();
    }
    this.render();
  }

  protected blurPromo(): void {
    this.promoFocused = false;
    this.hiddenInput?.blur();
    this.render();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
    // No hit — begin a drag-scroll (and blur the promo field if it was focused).
    if (this.promoFocused) this.blurPromo();
    this.dragStart = { y, scroll: this.scrollY };
  }

  private handleMove(y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container); // free Text textures on each rebuild
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    const top = this.drawGroupTabs(tbH);

    // Body grid lives in a masked layer so overscrolled cells never bleed into the fixed header / tab strip.
    const body = new PIXI.Container();
    this.container.addChild(body);
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, top, this.w, this.h - top).endFill();
    this.container.addChild(mask);
    body.mask = mask;

    if (this.tab === 'coins') {
      this.drawCoinsGrid(body, top);
    } else {
      this.drawShopGrid(body, top);
    }

    if (this.toast) this.drawToast();
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('shopbg', this.w, this.h));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  /** Header bar with title, back, and coin balance. Returns its height. */
  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('shop.title'), { accent: HEADER_ACCENT.spend });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): shared header readout so it reads identically across every scene.
    drawHeaderCurrency(this.container, w, tbH, this.cb.getCoins());

    return tbH;
  }

  /**
   * Shop group nav (LOBBY_IA_REDESIGN P1.5): [Shop|Coins|Gacha|BattlePass] as a vertical rail
   * stacked in the left notebook-margin gutter (`marginLineX`), below the header — same convention
   * as CardScene/EquipmentScene's sidebar nav. Coins tab only appears when rechargeCoins is provided
   * (logged in, web platform); BattlePass tab only when openBattlePass is provided. Returns the body
   * start y (just the header height — the rail occupies width, not height).
   */
  private drawGroupTabs(tbH: number): number {
    const { w, h } = this;
    const sidebarW = marginLineX(w);
    const showCoins = !!this.cb.rechargeCoins;

    const tabs: HubTab[] = [
      { label: t('shop.title'), active: this.tab === 'shop', icon: 'tag' },
    ];
    if (showCoins) tabs.push({ label: t('shop.coinsTab'), active: this.tab === 'coins', icon: 'coin' });
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    if (this.cb.openBattlePass) tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy' });

    const switchTab = (tab: 'shop' | 'coins') => { this.tab = tab; this.scrollY = 0; this.render(); };
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, (i) => {
      if (!showCoins) {
        if (i === 1) this.cb.openGacha();
        else if (i === 2) this.cb.openBattlePass?.();
        return;
      }
      if (i === 0) switchTab('shop');
      else if (i === 1) switchTab('coins');
      else if (i === 2) this.cb.openGacha();
      else if (i === 3) this.cb.openBattlePass?.();
    });
    this.hits.push(...hits);
    return tbH;
  }

  // ── Grid layout ────────────────────────────────────────────────────────────

  /** Responsive column count + cell width for the product grid (mirrors CardScene/EquipmentScene). */
  protected gridMetrics(): { listX: number; listW: number; gap: number; cols: number; cellW: number; cellH: number } {
    const { w, h } = this;
    const gap = Math.round(w * 0.015);
    const listX = marginLineX(w) + gap;
    const listW = w - listX - Math.round(w * 0.04);
    const targetW = Math.round(w * 0.30);
    const cols = Math.max(1, Math.floor((listW + gap) / (targetW + gap)));
    const cellW = Math.round((listW - gap * (cols - 1)) / cols);
    const cellH = Math.round(h * 0.27);
    return { listX, listW, gap, cols, cellW, cellH };
  }

  // ── Card cell ────────────────────────────────────────────────────────────

  /** Draw one product card: name across the top, icon on the left, price/info on the right, action button(s) at the bottom. */
  protected drawCard(body: PIXI.Container, spec: CardSpec, x: number, y: number, cw: number, ch: number): void {
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

    // Right-side column: badge + price, right-aligned and never wrapped.
    const hasRightInfo = !!(spec.badge || spec.coinAmount !== undefined || spec.yuanPrice !== undefined);
    const rightColW = hasRightInfo ? Math.round(cw * 0.40) : 0;
    const rightGap = hasRightInfo ? Math.round(cw * 0.03) : 0;
    const rightX = x + cw - pad;
    let ry = y + pad;

    if (spec.badge) {
      const badge = txt(spec.badge.text, Math.round(ch * 0.11), spec.badge.color, true);
      badge.anchor.set(1, 0); badge.x = rightX; badge.y = ry;
      body.addChild(badge);
      ry += badge.height + Math.round(ch * 0.03);
    }

    if (spec.coinAmount !== undefined) {
      const cs = Math.round(ch * 0.20);
      const amt = txt(spec.coinAmount.toLocaleString(), Math.round(ch * 0.20), C.gold, true);
      amt.anchor.set(1, 0); amt.x = rightX; amt.y = ry;
      body.addChild(amt);
      const ci = buildCoinIcon('coin', cs, C.gold);
      ci.x = rightX - amt.width - Math.round(cw * 0.02) - cs; ci.y = ry + (amt.height - cs) / 2;
      body.addChild(ci);
      ry += Math.max(amt.height, cs) + Math.round(ch * 0.03);
    }

    if (spec.yuanPrice !== undefined) {
      const price = txt(`¥${spec.yuanPrice}`, Math.round(ch * 0.18), C.gold, true);
      price.anchor.set(1, 0); price.x = rightX; price.y = ry;
      body.addChild(price);
      if (spec.yuanStrike !== undefined) {
        const strike = txt(`¥${spec.yuanStrike}`, Math.round(ch * 0.12), C.mid, false);
        strike.anchor.set(1, 0.5);
        strike.x = price.x - price.width - Math.round(cw * 0.03);
        strike.y = ry + price.height / 2;
        body.addChild(strike);
        const line = new PIXI.Graphics();
        line.lineStyle(2, C.mid, 1);
        line.moveTo(strike.x - strike.width, strike.y).lineTo(strike.x, strike.y);
        body.addChild(line);
      }
      ry += price.height + Math.round(ch * 0.03);
    }

    // Title (left; wraps to multiple lines rather than crowding the price column).
    const titleMaxW = cw - pad * 2 - rightColW - rightGap;
    const title = txt(spec.title, Math.round(ch * 0.15), C.dark, true, titleMaxW);
    title.anchor.set(0, 0);
    title.x = x + pad; title.y = y + pad;
    body.addChild(title);

    // Action buttons at the bottom (1 = full width, 2 = split). Reserved first so the icon/lines
    // block below can be clamped to whatever room is left above it — never overlap the buttons.
    const btnH = Math.round(ch * 0.22);
    const btnY = y + ch - pad - btnH;

    // Icon + info block: fills the gap between the top content (title / right column) and the
    // button row. Sized from that actual gap rather than fixed ch fractions, so it can never
    // spill into the buttons regardless of how many bonus lines a card has.
    const midTop = Math.max(y + Math.round(ch * 0.30), title.y + title.height + Math.round(ch * 0.04));
    const midBottom = btnY - Math.round(ch * 0.02);
    const midH = Math.max(0, midBottom - midTop);

    const iconS = Math.min(Math.round(ch * 0.32), midH || Math.round(ch * 0.32));
    const iconX = x + pad;
    const iconY = midTop;
    const icon = buildCoinIcon(spec.icon, iconS, spec.iconColor);
    icon.x = iconX; icon.y = iconY;
    body.addChild(icon);

    // Info column (right of the icon) — remaining status/bonus lines only.
    const infoX = iconX + iconS + Math.round(cw * 0.05);
    const lines = spec.lines ?? [];
    if (lines.length > 0 && midH > 0) {
      const lineH = Math.min(Math.round(ch * 0.14), Math.floor(midH / lines.length));
      const fontSize = Math.max(9, Math.round(lineH * 0.78));
      let iy = midTop;
      for (const ln of lines) {
        const l = txt(ln.text, fontSize, ln.color, true);
        l.anchor.set(0, 0); l.x = infoX; l.y = iy;
        body.addChild(l);
        iy += lineH;
      }
    }
    const n = spec.buttons.length;
    const totalW = cw - pad * 2;
    const bGap = Math.round(cw * 0.03);
    const bw = n > 1 ? Math.round((totalW - bGap * (n - 1)) / n) : totalW;
    spec.buttons.forEach((b, i) => {
      const bx = x + pad + i * (bw + bGap);
      this.drawButton(body, b, bx, btnY, bw, btnH);
    });
  }

  protected drawButton(body: PIXI.Container, b: BtnSpec, x: number, y: number, w: number, h: number): void {
    const btn = sketchPanel(w, h, {
      fill: b.enabled ? C.dark : C.btnOff,
      border: b.enabled ? (b.primary ? C.green : C.accent) : C.light,
      width: 2, seed: seedFor(x, y, w),
    });
    btn.x = x; btn.y = y;
    body.addChild(btn);
    const lbl = txt(b.label, Math.round(h * 0.42), b.enabled ? 0xffffff : C.mid, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + w / 2; lbl.y = y + h / 2;
    body.addChild(lbl);
    if (b.enabled && b.fn) this.hits.push({ rect: { x, y, w, h }, fn: b.fn });
  }

  private drawToast(): void {
    const { w, h } = this;
    const toast = this.toast!;
    const lbl = txt(toast.text, Math.round(h * 0.026), 0xffffff, true);
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.012);
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.80);
    const bg = sketchPanel(bw, bh, { fill: toast.color, fillAlpha: 0.95, border: toast.color, width: 2, seed: seedFor(bw, bh, 2) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    this.container.addChild(lbl);
  }
}

// ── Domain entrypoints dispatched to from base-level code (constructor / render) and across sibling
// mixins (shop → actions; coins → actions). Declared via interface/class declaration merging so
// base-level `this.render()` → `this.drawShopGrid()` etc. type-check as METHODS (not properties, which
// would clash with the mixin override — TS2425). Emits NOTHING at runtime, so the real prototype
// methods provided by the mixins run and all method bodies stay verbatim.
export interface ShopSceneBase {
  loadItems(): Promise<void>;
  onBuy(itemId: string): Promise<void>;
  onRedeem(): Promise<void>;
  onRecharge(tierId: string): Promise<void>;
  runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey): Promise<void>;
  drawShopGrid(body: PIXI.Container, top: number): void;
  drawCoinsGrid(body: PIXI.Container, top: number): void;
}
