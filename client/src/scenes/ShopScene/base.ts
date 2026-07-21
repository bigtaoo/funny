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
// [Shop|Coins|Gacha|BattlePass] is a vertical rail (sidebarNavW, matching every other hub's left tab rail), so the grid
// starts to its right and scrolls (drag) inside a masked body region while the header + rail stay fixed. Subscription
// cards (monthly / year) are globally single-slot: while any card is active, both Buy buttons read "active" and are
// disabled (server enforces the same via ALREADY_ACTIVE). Promo-code redemption (B-PROMO) is a full-width row below
// the Coins tab's tier grid; text entry uses the same hidden-<input> technique as LoginScene (works on both desktop
// keyboards and mobile soft keyboards).
import * as PIXI from 'pixi.js-legacy';
import { ILayout, Rect } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { t, TranslationKey } from '../../i18n';
import type { ShopItem } from '../../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../../render/sketchUi';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { type IconKind } from '../../render/icons';
import { loadCoinIconAtlas, buildCoinIcon } from '../../render/coinIconAtlas';
import { getArtTexture } from '../../render/cardArt';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../../ui/widgets/HubTabs';
import { BusyTracker } from '../../ui/busyTracker';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { snapFont } from '../../render/fontScale';

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
  /** Whether the BattlePass peer tab has a claimable level reward at the current XP (mirrors GachaScene's own peer-tab badges, LOBBY_IA_REDESIGN P1.5). */
  getBattlePassBadge?(): boolean;
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
   * art borrows the base unit's card PNG — see ShopMixin.buildShopCards skin section).
   */
  artUrl?: string;
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
  /** Ink-stamp overlay on the art image, angled like GachaScene's "NEW" stamp (monthly-card expiring-soon state). */
  expiringSoonStamp?: boolean;
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
  protected readonly landscape: boolean;
  protected readonly cb: ShopSceneCallbacks;

  protected items: ShopItem[] | null = null;
  protected loading = true;
  protected readonly bt = new BusyTracker();
  protected tab: 'shop' | 'coins';

  protected hits: Hit[] = [];
  /** URLs whose texture-load re-render has already been hooked (mirrors CardScene.drawArtFit). */
  private readonly artHooked = new Set<string>();
  protected readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async re-render can't paint into a torn-down container. */
  protected destroyed = false;

  // ── Scroll state (grid may overflow the body region) ──────────────────────
  protected scrollY = 0;
  /** This render's body mask, sized per-tab by {@link maskBody} once its grid's peek-adjusted viewH is known. */
  protected bodyMask: PIXI.Graphics | null = null;
  /**
   * Tap-vs-drag gesture tracker: defers a cell's hit action to pointer-up and drops it if the pointer
   * dragged (so a drag starting on a shop card scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /** Set by handleMove instead of rendering inline — see EquipmentSceneBase.scrollDirty for why. */
  private scrollDirty = false;

  // ── Promo-code state ──────────────────────────────────────────────────────
  protected promoCode = '';
  protected promoFocused = false;
  /** Hidden DOM input capturing keystrokes for promo-code entry (null on non-DOM platforms). */
  protected hiddenInput: HTMLInputElement | null = null;

  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
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

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container); // free Text textures on each rebuild
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    const top = this.drawGroupTabs(tbH);

    // Body grid lives in a masked layer so overscrolled cells never bleed into the fixed header / tab strip.
    // Mask height is set per-tab (see viewH below) so a partial next row always peeks above the fold.
    const body = new PIXI.Container();
    this.container.addChild(body);
    const mask = new PIXI.Graphics();
    this.container.addChild(mask);
    body.mask = mask;
    this.bodyMask = mask;

    if (this.tab === 'coins') {
      this.drawCoinsGrid(body, top);
    } else {
      this.drawShopGrid(body, top);
    }

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  /** Size this render's body mask to `top..top+viewH` — called by each grid method once it knows its
   *  own peek-adjusted viewH, so the clip line (and the deliberate partial-row peek above it) is exact. */
  protected maskBody(top: number, viewH: number): void {
    this.bodyMask?.clear().beginFill(0xffffff).drawRect(0, top, this.w, viewH).endFill();
  }

  private drawBackground(): void {
    // Landscape only for now: the notebook's red margin rule is repositioned to the rail's actual
    // edge (sidebarNavW) instead of the classic 9%-of-width line, which used to cut through the
    // middle of this scene's (wider) rail. Portrait keeps the legacy line pending a separate
    // decision on whether portrait should even keep a left-edge rail (LOBBY_IA_REDESIGN §14).
    const railX = this.landscape ? sidebarNavW(this.w, this.h, true) : undefined;
    this.container.addChild(buildPaperBackground('shopbg', this.w, this.h, { railX }));
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
   * stacked in the left rail (`sidebarNavW`), below the header — same convention
   * as CardScene/EquipmentScene's sidebar nav. Coins tab only appears when rechargeCoins is provided
   * (logged in, web platform); BattlePass tab only when openBattlePass is provided. Returns the body
   * start y (just the header height — the rail occupies width, not height).
   */
  private drawGroupTabs(tbH: number): number {
    const { w, h, landscape } = this;
    const sidebarW = sidebarNavW(w, h, landscape);
    const showCoins = !!this.cb.rechargeCoins;

    const { active, claimedToday } = this.monthlyCardStatus();
    const monthlyClaimable = !!this.cb.claimMonthlyCard && active && !claimedToday;

    const tabs: HubTab[] = [
      { label: t('shop.title'), active: this.tab === 'shop', icon: 'tag', badge: monthlyClaimable },
    ];
    if (showCoins) tabs.push({ label: t('shop.coinsTab'), active: this.tab === 'coins', icon: 'coin' });
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    if (this.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy', badge: this.cb.getBattlePassBadge?.() ?? false });
    }

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

  /** Monthly/year card status derived from the mirrored monetization save (shared by the sidebar badge and the card itself). */
  protected monthlyCardStatus(): { active: boolean; claimedToday: boolean; expiringSoon: boolean } {
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
  protected gridMetrics(): { listX: number; listW: number; gap: number; cols: number; cellW: number; cellH: number } {
    const { w, h, landscape } = this;
    const gap = Math.round(w * 0.015);
    const listX = sidebarNavW(w, h, landscape) + gap;
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

  // ── Card cell ────────────────────────────────────────────────────────────

  /**
   * Draw one product card as an image-dominant vertical tile: a big square art/icon fills the top,
   * then title, price (coins or ¥ with optional strike-through), any status lines, and the action
   * button(s) stack full-width below it. A savings badge sits in the top-right corner over the art.
   * Everything is horizontally centered so several narrow cards read cleanly across a row.
   */
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
    const cx = x + cw / 2; // card horizontal centre — everything centres on this
    const innerW = cw - pad * 2;

    // ── Action button(s), pinned at the bottom and reserved first (full-width, stacked when >1) so the
    //    text band above can be clamped to whatever room is left and never overlaps them. ──
    const n = spec.buttons.length;
    const btnH = Math.round(ch * 0.13);
    const bGap = Math.round(ch * 0.02);
    const btnAreaH = n * btnH + Math.max(0, n - 1) * bGap;
    const btnTop = y + ch - pad - btnAreaH;
    spec.buttons.forEach((b, i) => {
      this.drawButton(body, b, x + pad, btnTop + i * (btnH + bGap), innerW, btnH);
    });

    // ── Top: big square art / icon, centred. Shrunk when status lines are present (e.g. item
    //    descriptions) so the wrapped text band below has room without spilling onto the buttons. ──
    const hasLines = (spec.lines?.length ?? 0) > 0;
    const imgSize = Math.min(Math.round(ch * (hasLines ? 0.2 : 0.46)), innerW);
    const imgX = Math.round(cx - imgSize / 2);
    const imgY = y + pad;
    if (spec.artUrl) {
      // Wait for the texture to finish loading before sizing the sprite — setting width/height against
      // an unloaded (0/1px) baseTexture yields a garbage scale and the art never appears; re-render on
      // 'loaded' (mirrors CardScene.drawArtFit).
      const tex = getArtTexture(spec.artUrl);
      if (tex.baseTexture.valid) {
        const art = new PIXI.Sprite(tex);
        art.width = imgSize; art.height = imgSize;
        art.x = imgX; art.y = imgY;
        body.addChild(art);
      } else if (!this.artHooked.has(spec.artUrl)) {
        this.artHooked.add(spec.artUrl);
        tex.baseTexture.once('loaded', () => this.render());
      }
    } else {
      const icon = buildCoinIcon(spec.icon, imgSize, spec.iconColor);
      icon.x = imgX; icon.y = imgY;
      body.addChild(icon);
    }

    // "Expiring soon" ink stamp, printed at an angle straight onto the art — same rubber-stamp
    // treatment as GachaScene's "NEW" badge (drawResultCard), reused here for visual consistency.
    if (spec.expiringSoonStamp) {
      const stamp = new PIXI.Container();
      const stampW = Math.round(imgSize * 0.92);
      const stampH = Math.round(imgSize * 0.26);
      const ink = 0xaf2430;
      const border = new PIXI.Graphics();
      border.lineStyle(Math.max(2, Math.round(imgSize * 0.02)), ink, 0.9);
      border.drawRoundedRect(-stampW / 2, -stampH / 2, stampW, stampH, stampH * 0.3);
      stamp.addChild(border);
      const label = txt(t('shop.expiringSoonStamp'), snapFont(Math.round(imgSize * 0.13)), ink, true);
      label.anchor.set(0.5, 0.5);
      if (label.width > stampW * 0.88) label.scale.set((stampW * 0.88) / label.width);
      stamp.addChild(label);
      stamp.rotation = -0.3;
      stamp.alpha = 0.88;
      stamp.x = imgX + imgSize / 2;
      stamp.y = imgY + imgSize / 2;
      body.addChild(stamp);
    }

    // Savings / best-value badge: top-right corner over the art.
    if (spec.badge) {
      const badge = txt(spec.badge.text, snapFont(Math.round(ch * 0.075)), spec.badge.color, true);
      badge.anchor.set(1, 0); badge.x = x + cw - pad; badge.y = y + pad;
      body.addChild(badge);
    }

    // ── Middle text band: title, then price, then status lines — all centred, top-aligned from just
    //    below the art down to just above the buttons. ──
    let ty = imgY + imgSize + Math.round(ch * 0.03);
    const bandBottom = btnTop - Math.round(ch * 0.02);

    const title = txt(spec.title, snapFont(Math.round(ch * (hasLines ? 0.06 : 0.085))), C.dark, true, innerW);
    title.anchor.set(0.5, 0); title.x = cx; title.y = ty;
    body.addChild(title);
    ty += title.height + Math.round(ch * 0.02);

    if (spec.coinAmount !== undefined) {
      const cs = Math.round(ch * 0.11);
      const amt = txt(spec.coinAmount.toLocaleString(), snapFont(cs), C.gold, true);
      const rowW = cs + Math.round(cw * 0.02) + amt.width;
      const ci = buildCoinIcon('coin', cs, C.gold);
      ci.x = Math.round(cx - rowW / 2); ci.y = ty;
      body.addChild(ci);
      amt.anchor.set(0, 0); amt.x = ci.x + cs + Math.round(cw * 0.02); amt.y = ty + (cs - amt.height) / 2;
      body.addChild(amt);
      ty += Math.max(cs, amt.height) + Math.round(ch * 0.02);
    }

    if (spec.yuanPrice !== undefined) {
      const price = txt(`¥${spec.yuanPrice}`, snapFont(Math.round(ch * 0.11)), C.gold, true);
      if (spec.yuanStrike !== undefined) {
        const strike = txt(`¥${spec.yuanStrike}`, snapFont(Math.round(ch * 0.07)), C.mid, false);
        const gap = Math.round(cw * 0.03);
        const rowW = strike.width + gap + price.width;
        strike.anchor.set(0, 0.5); strike.x = Math.round(cx - rowW / 2); strike.y = ty + price.height / 2;
        body.addChild(strike);
        const line = new PIXI.Graphics();
        line.lineStyle(2, C.mid, 1);
        line.moveTo(strike.x, strike.y).lineTo(strike.x + strike.width, strike.y);
        body.addChild(line);
        price.anchor.set(0, 0); price.x = strike.x + strike.width + gap; price.y = ty;
        body.addChild(price);
      } else {
        price.anchor.set(0.5, 0); price.x = cx; price.y = ty;
        body.addChild(price);
      }
      ty += price.height + Math.round(ch * 0.02);
    }

    // Status / bonus lines (Active, Free, item description…) — centred, wrapped, clamped to the band.
    const lines = spec.lines ?? [];
    if (lines.length > 0 && ty < bandBottom) {
      const fontSize = snapFont(Math.round(ch * 0.06));
      for (const ln of lines) {
        if (ty >= bandBottom) break;
        const l = txt(ln.text, fontSize, ln.color, true, innerW);
        // Wrapped text can span multiple physical lines — check the whole block's bottom (not just
        // its start y) against the button area so a long description never spills onto the buttons.
        if (ty + l.height > bandBottom) { l.destroy(); break; }
        l.anchor.set(0.5, 0); l.x = cx; l.y = ty;
        body.addChild(l);
        ty += l.height + Math.round(ch * 0.01);
      }
    }
  }

  protected drawButton(body: PIXI.Container, b: BtnSpec, x: number, y: number, w: number, h: number): void {
    const btn = sketchPanel(w, h, {
      fill: b.enabled ? C.dark : C.btnOff,
      border: b.enabled ? (b.primary ? C.green : C.accent) : C.light,
      width: 2, seed: seedFor(x, y, w),
    });
    btn.x = x; btn.y = y;
    body.addChild(btn);
    const lbl = txt(b.label, snapFont(Math.round(h * 0.42)), b.enabled ? 0xffffff : C.mid, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + w / 2; lbl.y = y + h / 2;
    body.addChild(lbl);
    if (b.enabled && b.fn) this.hits.push({ rect: { x, y, w, h }, fn: b.fn });
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
