import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { ShopItem } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { buildIcon, type IconKind } from '../render/icons';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
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

// ── ShopScene (S2-6 + B-PROMO) — direct-purchase shop ────────────────────────
//
// Canvas-drawn (mirrors LoginScene/RoomScene): a render()-on-change tree with a
// flat hit-list. The economy itself is server-authoritative — every buy returns a
// fresh SaveData that the app adopts; this scene only reads the current wallet via
// getCoins() and re-renders. Gacha lives in its own scene, reached via the 🎁 tab.
//
// Promo-code redemption (B-PROMO): a single text row at the bottom of the list.
// Text entry uses the same hidden-<input> technique as LoginScene (works on both
// desktop keyboards and mobile soft keyboards).

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
  /** Monthly card + starter state (subscription end ms, purchased one-off product ids). */
  getMonetization?(): { subscriptionExpiry: number; starterUsed: string[] };
  buyMonthlyCard?(): Promise<ShopActionResult>;
  claimMonthlyCard?(): Promise<ShopActionResult>;
  buyStarter?(productId: 'starter_draw' | 'starter_growth'): Promise<ShopActionResult>;
}

interface Hit { rect: Rect; fn: () => void; }

export class ShopScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: ShopSceneCallbacks;

  private items: ShopItem[] | null = null;
  private loading = true;
  private readonly bt = new BusyTracker();
  private tab: 'shop' | 'coins' = 'shop';

  /** Transient toast message (success / error), cleared on next action. */
  private toast: { text: string; color: number } | null = null;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

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
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    if (cb.redeemPromo) this.setupHiddenInput();
    this.render();
    void this.loadItems();
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

  // ── Monetization deals (monthly card / starter packs) ─────────────────────

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

  /** Deals block (GACHA_DESIGN §5–§6): monthly card (buy + daily claim) + one-off starter packs. Returns the new y. */
  private drawDeals(x: number, y: number, w: number, rowH: number): number {
    const gap = Math.round(this.h * 0.018);
    const mon = this.cb.getMonetization?.() ?? { subscriptionExpiry: 0, starterUsed: [] };
    const busy = this.bt.busy;

    // Monthly card row: [label + status] [Buy] [Claim].
    if (this.cb.buyMonthlyCard) {
      const box = sketchPanel(w, rowH, { fill: 0xfff8e8, border: C.gold, width: 2, seed: seedFor(x, y, w) });
      box.x = x; box.y = y;
      this.container.addChild(box);
      const active = mon.subscriptionExpiry > Date.now();
      // Treasure-chest glyph flags the monthly card as the richest recurring value.
      const mIconS = Math.round(rowH * 0.6);
      const mIcon = buildIcon('coinChest', mIconS, C.gold);
      mIcon.x = x + Math.round(w * 0.035); mIcon.y = y + (rowH - mIconS) / 2;
      this.container.addChild(mIcon);
      const mTextX = x + Math.round(w * 0.035) + mIconS + Math.round(w * 0.025);
      const name = txt(t('shop.monthlyCard'), Math.round(rowH * 0.24), C.dark, true);
      name.anchor.set(0, 0.5); name.x = mTextX; name.y = y + rowH * 0.34;
      this.container.addChild(name);
      const status = txt(active ? t('shop.monthlyActive') : t('shop.monthlyInactive'), Math.round(rowH * 0.18), active ? C.green : C.mid, true);
      status.anchor.set(0, 0.5); status.x = mTextX; status.y = y + rowH * 0.68;
      this.container.addChild(status);
      // Buy + Claim buttons (right).
      const bw = Math.round(w * 0.24), bh = Math.round(rowH * 0.5);
      const bx2 = x + w - bw - Math.round(w * 0.03);
      const bx1 = bx2 - bw - Math.round(w * 0.02);
      const by = y + (rowH - bh) / 2;
      this.dealButton(t('shop.buy'), bx1, by, bw, bh, !busy, () => void this.runDeal(() => this.cb.buyMonthlyCard!(), 'shop.bought'));
      if (this.cb.claimMonthlyCard) {
        this.dealButton(t('shop.monthlyClaim'), bx2, by, bw, bh, !busy && active, () => void this.runDeal(() => this.cb.claimMonthlyCard!(), 'shop.monthlyClaimed'));
      }
      y += rowH + gap;
    }

    // Starter packs: one row each, "已购" when already owned.
    if (this.cb.buyStarter) {
      const packs: { id: 'starter_draw' | 'starter_growth'; label: TranslationKey; icon: IconKind }[] = [
        { id: 'starter_draw', label: 'shop.starterDraw', icon: 'coins' },
        { id: 'starter_growth', label: 'shop.starterGrowth', icon: 'coinSack' },
      ];
      for (const pk of packs) {
        const used = mon.starterUsed.includes(pk.id);
        const box = sketchPanel(w, rowH, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
        box.x = x; box.y = y;
        sketchAccentBar(box, rowH, C.accent, seedFor(x, rowH, 4));
        this.container.addChild(box);
        // Coin-pile glyph signals the pack's bundled value.
        const pIconS = Math.round(rowH * 0.56);
        const pIcon = buildIcon(pk.icon, pIconS, C.gold);
        pIcon.x = x + Math.round(w * 0.035); pIcon.y = y + (rowH - pIconS) / 2;
        this.container.addChild(pIcon);
        const pTextX = x + Math.round(w * 0.035) + pIconS + Math.round(w * 0.025);
        const name = txt(t(pk.label), Math.round(rowH * 0.22), C.dark, true);
        name.anchor.set(0, 0.5); name.x = pTextX; name.y = y + rowH * 0.5;
        this.container.addChild(name);
        const bw = Math.round(w * 0.26), bh = Math.round(rowH * 0.56);
        const bx = x + w - bw - Math.round(w * 0.03);
        const by = y + (rowH - bh) / 2;
        this.dealButton(used ? t('shop.owned') : t('shop.buy'), bx, by, bw, bh, !used && !busy,
          () => void this.runDeal(() => this.cb.buyStarter!(pk.id), 'shop.bought'));
        y += rowH + gap;
      }
    }
    return y;
  }

  private dealButton(label: string, x: number, y: number, w: number, h: number, enabled: boolean, fn: () => void): void {
    const btn = sketchPanel(w, h, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.green : C.light, width: 2, seed: seedFor(x, y, w) });
    btn.x = x; btn.y = y;
    this.container.addChild(btn);
    const lbl = txt(label, Math.round(h * 0.4), enabled ? 0xffffff : C.mid, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + w / 2; lbl.y = y + h / 2;
    this.container.addChild(lbl);
    if (enabled) this.hits.push({ rect: { x, y, w, h }, fn });
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
    // Tap outside any hit — blur promo field if focused.
    if (this.promoFocused) this.blurPromo();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    tearDownChildren(this.container); // free Text textures on each rebuild
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    const top = this.drawGroupTabs(tbH);
    if (this.tab === 'coins') {
      this.drawCoinsList(top);
    } else {
      this.drawList(top);
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
    const bIcon = buildIcon('coin', balIcon, C.gold);
    bIcon.x = balNum.x - balNum.width - balIcon - Math.round(w * 0.008);
    bIcon.y = tbH / 2 - balIcon / 2;
    this.container.addChild(bIcon);

    return tbH;
  }

  /**
   * Shop group tab strip (LOBBY_IA_REDESIGN P1.5): [Shop|Coins|Gacha|BattlePass].
   * Coins tab only appears when rechargeCoins callback is provided (logged in, web platform).
   * BattlePass tab only appears when openBattlePass is provided.
   * Returns the body start y (bottom edge of the strip).
   */
  private drawGroupTabs(tbH: number): number {
    const { w, h } = this;
    const stripH = hubTabsHeight(h);
    const showCoins = !!this.cb.rechargeCoins;

    const tabs: HubTab[] = [
      { label: t('shop.title'), active: this.tab === 'shop', icon: 'tag' },
    ];
    if (showCoins) tabs.push({ label: t('shop.coinsTab'), active: this.tab === 'coins', icon: 'coin' });
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    if (this.cb.openBattlePass) tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy' });

    const hits = drawHubTabs(this.container, w, tbH, stripH, tabs, (i) => {
      if (!showCoins) {
        if (i === 1) this.cb.openGacha();
        else if (i === 2) this.cb.openBattlePass?.();
        return;
      }
      if (i === 0) { this.tab = 'shop'; this.render(); }
      else if (i === 1) { this.tab = 'coins'; this.render(); }
      else if (i === 2) this.cb.openGacha();
      else if (i === 3) this.cb.openBattlePass?.();
    });
    this.hits.push(...hits);
    return tbH + stripH;
  }

  private drawList(top: number): void {
    const { w, h } = this;
    const listX = Math.round(w * 0.06);
    const listW = w - listX * 2;
    let y = top + Math.round(h * 0.025);

    if (this.loading) {
      const lbl = txt(t('shop.loading'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = top + Math.round(h * 0.14);
      this.container.addChild(lbl);
      return;
    }

    const rowH = Math.round(h * 0.10);
    const gap = Math.round(h * 0.018);

    // Monetization deals (monthly card + starter packs) at the top of the shop tab.
    if (this.cb.getMonetization) y = this.drawDeals(listX, y, listW, rowH);

    if (this.items && this.items.length > 0) {
      const owned = new Set(this.cb.getOwnedSkins());
      for (const item of this.items) {
        this.drawItemRow(item, owned.has(item.grants ?? item.id), listX, y, listW, rowH);
        y += rowH + gap;
      }
    } else {
      const lbl = txt(t('shop.empty'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = top + Math.round(h * 0.14);
      this.container.addChild(lbl);
      y += Math.round(h * 0.18);
    }

    if (this.cb.redeemPromo) {
      y += Math.round(h * 0.012);
      this.drawPromoRow(listX, y, listW, rowH);
    }
  }

  private drawItemRow(
    item: ShopItem, isOwned: boolean, x: number, y: number, w: number, h: number,
  ): void {
    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, C.accent, seedFor(x, h, 3));
    this.container.addChild(box);

    const pad = Math.round(w * 0.04);
    // Thumbnail: skins are cosmetic → brush glyph (real skin art pending). Gives every row a visual anchor.
    const thumb = Math.round(h * 0.5);
    const thumbIcon = buildIcon('brush', thumb, C.accent);
    thumbIcon.x = x + pad;
    thumbIcon.y = y + (h - thumb) / 2;
    this.container.addChild(thumbIcon);
    const textX = x + pad + thumb + Math.round(w * 0.03);

    // Name (placeholder: kind label + id, real skin art/names pending).
    const name = txt(`${t('shop.skinLabel')} · ${item.id}`, Math.round(h * 0.22), C.dark, true);
    name.anchor.set(0, 0.5); name.x = textX; name.y = y + h * 0.36;
    this.container.addChild(name);

    // Price: coin glyph + number (drops the old ◎ text so the cost reads as coins).
    const costIcon = Math.round(h * 0.26);
    const cIcon = buildIcon('coin', costIcon, C.gold);
    cIcon.x = textX; cIcon.y = y + h * 0.70 - costIcon / 2;
    this.container.addChild(cIcon);
    const cost = txt(`${item.cost}`, Math.round(h * 0.22), C.gold, true);
    cost.anchor.set(0, 0.5); cost.x = cIcon.x + costIcon + Math.round(w * 0.012); cost.y = y + h * 0.70;
    this.container.addChild(cost);

    // Buy / owned button (right).
    const bw = Math.round(w * 0.26);
    const bh = Math.round(h * 0.56);
    const bx = x + w - bw - Math.round(w * 0.03);
    const by = y + (h - bh) / 2;
    const canBuy = !isOwned && !this.bt.busy && this.cb.getCoins() >= item.cost;

    const btn = sketchPanel(bw, bh, {
      fill: isOwned ? C.btnOff : (canBuy ? C.dark : C.btnOff),
      border: isOwned ? C.light : (canBuy ? C.green : C.light),
      width: 2, seed: seedFor(bx, by, bw),
    });
    btn.x = bx; btn.y = by;
    this.container.addChild(btn);

    const blabel = txt(isOwned ? t('shop.owned') : t('shop.buy'),
      Math.round(bh * 0.40), isOwned ? C.mid : 0xffffff, true);
    blabel.anchor.set(0.5, 0.5); blabel.x = bx + bw / 2; blabel.y = by + bh / 2;
    this.container.addChild(blabel);

    if (!isOwned && !this.bt.busy) {
      this.hits.push({ rect: { x: bx, y: by, w: bw, h: bh }, fn: () => void this.onBuy(item.id) });
    }
  }

  /** Promo-code row: [text field showing code / placeholder] [Redeem button]. */
  private drawPromoRow(x: number, y: number, w: number, h: number): void {
    const btnW = Math.round(w * 0.28);
    const gap = Math.round(w * 0.025);
    const fieldW = w - btnW - gap;

    // Field box.
    const focused = this.promoFocused;
    const field = sketchPanel(fieldW, h, {
      fill: C.paper, border: focused ? C.accent : C.line,
      width: focused ? 2.2 : 1.4, seed: seedFor(x, y, fieldW),
    });
    field.x = x; field.y = y;
    this.container.addChild(field);

    const display = this.promoCode || t('shop.promoPlaceholder');
    const isPlaceholder = !this.promoCode;
    const fieldTxt = txt(display, Math.round(h * 0.30), isPlaceholder ? C.mid : C.dark, true);
    fieldTxt.anchor.set(0, 0.5); fieldTxt.x = x + Math.round(fieldW * 0.05); fieldTxt.y = y + h / 2;
    this.container.addChild(fieldTxt);

    // Blinking caret when focused.
    if (focused) {
      const caret = txt('|', Math.round(h * 0.34), C.accent, true);
      caret.anchor.set(0, 0.5);
      caret.x = fieldTxt.x + fieldTxt.width + 2;
      caret.y = y + h / 2;
      this.container.addChild(caret);
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
    this.container.addChild(btn);

    const blabel = txt(t('shop.promoRedeem'), Math.round(h * 0.30), canRedeem ? 0xffffff : C.mid, true);
    blabel.anchor.set(0.5, 0.5); blabel.x = bx + btnW / 2; blabel.y = y + h / 2;
    this.container.addChild(blabel);

    if (canRedeem) {
      this.hits.push({ rect: { x: bx, y, w: btnW, h }, fn: () => void this.onRedeem() });
    }
  }

  /** Coins recharge tab: list of USD tiers with price, coins total, bonus, and buy button. */
  private drawCoinsList(top: number): void {
    const { w, h } = this;
    const listX = Math.round(w * 0.06);
    const listW = w - listX * 2;
    let y = top + Math.round(h * 0.025);
    const rowH = Math.round(h * 0.10);
    const gap = Math.round(h * 0.018);

    WEB_COIN_TIERS.forEach((tier, idx) => {
      const priceDollars = (tier.usdCents / 100).toFixed(2);
      const bonusCoins = tier.coins - tier.base;
      const isBusy = this.bt.busy;

      const box = sketchPanel(listW, rowH, {
        fill: tier.bestValue ? 0xfff8e8 : C.paper,
        border: tier.bestValue ? C.gold : C.line,
        width: tier.bestValue ? 2.2 : 1.6,
        seed: seedFor(listX, y, listW),
      });
      box.x = listX; box.y = y;
      sketchAccentBar(box, rowH, tier.bestValue ? C.gold : C.accent, seedFor(listX, rowH, 5));
      this.container.addChild(box);

      // Price badge (left).
      const priceLbl = txt(`$${priceDollars}`, Math.round(rowH * 0.28), C.dark, true);
      priceLbl.anchor.set(0, 0.5);
      priceLbl.x = listX + Math.round(listW * 0.04);
      priceLbl.y = y + rowH * 0.5;
      this.container.addChild(priceLbl);

      // Treasure icon — escalates with the tier so bigger packs look richer.
      const iconSize = Math.round(rowH * 0.66);
      const iconX = listX + Math.round(listW * 0.16);
      const icon = buildIcon(COIN_TIER_ICONS[idx] ?? 'coin', iconSize, C.gold);
      icon.x = iconX;
      icon.y = y + Math.round((rowH - iconSize) / 2);
      this.container.addChild(icon);

      const textX = iconX + iconSize + Math.round(listW * 0.015);

      // Coin amount.
      const coinLbl = txt(tier.coins.toLocaleString(), Math.round(rowH * 0.26), C.gold, true);
      coinLbl.anchor.set(0, 0.5);
      coinLbl.x = textX;
      coinLbl.y = y + rowH * 0.36;
      this.container.addChild(coinLbl);

      // Bonus label: "+N" in green followed by a coin glyph (drops the stray English "bonus" word).
      if (bonusCoins > 0) {
        const bonusLbl = txt(`+${bonusCoins}`, Math.round(rowH * 0.18), C.green, true);
        bonusLbl.anchor.set(0, 0.5);
        bonusLbl.x = textX;
        bonusLbl.y = y + rowH * 0.68;
        this.container.addChild(bonusLbl);
        const bIconS = Math.round(rowH * 0.20);
        const bonusIcon = buildIcon('coin', bIconS, C.green);
        bonusIcon.x = bonusLbl.x + bonusLbl.width + Math.round(listW * 0.008);
        bonusIcon.y = y + rowH * 0.68 - bIconS / 2;
        this.container.addChild(bonusIcon);
      }

      // Best Value badge.
      if (tier.bestValue) {
        const badge = txt(t('shop.bestValue'), Math.round(rowH * 0.18), C.gold, true);
        badge.anchor.set(0, 0.5);
        badge.x = textX;
        badge.y = y + (bonusCoins > 0 ? rowH * 0.05 : rowH * 0.36);
        this.container.addChild(badge);
      }

      // First-purchase 2x badge (always shown; server applies it to the first purchase).
      const firstBadge = txt(t('shop.firstDouble'), Math.round(rowH * 0.17), 0xff6b00, true);
      firstBadge.anchor.set(1, 0.5);
      firstBadge.x = listX + Math.round(listW * 0.72);
      firstBadge.y = y + rowH * 0.5;
      this.container.addChild(firstBadge);

      // Buy button (right).
      const bw = Math.round(listW * 0.22);
      const bh = Math.round(rowH * 0.56);
      const bx = listX + listW - bw - Math.round(listW * 0.03);
      const by = y + (rowH - bh) / 2;

      const btn = sketchPanel(bw, bh, {
        fill: isBusy ? C.btnOff : C.dark,
        border: isBusy ? C.light : C.green,
        width: 2,
        seed: seedFor(bx, by, bw),
      });
      btn.x = bx; btn.y = by;
      this.container.addChild(btn);

      const blabel = txt(t('shop.buy'), Math.round(bh * 0.40), isBusy ? C.mid : 0xffffff, true);
      blabel.anchor.set(0.5, 0.5); blabel.x = bx + bw / 2; blabel.y = by + bh / 2;
      this.container.addChild(blabel);

      if (!isBusy) {
        const tierId = tier.id;
        this.hits.push({ rect: { x: bx, y: by, w: bw, h: bh }, fn: () => void this.onRecharge(tierId) });
      }

      y += rowH + gap;
    });
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
