import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { Rarity } from '../game/meta/SaveData';
import type { GachaPool, GachaResultEntry } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { gachaCardTexture, gachaFrameTexture, gachaBannerTexture, preloadGachaTextures } from '../render/gachaArt';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { buildIcon } from '../render/icons';
import { buildCoinIcon } from '../render/coinIconAtlas';
import { getEquipDef } from '../game/meta/equipmentDefs';
import { drawEquipmentGlyph } from '../render/equipmentGlyph';
import { CARD_DEFS } from '../game/meta/cardDefs';
import { SKIN_TARGET_UNIT } from '../game/meta/skinDefs';
import { UNIT_ART_URLS, getArtTexture } from '../render/cardArt';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';

/** itemId prefix → material icon glyph (mat_scrap/mat_lead/mat_binding). */
const MATERIAL_ICON: Record<string, 'scrap' | 'lead' | 'binding'> = {
  mat_scrap: 'scrap', mat_lead: 'lead', mat_binding: 'binding',
};

// ── GachaScene (S2-6) — single / ten-pull lootbox with pity + reveal ───────────
//
// Canvas-drawn (mirrors ShopScene): render()-on-change + flat hit-list. The draw
// is server-authoritative (crypto RNG + pity live in commercial); this scene
// shows the pool's cost/pity, fires single/ten draws, and reveals the returned
// results (rarity-coloured cards, NEW / duplicate badges) over a dim overlay.

/** Rarity → card accent colour (shared visual language with shop/collection later). */
const RARITY_COLOR: Record<Rarity, number> = {
  common:    0x9aa0a6,
  rare:      0x4477cc,
  epic:      0xaa55cc,
  legendary: 0xddaa33,
};

/** Rarity → star-pip count (rank at a glance, tinted by RARITY_COLOR). */
const RARITY_STARS: Record<Rarity, number> = {
  common: 1, rare: 2, epic: 3, legendary: 4,
};

export type GachaDrawResult =
  | { ok: true; results: GachaResultEntry[] }
  | { ok: false; key: TranslationKey };

export type FateRedeemResult =
  | { ok: true; granted: string }
  | { ok: false; key: TranslationKey };

export interface GachaSceneCallbacks {
  onBack(): void;
  getCoins(): number;
  /** Current pity counter for a pool (server-authoritative mirror in SaveData). */
  getPity(poolId: string): number;
  /** Fate Points balance (server-authoritative mirror; GACHA_DESIGN §7). */
  getFatePoints(): number;
  loadPools(): Promise<GachaPool[]>;
  draw(poolId: string, count: 1 | 10): Promise<GachaDrawResult>;
  /** Redeem the given featured legendary for FATE_POINT_REDEEM_COST fate points (§7). */
  redeemFate(itemId: string): Promise<FateRedeemResult>;
  /**
   * Peer navigation within the shop group (LOBBY_IA_REDESIGN P1.5). Injected only
   * in the "shop" group context; when present the top shows a [Shop|Coins|Gacha|BattlePass]
   * tab strip, otherwise the scene falls back to a plain back button.
   */
  openShop?(): void;
  /** Navigate to the shop's Coins tab. Only injected when a real IAP recharge route is available. */
  openCoins?(): void;
  openBattlePass?(): void;
  /** Whether the Shop peer tab has an unclaimed monthly-card reward (mirrors ShopScene's own Shop-tab badge, LOBBY_IA_REDESIGN P1.5). */
  getShopBadge?(): boolean;
  /** Whether the BattlePass peer tab has a claimable level reward at the current XP (mirrors ShopScene's own peer-tab badges, LOBBY_IA_REDESIGN P1.5). */
  getBattlePassBadge?(): boolean;
}

interface Hit { rect: Rect; fn: () => void; }

export class GachaScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: GachaSceneCallbacks;

  private pools: GachaPool[] = [];
  private poolIdx = 0;
  private get pool(): GachaPool | null { return this.pools[this.poolIdx] ?? null; }
  private loading = true;
  private readonly bt = new BusyTracker();

  /** Fate Point redeem cost (mirrors @nw/shared FATE_POINT_REDEEM_COST; GACHA_DESIGN §7). */
  private static readonly FATE_COST = 30;

  /** Hero-card art urls already hooked for a 'loaded' re-render (odds popup), so we don't double-hook. */
  private readonly artHooked = new Set<string>();

  private toast: { text: string; color: number } | null = null;
  /** Reveal overlay: non-null while showing the latest draw's results. */
  private reveal: GachaResultEntry[] | null = null;
  /** Odds-detail overlay open (L1-3, Apple 3.1.1): lists per-item probability + pity rule. */
  private oddsOpen = false;
  /** Odds-grid scroll state — the grid shows every pool entry (no rarity grouping/paging), so it can
   *  exceed the panel's height once a pool has more than ~20 items. */
  private oddsScrollY = 0;
  private oddsScrollMax = 0;
  private oddsDragStart: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  /** Set by handleOddsMove instead of rendering inline — same throttle as CardScene's drag-scroll
   *  (see scroll-drag-throttle-pattern memory: rendering per pointermove causes jank while dragging). */
  private oddsScrollDirty = false;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async loadPools()/draw() re-render can't paint into a torn-down container. */
  private destroyed = false;

  constructor(layout: ILayout, input: InputManager, cb: GachaSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleOddsMove(y)));
    this.unsubs.push(input.onUp(() => this.handleOddsUp()));
    this.render();
    void this.loadPools();
    void preloadGachaTextures();
  }

  update(dt: number): void {
    if (this.oddsScrollDirty) { this.oddsScrollDirty = false; this.render(); }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private async loadPools(): Promise<void> {
    try {
      this.pools = await this.cb.loadPools();
    } catch {
      this.pools = [];
    }
    if (this.poolIdx >= this.pools.length) this.poolIdx = 0;
    this.loading = false;
    this.render();
  }

  /** Redeem Fate Points for the active limited pool's featured legendary (§7). */
  private async onRedeemFate(): Promise<void> {
    const pool = this.pool;
    if (this.bt.busy || !pool?.featuredLegendary) return;
    this.bt.start();
    this.toast = null;
    this.render();
    try {
      const res = await withTimeout(this.cb.redeemFate(pool.featuredLegendary));
      this.toast = res.ok
        ? { text: t('gacha.fate.redeemed', { item: res.granted }), color: C.green }
        : { text: t(res.key), color: C.red };
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'gacha.error'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  // ── Draw ───────────────────────────────────────────────────────────────────

  private async onDraw(count: 1 | 10): Promise<void> {
    if (this.bt.busy || !this.pool) return;
    this.bt.start();
    this.toast = null;
    this.render();
    try {
      const res = await withTimeout(this.cb.draw(this.pool.id, count));
      if (res.ok) this.reveal = res.results;
      else this.toast = { text: t(res.key), color: C.red };
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'gacha.error'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
  }

  private dismissReveal(): void {
    this.reveal = null;
    this.render();
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    // While revealing, any tap continues.
    if (this.reveal) { this.dismissReveal(); return; }
    // While showing the odds detail, a tap closes it (modal, no inner controls) — but the grid also
    // scrolls, so closing is deferred to handleOddsUp until we know the pointer didn't drag.
    if (this.oddsOpen) { this.oddsDragStart = { x, y, scroll: this.oddsScrollY, moved: false }; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private handleOddsMove(y: number): void {
    if (!this.oddsDragStart) return;
    const dy = y - this.oddsDragStart.y;
    if (Math.abs(dy) > 6) {
      this.oddsDragStart.moved = true;
      this.oddsScrollY = Math.max(0, Math.min(this.oddsScrollMax, this.oddsDragStart.scroll - dy));
      this.oddsScrollDirty = true;
    }
  }

  private handleOddsUp(): void {
    if (this.oddsDragStart && !this.oddsDragStart.moved) { this.oddsOpen = false; this.oddsScrollY = 0; this.render(); }
    this.oddsDragStart = null;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawSidebar(tbH);
    this.drawBody(tbH);
    if (this.toast) this.drawToast();
    if (this.reveal) this.drawReveal(this.reveal);
    if (this.oddsOpen && this.pool) this.drawOdds(this.pool);
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = this.landscape ? sidebarNavW(this.w, this.h, true) : undefined;
    this.container.addChild(buildPaperBackground('gachabg', this.w, this.h, { railX }));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('gacha.title'), { accent: HEADER_ACCENT.spend });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): shared header readout — identical across every scene.
    drawHeaderCurrency(this.container, w, tbH, this.cb.getCoins());

    return tbH;
  }

  /**
   * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), Gacha active: a vertical
   * rail (`sidebarNavW`, matching every other hub's left tab rail). Only drawn when in the group
   * context (openShop injected). Consumes no vertical space — drawBody shifts its content start x instead.
   */
  private drawSidebar(tbH: number): void {
    if (!this.cb.openShop) return;
    const { w, h, landscape } = this;
    const tabs: HubTab[] = [{ label: t('shop.title'), active: false, icon: 'tag', badge: this.cb.getShopBadge?.() ?? false }];
    const actions: Array<() => void> = [() => this.cb.openShop?.()];
    if (this.cb.openCoins) {
      tabs.push({ label: t('shop.coinsTab'), active: false, icon: 'coin' });
      actions.push(() => this.cb.openCoins?.());
    }
    tabs.push({ label: t('gacha.title'), active: true, icon: 'capsule' });
    actions.push(() => {});
    if (this.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy', badge: this.cb.getBattlePassBadge?.() ?? false });
      actions.push(() => this.cb.openBattlePass?.());
    }
    const sidebarW = sidebarNavW(w, h, landscape);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, (i) => actions[i]?.());
    this.hits.push(...hits);
  }

  /** Content column bounds: shifted right of the sidebar rail when in the shop group, else full width. */
  private contentBounds(): { x0: number; w: number } {
    const { w, h, landscape } = this;
    if (!this.cb.openShop) return { x0: 0, w };
    const gap = Math.round(w * 0.02);
    const x0 = sidebarNavW(w, h, landscape) + gap;
    return { x0, w: w - x0 - gap };
  }

  private drawBody(tbH: number): void {
    const { w, h } = this;
    const { x0: cx0, w: cw } = this.contentBounds();
    const centerX = cx0 + cw / 2;
    if (this.loading) {
      const lbl = txt(t('gacha.loading'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = centerX; lbl.y = tbH + Math.round(h * 0.20);
      this.container.addChild(lbl);
      return;
    }
    if (!this.pool) {
      const lbl = txt(t('gacha.error'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = centerX; lbl.y = tbH + Math.round(h * 0.20);
      this.container.addChild(lbl);
      return;
    }

    const pool = this.pool;

    // Pool selector (GACHA_DESIGN §2.2): one tab per pool (standard + active limited). Only shown when >1 pool.
    let selH = 0;
    if (this.pools.length > 1) {
      selH = Math.round(h * 0.055);
      const gap = Math.round(cw * 0.02);
      const totalW = Math.round(cw * 0.9);
      const tabW = Math.round((totalW - gap * (this.pools.length - 1)) / this.pools.length);
      const tabH = Math.round(h * 0.042);
      const sy = tbH + Math.round(h * 0.008);
      let sx = cx0 + (cw - totalW) / 2;
      this.pools.forEach((p, i) => {
        const active = i === this.poolIdx;
        const label = p.limited ? (p.name ?? t('gacha.pool.limited')) : t('gacha.pool.standard');
        this.addButton(label, sx, sy, tabW, tabH,
          active ? C.dark : C.btnOff, active ? C.gold : C.light,
          () => { this.poolIdx = i; this.render(); }, !active);
        sx += tabW + gap;
      });
    }

    // Banner image.
    const bannerW = Math.round(cw * 0.78);
    const bannerH = Math.round(h * 0.26);
    const bx = cx0 + (cw - bannerW) / 2;
    const by = tbH + selH + Math.round(h * 0.05);
    const bannerTex = gachaBannerTexture(pool.id);
    const bannerSpr = new PIXI.Sprite(bannerTex);
    bannerSpr.x = bx; bannerSpr.y = by;
    bannerSpr.width = bannerW; bannerSpr.height = bannerH;
    this.container.addChild(bannerSpr);

    // Pool-type badge (banner top-left): limited → gold star, standard → gacha capsule.
    const poolBadge = buildIcon(pool.limited ? 'star' : 'capsule', Math.round(h * 0.036), pool.limited ? C.gold : C.mid);
    poolBadge.x = bx + Math.round(w * 0.02); poolBadge.y = by + Math.round(h * 0.015);
    this.container.addChild(poolBadge);

    // Limited / custom pool expiry countdown (banner bottom-left). Server only serves in-window pools,
    // so this normally counts down; a cached pool that just lapsed shows "Ended".
    if (pool.limited && pool.endAt) {
      const remain = pool.endAt - Date.now();
      const cdLabel =
        remain <= 0
          ? t('gacha.pool.ended')
          : t('gacha.pool.endsIn', {
              d: Math.floor(remain / 86_400_000),
              h: Math.floor((remain % 86_400_000) / 3_600_000),
            });
      const cd = txt(cdLabel, Math.round(h * 0.016), remain <= 0 ? C.mid : C.gold, true);
      cd.anchor.set(0, 1);
      cd.x = bx + Math.round(w * 0.02);
      cd.y = by + bannerH - Math.round(h * 0.015);
      this.container.addChild(cd);
    }

    // Rarity legend: N star-pips per rarity (1..4), tinted by rarity colour.
    const dotR = Math.round(h * 0.012);
    const order: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    const legendY = by + bannerH * 0.68;
    const legendGap = bannerW / (order.length + 1);
    // Size stars so a full 4-pip row fits within ~82% of the inter-group gap.
    const starSz = Math.max(6, Math.min(Math.round(dotR * 1.8), Math.floor((legendGap * 0.82) / 4) - 2));
    order.forEach((rar, i) => {
      const cx = bx + legendGap * (i + 1);
      const n = RARITY_STARS[rar];
      const rowW = n * starSz + (n - 1) * 2;
      const starY = legendY - Math.round(h * 0.02) - starSz / 2;
      let sxp = cx - rowW / 2;
      for (let k = 0; k < n; k++) {
        const st = buildIcon('star', starSz, RARITY_COLOR[rar]);
        st.x = sxp; st.y = starY;
        this.container.addChild(st);
        sxp += starSz + 2;
      }
      const lbl = txt(t(('rarity.' + rar) as TranslationKey), Math.round(h * 0.016), C.mid);
      lbl.anchor.set(0.5, 0); lbl.x = cx; lbl.y = legendY;
      this.container.addChild(lbl);
    });

    // Odds detail button (L1-3, Apple 3.1.1) — top-right of the banner.
    const oddsLbl = txt('ⓘ ' + t('gacha.oddsDetail.button'), Math.round(h * 0.02), C.accent, true);
    oddsLbl.anchor.set(1, 0); oddsLbl.x = bx + bannerW - Math.round(w * 0.02); oddsLbl.y = by + Math.round(h * 0.015);
    this.container.addChild(oddsLbl);
    const oPad = Math.round(h * 0.012);
    this.hits.push({
      rect: { x: oddsLbl.x - oddsLbl.width - oPad, y: oddsLbl.y - oPad, w: oddsLbl.width + 2 * oPad, h: oddsLbl.height + 2 * oPad },
      fn: () => { this.oddsOpen = true; this.render(); },
    });

    // Pity progress.
    const pityMax = pool.pityThreshold ?? 0;
    if (pityMax > 0) {
      const cur = this.cb.getPity(pool.id);
      const pity = txt(t('gacha.pity', { cur, max: pityMax }), Math.round(h * 0.024), C.dark, true);
      pity.anchor.set(0.5, 0.5); pity.x = centerX; pity.y = by + bannerH + Math.round(h * 0.05);
      this.container.addChild(pity);

      const barW = Math.round(cw * 0.7);
      const barH = Math.round(h * 0.018);
      const barX = cx0 + (cw - barW) / 2;
      const barY = by + bannerH + Math.round(h * 0.08);
      const track = new PIXI.Graphics();
      track.beginFill(C.light); track.drawRoundedRect(0, 0, barW, barH, barH / 2); track.endFill();
      track.x = barX; track.y = barY;
      this.container.addChild(track);
      const frac = Math.max(0, Math.min(1, cur / pityMax));
      if (frac > 0) {
        const fill = new PIXI.Graphics();
        fill.beginFill(C.gold); fill.drawRoundedRect(0, 0, Math.round(barW * frac), barH, barH / 2); fill.endFill();
        fill.x = barX; fill.y = barY;
        this.container.addChild(fill);
      }
    }

    // Draw buttons.
    const btnW = Math.round(cw * 0.78);
    const btnH = Math.round(h * 0.092);
    const btnX = cx0 + (cw - btnW) / 2;
    let btnY = Math.round(h * 0.68);
    const single = pool.costSingle;
    const ten = pool.costTen ?? pool.costSingle * 10;
    const canSingle = !this.bt.busy && this.cb.getCoins() >= single;
    const canTen = !this.bt.busy && this.cb.getCoins() >= ten;

    this.addButton(t('gacha.drawOne', { cost: single }), btnX, btnY, btnW, btnH,
      canSingle ? C.dark : C.btnOff, canSingle ? C.accent : C.light,
      () => void this.onDraw(1), canSingle);
    btnY += btnH + Math.round(h * 0.025);
    this.addButton(t('gacha.drawTen', { cost: ten }), btnX, btnY, btnW, btnH,
      canTen ? C.dark : C.btnOff, canTen ? C.gold : C.light,
      () => void this.onDraw(10), canTen);

    // Fate Points (GACHA_DESIGN §7): shown on limited pools; redeem when at the threshold.
    if (pool.limited && pool.featuredLegendary) {
      const fate = this.cb.getFatePoints();
      const cost = GachaScene.FATE_COST;
      btnY += btnH + Math.round(h * 0.02);
      const fateLbl = txt(t('gacha.fate.balance', { cur: fate, cost }), Math.round(h * 0.022), C.dark, true);
      fateLbl.anchor.set(0, 0.5); fateLbl.x = btnX; fateLbl.y = btnY + btnH * 0.28;
      this.container.addChild(fateLbl);
      const canRedeem = !this.bt.busy && fate >= cost;
      const rW = Math.round(btnW * 0.4);
      this.addButton(t('gacha.fate.redeem'), btnX + btnW - rW, btnY, rW, Math.round(btnH * 0.6),
        canRedeem ? C.accent : C.btnOff, canRedeem ? C.gold : C.light,
        () => void this.onRedeemFate(), canRedeem);
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
    const by = Math.round(h * 0.88);
    const bg = sketchPanel(bw, bh, { fill: toast.color, fillAlpha: 0.95, border: toast.color, width: 2, seed: seedFor(bw, bh, 2) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    this.container.addChild(lbl);
  }

  private drawReveal(results: GachaResultEntry[]): void {
    const { w, h } = this;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.82); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const header = txt(t('gacha.results'), Math.round(h * 0.036), 0xffffff, true);
    header.anchor.set(0.5, 0.5); header.x = w / 2; header.y = Math.round(h * 0.12);
    this.container.addChild(header);

    // Grid: up to 5 columns (a ten-pull → 2 rows of 5; single → 1 card centred).
    const n = results.length;
    const cols = Math.min(5, n);
    const rows = Math.ceil(n / cols);
    const cellW = Math.round(w * 0.16);
    const cellH = Math.round(cellW * 1.3);
    const gapX = Math.round(w * 0.02);
    const gapY = Math.round(h * 0.02);
    const gridW = cols * cellW + (cols - 1) * gapX;
    const startX = (w - gridW) / 2;
    const gridH = rows * cellH + (rows - 1) * gapY;
    const startY = (h - gridH) / 2;

    results.forEach((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = startX + col * (cellW + gapX);
      const cy = startY + row * (cellH + gapY);
      this.drawResultCard(r, cx, cy, cellW, cellH, i + 1);
    });

    const hint = txt(t('gacha.tapContinue'), Math.round(h * 0.022), C.light);
    hint.anchor.set(0.5, 0.5); hint.x = w / 2; hint.y = Math.round(h * 0.92);
    this.container.addChild(hint);
  }

  private drawResultCard(r: GachaResultEntry, x: number, y: number, w: number, h: number, seed: number): void {
    // Card background texture (rarity-specific — epic/legendary art is a dark
    // purple/gold wash that swallows dark ink text, so the id/badge sit on
    // their own paper-coloured plate rather than directly on the art).
    const cardSpr = new PIXI.Sprite(gachaCardTexture(r.rarity));
    cardSpr.x = x; cardSpr.y = y;
    cardSpr.width = w; cardSpr.height = h;
    this.container.addChild(cardSpr);

    // Item picture — same per-item representation used in the odds-detail grid
    // (material icon / equipment glyph / real unit art / skin brush / rarity
    // star fallback), so a glance shows *what* was drawn, not just its id string.
    const picSize = Math.round(Math.min(w, h) * 0.46);
    this.drawEntryPicture(r.itemId, r.rarity, x + w / 2, y + h * 0.34, picSize, seed);

    const plateY = y + h * 0.54;
    const plateH = h * 0.38;
    const plate = new PIXI.Graphics();
    plate.beginFill(C.paper, 0.92); plate.drawRect(x, plateY, w, plateH); plate.endFill();
    this.container.addChild(plate);

    // Item name (translated display name, not the raw itemId).
    const idLbl = txt(this.displayName(r.itemId), Math.round(h * 0.075), C.dark);
    idLbl.anchor.set(0.5, 0.5); idLbl.x = x + w / 2; idLbl.y = y + h * 0.63;
    this.container.addChild(idLbl);

    // NEW badge only — duplicates get no badge (a "Dup" label read as noise).
    // Kept above 0.80h so it clears the decorative frame's bottom border band
    // (frame overlay is drawn on top of the plate, last).
    if (!r.duplicate) {
      const badge = txt(t('gacha.new'), Math.round(h * 0.10), C.green, true);
      badge.anchor.set(0.5, 0.5); badge.x = x + w / 2; badge.y = y + h * 0.78;
      this.container.addChild(badge);
    }

    // Frame overlay — drawn last so it sits on top of the card art.
    const frameSpr = new PIXI.Sprite(gachaFrameTexture(r.rarity));
    frameSpr.x = x; frameSpr.y = y;
    frameSpr.width = w; frameSpr.height = h;
    this.container.addChild(frameSpr);
  }

  /**
   * Odds-detail overlay (L1-3, Apple 3.1.1): a per-item probability grid plus the
   * pity rule. Probabilities come straight from the server (`entry.probability`,
   * 0–1) — the client only renders, never computes. Any tap closes it.
   *
   * Laid out as a grid of icon cards (rarity-tinted star + id + %) rather than a
   * single-column list — a flat list left most of the panel's width empty since
   * each row only needed a fraction of it.
   */
  private drawOdds(pool: GachaPool): void {
    const { w, h } = this;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.78); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const pw = Math.round(w * 0.9), ph = Math.round(h * 0.86);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.gold, width: 2.6, seed: seedFor(pw, ph, 7) });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const header = txt(t('gacha.oddsDetail.title'), Math.round(h * 0.032), C.dark, true);
    header.anchor.set(0.5, 0); header.x = w / 2; header.y = py + Math.round(h * 0.02);
    this.container.addChild(header);

    const entries = pool.entries;
    const gridTop = py + Math.round(h * 0.075);
    const gridBottom = py + ph - Math.round(h * 0.135);
    const gridPad = Math.round(pw * 0.03);
    const gridX = px + gridPad, gridW = pw - gridPad * 2;
    const gridH = Math.max(1, gridBottom - gridTop);

    const n = Math.max(1, entries.length);
    const cols = Math.min(7, Math.max(3, Math.round(Math.sqrt((n * gridW) / gridH))));
    const rows = Math.ceil(n / cols);
    const cellW = gridW / cols;
    // Fixed aspect ratio (not squished to fit gridH) — every entry gets a legible card; a pool with
    // more rows than the panel can show scrolls instead (2026-07-15: was cramming all entries into one
    // page, making small-probability items unreadable).
    const cellH = cellW * 0.92;
    const gap = Math.round(cellW * 0.08);

    const contentH = rows * cellH;
    this.oddsScrollMax = Math.max(0, contentH - gridH);
    this.oddsScrollY = Math.max(0, Math.min(this.oddsScrollY, this.oddsScrollMax));

    // Grid lives in a masked layer so overscrolled cards never bleed into the header/pity text below.
    const gridLayer = new PIXI.Container();
    this.container.addChild(gridLayer);
    const gridMask = new PIXI.Graphics();
    gridMask.beginFill(0xffffff).drawRect(gridX, gridTop, gridW, gridH).endFill();
    this.container.addChild(gridMask);
    gridLayer.mask = gridMask;

    let total = 0;
    entries.forEach((e, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cardW = cellW - gap, cardH = cellH - gap;
      const cardX = gridX + col * cellW + gap / 2;
      const cardY = gridTop + row * cellH + gap / 2 - this.oddsScrollY;
      total += e.probability;
      if (cardY + cardH < gridTop || cardY > gridBottom) return; // off-screen — skip drawing, still counted above

      const card = sketchPanel(cardW, cardH, {
        fill: C.paper, border: RARITY_COLOR[e.rarity], width: 1.8, seed: seedFor(cardX, cardY, i + 1),
      });
      card.x = cardX; card.y = cardY;
      gridLayer.addChild(card);

      const picSz = Math.round(Math.min(cardW * 0.62, cardH * 0.42));
      this.drawEntryPicture(e.itemId, e.rarity, cardX + cardW / 2, cardY + cardH * 0.10 + picSz / 2, picSz, i + 1, gridLayer);

      const nameSize = Math.max(9, Math.round(cardH * 0.13));
      const name = txt(this.displayName(e.itemId), nameSize, C.dark);
      name.anchor.set(0.5, 0); name.x = cardX + cardW / 2; name.y = cardY + cardH * 0.52;
      const nameMax = cardW * 0.9;
      if (name.width > nameMax) name.scale.set(nameMax / name.width);
      gridLayer.addChild(name);

      const probSize = Math.max(10, Math.round(cardH * 0.17));
      const prob = txt(`${(e.probability * 100).toFixed(2)}%`, probSize, C.accent, true);
      prob.anchor.set(0.5, 1); prob.x = cardX + cardW / 2; prob.y = cardY + cardH * 0.94;
      gridLayer.addChild(prob);
    });

    drawScrollIndicator(this.container, { x: gridX, y: gridTop, w: gridW, h: gridH }, this.oddsScrollY, this.oddsScrollMax);

    // Total + pity rule + close hint.
    const totalLbl = txt(t('gacha.oddsDetail.total', { pct: (total * 100).toFixed(2) }), Math.round(h * 0.022), C.mid, true);
    totalLbl.anchor.set(0.5, 1); totalLbl.x = w / 2; totalLbl.y = gridBottom + Math.round(h * 0.005);
    this.container.addChild(totalLbl);

    const pity = pool.pityThreshold ?? 0;
    if (pity > 0) {
      const pityLbl = new PIXI.Text(t('gacha.oddsDetail.pityRule', { n: pity }), {
        fontSize: Math.round(h * 0.02), fill: C.dark, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: pw * 0.84, align: 'center',
      });
      pityLbl.anchor.set(0.5, 0); pityLbl.x = w / 2; pityLbl.y = gridBottom + Math.round(h * 0.02);
      this.container.addChild(pityLbl);
    }

    const hint = txt(t('gacha.oddsDetail.tapClose'), Math.round(h * 0.02), C.mid);
    hint.anchor.set(0.5, 1); hint.x = w / 2; hint.y = py + ph - Math.round(h * 0.02);
    this.container.addChild(hint);
  }

  /**
   * Per-item picture for one odds-grid cell, centered at (cx, cy) in a `size`×`size`
   * box. No dedicated per-item art exists (art-direction §9.2: near-zero art cost),
   * so this reuses whatever representation the item already has elsewhere in the
   * client: hero cards → the real unit PNG (cardArt.ts), equipment → the procedural
   * per-slot glyph (equipmentGlyph.ts), materials → their dedicated icon, skins →
   * the wardrobe brush glyph. Falls back to a rarity star for anything unrecognised.
   */
  private drawEntryPicture(
    itemId: string, rarity: Rarity, cx: number, cy: number, size: number, seed: number,
    parent: PIXI.Container = this.container,
  ): void {
    const matKind = MATERIAL_ICON[itemId];
    if (matKind) {
      const icon = buildIcon(matKind, size, RARITY_COLOR[rarity]);
      icon.x = cx - size / 2; icon.y = cy - size / 2;
      parent.addChild(icon);
      return;
    }

    const equipDef = getEquipDef(itemId);
    if (equipDef) {
      const g = new PIXI.Graphics();
      drawEquipmentGlyph(g, equipDef.slot, equipDef.rarity, size, seed);
      g.x = cx; g.y = cy;
      parent.addChild(g);
      return;
    }

    const cardDef = CARD_DEFS[itemId];
    const artUrl = cardDef ? UNIT_ART_URLS[cardDef.unitType] : undefined;
    if (artUrl) {
      const tex = getArtTexture(artUrl);
      if (tex.baseTexture.valid) {
        const scale = Math.min(size / tex.width, size / tex.height);
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        sp.scale.set(scale);
        sp.position.set(cx, cy);
        parent.addChild(sp);
      } else if (!this.artHooked.has(artUrl)) {
        this.artHooked.add(artUrl);
        tex.baseTexture.once('loaded', () => this.render());
      }
      return;
    }

    if (itemId.startsWith('skin_')) {
      const icon = buildIcon('brush', size, RARITY_COLOR[rarity]);
      icon.x = cx - size / 2; icon.y = cy - size / 2;
      parent.addChild(icon);
      return;
    }

    const star = buildIcon('star', size, RARITY_COLOR[rarity]);
    star.x = cx - size / 2; star.y = cy - size / 2;
    parent.addChild(star);
  }

  /**
   * Resolve an itemId to its player-facing display name for the odds-detail grid (was showing raw
   * itemIds like "mat_scrap" — not translated, unreadable). Mirrors drawEntryPicture's item-kind
   * detection so every entry that gets a real picture also gets a real name.
   */
  private displayName(itemId: string): string {
    const matKind = MATERIAL_ICON[itemId];
    if (matKind) return t(('material.' + matKind) as TranslationKey);

    if (getEquipDef(itemId)) return t((`equip.${itemId}.name`) as TranslationKey);

    if (CARD_DEFS[itemId]) return t((`card.${itemId}.name`) as TranslationKey);

    const skinUnit = SKIN_TARGET_UNIT[itemId];
    if (skinUnit) {
      const target = Object.values(CARD_DEFS).find((d) => d.unitType === skinUnit);
      const base = target ? t((`card.${target.id}.name`) as TranslationKey) : itemId;
      return `${base}·${t('shop.skinLabel')}`;
    }

    return itemId;
  }

  private addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void, enabled = true,
  ): void {
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x; g.y = y;
    this.container.addChild(g);

    const tl = txt(label, Math.round(h * 0.36), enabled ? 0xffffff : C.mid, true);
    tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
    this.container.addChild(tl);

    if (enabled) this.hits.push({ rect: { x, y, w, h }, fn });
  }
}
