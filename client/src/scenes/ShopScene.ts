import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { ShopItem } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren, marginLineX } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { buildIcon, type IconKind } from '../render/icons';
import { loadCoinIconAtlas, getCoinIconTexture } from '../render/coinIconAtlas';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';

interface CoinTierDef {
  id: string;
  usdCents: number;
  coins: number;
  base: number;
  bestValue?: boolean;
}

// Web-only tiers ($4.99–$99.99, matching ECONOMY_BALANCE.md §2.2 USD table).
const WEB_COIN_TIERS: CoinTierDef[] = [
  { id: 't499',  usdCents:  499, base:  500, coins:   550 },
  { id: 't999',  usdCents:  999, base: 1000, coins:  1150 },
  { id: 't1999', usdCents: 1999, base: 2000, coins:  2400, bestValue: true },
  { id: 't4999', usdCents: 4999, base: 5000, coins:  6500 },
  { id: 't9999', usdCents: 9999, base: 10000, coins: 13500 },
];

// Per-tier treasure glyph — escalating gold so bigger tiers read richer (ascending order).
const COIN_TIER_ICONS: IconKind[] = ['coin', 'coins', 'coinStack', 'coinSack', 'coinChest'];

// The subset of IconKind with AI bitmap art in assets/shop/coins.{png,json} (coinIconAtlas.ts).
const AI_COIN_ICONS = new Set<IconKind>(COIN_TIER_ICONS);

// Subscription-card display prices (¥). Mirror of @nw/shared MONTHLY/YEAR_CARD_PRICE_YUAN — the real IAP charge is
// server-authorized (no coins debited); these drive the strike-through + savings badge only. Year = 12×¥30 (¥360) at ~9折 → ¥298.
const MONTHLY_CARD_YUAN = 30;
const YEAR_CARD_YUAN = 298;
const YEAR_CARD_LIST_YUAN = 360;

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

interface Hit { rect: Rect; fn: () => void; }

/** One action button inside a product card. */
interface BtnSpec { label: string; enabled: boolean; primary: boolean; fn?: () => void; }

/** Declarative spec for one product card cell; drawCard() lays it out uniformly. */
interface CardSpec {
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

export class ShopScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: ShopSceneCallbacks;

  private items: ShopItem[] | null = null;
  private loading = true;
  private readonly bt = new BusyTracker();
  private tab: 'shop' | 'coins';

  /** Transient toast message (success / error), cleared on next action. */
  private toast: { text: string; color: number } | null = null;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  // ── Scroll state (grid may overflow the body region) ──────────────────────
  private scrollY = 0;
  private dragStart: { y: number; scroll: number } | null = null;

  // ── Promo-code state ──────────────────────────────────────────────────────
  private promoCode = '';
  private promoFocused = false;
  /** Hidden DOM input capturing keystrokes for promo-code entry (null on non-DOM platforms). */
  private hiddenInput: HTMLInputElement | null = null;

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

  /**
   * Coin-tier icon: the AI bitmap sprite once assets/shop/coins.png is loaded
   * (revenue-critical recharge page, upgraded from the procedural glyph —
   * see chat 2026-07-05), falling back to the procedural `buildIcon` glyph
   * for any other icon kind or while the atlas is still loading.
   */
  private coinIcon(kind: IconKind, size: number, color: number): PIXI.DisplayObject {
    const tex = AI_COIN_ICONS.has(kind) ? getCoinIconTexture(kind) : null;
    if (tex) {
      const sprite = new PIXI.Sprite(tex);
      sprite.width = size;
      sprite.height = size;
      return sprite;
    }
    return buildIcon(kind, size, color);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
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

  private focusPromo(): void {
    this.promoFocused = true;
    if (this.hiddenInput) {
      this.hiddenInput.value = this.promoCode;
      this.hiddenInput.focus();
    }
    this.render();
  }

  private blurPromo(): void {
    this.promoFocused = false;
    this.hiddenInput?.blur();
    this.render();
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  private async loadItems(): Promise<void> {
    try {
      this.items = await this.cb.loadItems();
    } catch {
      // On load failure don't pretend the shop is empty: surface a clear error to the player (go back and re-enter to retry).
      this.items = [];
      this.toast = { text: t('common.networkError'), color: C.red };
    }
    this.loading = false;
    this.render();
  }

  // ── Buy ───────────────────────────────────────────────────────────────────

  private async onBuy(itemId: string): Promise<void> {
    if (this.bt.busy) return;
    this.blurPromo();
    this.bt.start();
    this.toast = null;
    this.render();
    try {
      const res = await withTimeout(this.cb.buy(itemId));
      this.toast = res.ok
        ? { text: t('shop.bought'), color: C.green }
        : { text: t(res.key), color: C.red };
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Promo redemption ──────────────────────────────────────────────────────

  private async onRedeem(): Promise<void> {
    if (this.bt.busy || !this.cb.redeemPromo) return;
    const code = this.promoCode.trim();
    if (!code) return;
    this.blurPromo();
    this.bt.start();
    this.toast = null;
    this.render();
    try {
      const res = await withTimeout(this.cb.redeemPromo(code));
      if (res.ok) {
        this.promoCode = '';
        if (this.hiddenInput) this.hiddenInput.value = '';
        this.toast = { text: t('shop.promoSuccess'), color: C.green };
      } else {
        this.toast = { text: t(res.key), color: C.red };
      }
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.promoError'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Recharge ─────────────────────────────────────────────────────────────

  private async onRecharge(tierId: string): Promise<void> {
    if (this.bt.busy || !this.cb.rechargeCoins) return;
    this.blurPromo();
    this.bt.start();
    this.toast = null;
    this.render();
    // No blanket withTimeout here (unlike buy/redeem): recharge opens a user-paced payment UI
    // (Paddle overlay / native store sheet) that may stay open for minutes. The callback bounds its
    // own network calls internally and always resolves with a result key, so the spinner still clears.
    try {
      const res = await this.cb.rechargeCoins(tierId);
      this.toast = res.ok
        ? { text: t('shop.rechargeSuccess'), color: C.green }
        : { text: t(res.key), color: C.red };
    } catch {
      this.toast = { text: t('shop.rechargeError'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Monetization deals (monthly / year card, starter packs) ────────────────

  private async runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey): Promise<void> {
    if (this.bt.busy) return;
    this.blurPromo();
    this.bt.start();
    this.toast = null;
    this.render();
    try {
      const res = await withTimeout(action());
      this.toast = res.ok ? { text: t(okKey), color: C.green } : { text: t(res.key), color: C.red };
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
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

  private render(): void {
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
    const hdr = drawSceneHeader(this.container, w, h, t('shop.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): coin glyph + number, no "金币：" text prefix — the icon is the unit.
    const balNum = txt(this.cb.getCoins().toLocaleString(), Math.round(h * 0.028), C.gold, true);
    balNum.anchor.set(1, 0.5); balNum.x = w - Math.round(w * 0.04); balNum.y = tbH / 2;
    this.container.addChild(balNum);
    const balIcon = Math.round(h * 0.036);
    const bIcon = this.coinIcon('coin', balIcon, C.gold);
    bIcon.x = balNum.x - balNum.width - balIcon - Math.round(w * 0.008);
    bIcon.y = tbH / 2 - balIcon / 2;
    this.container.addChild(bIcon);

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
  private gridMetrics(): { listX: number; listW: number; gap: number; cols: number; cellW: number; cellH: number } {
    const { w, h } = this;
    const gap = Math.round(w * 0.015);
    const listX = marginLineX(w) + gap;
    const listW = w - listX - Math.round(w * 0.04);
    const targetW = Math.round(w * 0.30);
    const cols = Math.max(1, Math.floor((listW + gap) / (targetW + gap)));
    const cellW = Math.round((listW - gap * (cols - 1)) / cols);
    const cellH = Math.round(h * 0.22);
    return { listX, listW, gap, cols, cellW, cellH };
  }

  /** Shop tab: monthly/year cards + starter packs + skins as an icon-card grid. */
  private drawShopGrid(body: PIXI.Container, top: number): void {
    const { w, h } = this;
    const bodyTop = top + Math.round(h * 0.02);
    const viewH = h - bodyTop - Math.round(h * 0.02);

    if (this.loading) {
      const lbl = txt(t('shop.loading'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
      body.addChild(lbl);
      return;
    }

    const specs = this.buildShopCards();
    const { listX, gap, cols, cellW, cellH } = this.gridMetrics();
    const rows = Math.ceil(specs.length / cols);
    const totalH = rows > 0 ? rows * (cellH + gap) : 0;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - viewH)));

    if (specs.length === 0) {
      const lbl = txt(t('shop.empty'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = bodyTop + Math.round(h * 0.14);
      body.addChild(lbl);
      return;
    }

    specs.forEach((spec, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = listX + col * (cellW + gap);
      const cy = bodyTop + row * (cellH + gap) - this.scrollY;
      if (cy + cellH >= top && cy <= h) this.drawCard(body, spec, cx, cy, cellW, cellH);
    });
  }

  /** Assemble the shop tab's card specs in a fixed order: monthly · year · starter packs · skins. */
  private buildShopCards(): CardSpec[] {
    const specs: CardSpec[] = [];
    const busy = this.bt.busy;
    const mon = this.cb.getMonetization?.() ?? { subscriptionExpiry: 0, starterUsed: [] };
    const active = mon.subscriptionExpiry > Date.now();
    // Whether today's daily coins were already claimed. UTC day compared to the mirrored last-claim day (server authority).
    const todayKey = new Date().toISOString().slice(0, 10);
    const claimedToday = active && mon.subscriptionLastClaimDay === todayKey;

    // Monthly card: Buy (locked while a card is active) + daily Claim.
    if (this.cb.buyMonthlyCard) {
      const buttons: BtnSpec[] = [
        active
          ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
          : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runDeal(() => this.cb.buyMonthlyCard!(), 'shop.bought') },
      ];
      if (this.cb.claimMonthlyCard) {
        // Claim greys out both when the card is inactive (not purchased) and once today's reward is taken.
        // The label itself is the clear status — no ambiguous "claimed-or-inactive" toast on tap.
        buttons.push({
          label: claimedToday ? t('shop.monthlyClaimedToday') : t('shop.monthlyClaim'),
          enabled: !busy && active && !claimedToday,
          primary: false,
          fn: () => void this.runDeal(() => this.cb.claimMonthlyCard!(), 'shop.monthlyClaimed'),
        });
      }
      specs.push({
        icon: 'coinChest', iconColor: C.gold, title: t('shop.monthlyCard'), highlight: true,
        yuanPrice: MONTHLY_CARD_YUAN,
        lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
        buttons,
      });
    }

    // Year card: 365-day, ~9折 vs 12 monthly cards. Same single-slot gate.
    if (this.cb.buyYearCard) {
      specs.push({
        icon: 'trophy', iconColor: C.gold, title: t('shop.yearCard'), highlight: true,
        yuanPrice: YEAR_CARD_YUAN, yuanStrike: YEAR_CARD_LIST_YUAN,
        badge: { text: t('shop.save', { amount: `¥${YEAR_CARD_LIST_YUAN - YEAR_CARD_YUAN}` }), color: C.green },
        lines: [{ text: active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), color: active ? C.green : C.mid }],
        buttons: [
          active
            ? { label: t('shop.monthlyActive'), enabled: false, primary: true }
            : { label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.runDeal(() => this.cb.buyYearCard!(), 'shop.bought') },
        ],
      });
    }

    // Starter packs: one card each, "已购" when already owned.
    if (this.cb.buyStarter) {
      const packs: { id: 'starter_draw' | 'starter_growth'; label: TranslationKey; icon: IconKind }[] = [
        { id: 'starter_draw', label: 'shop.starterDraw', icon: 'capsule' },
        { id: 'starter_growth', label: 'shop.starterGrowth', icon: 'gift' },
      ];
      for (const pk of packs) {
        const used = mon.starterUsed.includes(pk.id);
        specs.push({
          icon: pk.icon, iconColor: C.gold, title: t(pk.label),
          buttons: [{
            label: used ? t('shop.owned') : t('shop.buy'), enabled: !used && !busy, primary: true,
            fn: () => void this.runDeal(() => this.cb.buyStarter!(pk.id), 'shop.bought'),
          }],
        });
      }
    }

    // Skins (cosmetic → brush glyph; real skin art pending).
    if (this.items && this.items.length > 0) {
      const owned = new Set(this.cb.getOwnedSkins());
      for (const item of this.items) {
        const isOwned = owned.has(item.grants ?? item.id);
        const canBuy = !isOwned && !busy && this.cb.getCoins() >= item.cost;
        specs.push({
          icon: 'brush', iconColor: C.accent, title: `${t('shop.skinLabel')} · ${item.id}`,
          coinAmount: item.cost,
          buttons: [{
            label: isOwned ? t('shop.owned') : t('shop.buy'), enabled: canBuy, primary: true,
            fn: () => void this.onBuy(item.id),
          }],
        });
      }
    }

    return specs;
  }

  /** Coins recharge tab: USD tiers as an icon-card grid (price · treasure glyph · coins + bonus · buy), then a full-width promo-code redemption row. */
  private drawCoinsGrid(body: PIXI.Container, top: number): void {
    const { h } = this;
    const bodyTop = top + Math.round(h * 0.02);
    const viewH = h - bodyTop - Math.round(h * 0.02);
    const busy = this.bt.busy;

    const specs: CardSpec[] = WEB_COIN_TIERS.map((tier, idx) => {
      const bonus = tier.coins - tier.base;
      const lines: { text: string; color: number }[] = [];
      if (bonus > 0) lines.push({ text: `+${bonus}`, color: C.green });
      if (tier.bestValue) lines.push({ text: t('shop.bestValue'), color: C.gold });
      lines.push({ text: t('shop.firstDouble'), color: 0xff6b00 });
      const tierId = tier.id;
      return {
        icon: COIN_TIER_ICONS[idx] ?? 'coin', iconColor: C.gold,
        title: `$${(tier.usdCents / 100).toFixed(2)}`,
        coinAmount: tier.coins,
        lines,
        highlight: tier.bestValue,
        buttons: [{ label: t('shop.buy'), enabled: !busy, primary: true, fn: () => void this.onRecharge(tierId) }],
      };
    });

    const { listX, listW, gap, cols, cellW, cellH } = this.gridMetrics();
    const rows = Math.ceil(specs.length / cols);
    const gridH = rows * (cellH + gap);

    // Promo-code redemption (B-PROMO) lives on the Coins tab, full-width below the tier grid.
    const promoH = this.cb.redeemPromo ? Math.round(h * 0.09) : 0;
    const totalH = gridH + (promoH ? promoH + gap : 0);
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, totalH - viewH)));

    specs.forEach((spec, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = listX + col * (cellW + gap);
      const cy = bodyTop + row * (cellH + gap) - this.scrollY;
      if (cy + cellH >= top && cy <= h) this.drawCard(body, spec, cx, cy, cellW, cellH);
    });

    if (promoH) {
      const py = bodyTop + gridH - this.scrollY;
      if (py + promoH >= top && py <= h) this.drawPromoRow(body, listX, py, listW, promoH);
    }
  }

  // ── Card cell ────────────────────────────────────────────────────────────

  /** Draw one product card: name across the top, icon on the left, price/info on the right, action button(s) at the bottom. */
  private drawCard(body: PIXI.Container, spec: CardSpec, x: number, y: number, cw: number, ch: number): void {
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

    // Top-right corner badge (savings / best value).
    if (spec.badge) {
      const badge = txt(spec.badge.text, Math.round(ch * 0.11), spec.badge.color, true);
      badge.anchor.set(1, 0); badge.x = x + cw - pad; badge.y = y + pad;
      body.addChild(badge);
    }

    // Title (auto-scaled to fit the width minus padding / badge).
    const title = txt(spec.title, Math.round(ch * 0.15), C.dark, true);
    title.anchor.set(0, 0);
    title.x = x + pad; title.y = y + pad;
    this.fitText(title, cw - pad * 2 - (spec.badge ? Math.round(cw * 0.22) : 0));
    body.addChild(title);

    // Icon (left).
    const iconS = Math.round(ch * 0.32);
    const iconX = x + pad;
    const iconY = y + Math.round(ch * 0.30);
    const icon = this.coinIcon(spec.icon, iconS, spec.iconColor);
    icon.x = iconX; icon.y = iconY;
    body.addChild(icon);

    // Info column (right of the icon).
    const infoX = iconX + iconS + Math.round(cw * 0.05);
    let iy = y + Math.round(ch * 0.30);
    const lineH = Math.round(ch * 0.15);

    if (spec.coinAmount !== undefined) {
      const cs = Math.round(ch * 0.22);
      const ci = this.coinIcon('coin', cs, C.gold);
      ci.x = infoX; ci.y = iy;
      body.addChild(ci);
      const amt = txt(spec.coinAmount.toLocaleString(), Math.round(ch * 0.22), C.gold, true);
      amt.anchor.set(0, 0.5); amt.x = infoX + cs + Math.round(cw * 0.02); amt.y = ci.y + cs / 2;
      body.addChild(amt);
      iy += Math.round(ch * 0.21);
    }

    if (spec.yuanPrice !== undefined) {
      const price = txt(`¥${spec.yuanPrice}`, Math.round(ch * 0.18), C.gold, true);
      price.anchor.set(0, 0); price.x = infoX; price.y = iy;
      body.addChild(price);
      if (spec.yuanStrike !== undefined) {
        const strike = txt(`¥${spec.yuanStrike}`, Math.round(ch * 0.12), C.mid, false);
        strike.anchor.set(0, 0.5);
        strike.x = price.x + price.width + Math.round(cw * 0.03);
        strike.y = iy + Math.round(ch * 0.09);
        body.addChild(strike);
        const line = new PIXI.Graphics();
        line.lineStyle(2, C.mid, 1);
        line.moveTo(strike.x, strike.y).lineTo(strike.x + strike.width, strike.y);
        body.addChild(line);
      }
      iy += lineH;
    }

    for (const ln of spec.lines ?? []) {
      const l = txt(ln.text, Math.round(ch * 0.12), ln.color, true);
      l.anchor.set(0, 0); l.x = infoX; l.y = iy;
      body.addChild(l);
      iy += Math.round(ch * 0.14);
    }

    // Action buttons at the bottom (1 = full width, 2 = split).
    const btnH = Math.round(ch * 0.22);
    const btnY = y + ch - pad - btnH;
    const n = spec.buttons.length;
    const totalW = cw - pad * 2;
    const bGap = Math.round(cw * 0.03);
    const bw = n > 1 ? Math.round((totalW - bGap * (n - 1)) / n) : totalW;
    spec.buttons.forEach((b, i) => {
      const bx = x + pad + i * (bw + bGap);
      this.drawButton(body, b, bx, btnY, bw, btnH);
    });
  }

  private drawButton(body: PIXI.Container, b: BtnSpec, x: number, y: number, w: number, h: number): void {
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

  /** Scale a Text down (never up) so it fits within maxW. */
  private fitText(node: PIXI.Text, maxW: number): void {
    if (maxW > 0 && node.width > maxW) node.scale.set(maxW / node.width);
  }

  /** Promo-code row: full-width [text field showing code / placeholder] [Redeem button]. */
  private drawPromoRow(body: PIXI.Container, x: number, y: number, w: number, h: number): void {
    const btnW = Math.round(w * 0.20);
    const gap = Math.round(w * 0.02);
    const fieldW = w - btnW - gap;

    // Field box.
    const focused = this.promoFocused;
    const field = sketchPanel(fieldW, h, {
      fill: C.paper, border: focused ? C.accent : C.line,
      width: focused ? 2.2 : 1.4, seed: seedFor(x, y, fieldW),
    });
    field.x = x; field.y = y;
    body.addChild(field);

    const display = this.promoCode || t('shop.promoPlaceholder');
    const isPlaceholder = !this.promoCode;
    const fieldTxt = txt(display, Math.round(h * 0.30), isPlaceholder ? C.mid : C.dark, true);
    fieldTxt.anchor.set(0, 0.5); fieldTxt.x = x + Math.round(fieldW * 0.04); fieldTxt.y = y + h / 2;
    body.addChild(fieldTxt);

    // Blinking caret when focused.
    if (focused) {
      const caret = txt('|', Math.round(h * 0.34), C.accent, true);
      caret.anchor.set(0, 0.5);
      caret.x = fieldTxt.x + fieldTxt.width + 2;
      caret.y = y + h / 2;
      body.addChild(caret);
    }

    this.hits.push({ rect: { x, y, w: fieldW, h }, fn: () => this.focusPromo() });

    // Redeem button.
    const bx = x + fieldW + gap;
    const canRedeem = !this.bt.busy && this.promoCode.trim().length > 0;
    const btn = sketchPanel(btnW, h, {
      fill: canRedeem ? C.dark : C.btnOff,
      border: canRedeem ? C.green : C.light,
      width: 2, seed: seedFor(bx, y, btnW),
    });
    btn.x = bx; btn.y = y;
    body.addChild(btn);

    const blabel = txt(t('shop.promoRedeem'), Math.round(h * 0.30), canRedeem ? 0xffffff : C.mid, true);
    blabel.anchor.set(0.5, 0.5); blabel.x = bx + btnW / 2; blabel.y = y + h / 2;
    body.addChild(blabel);

    if (canRedeem) {
      this.hits.push({ rect: { x: bx, y, w: btnW, h }, fn: () => void this.onRedeem() });
    }
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
