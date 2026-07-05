import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { Rarity } from '../game/meta/SaveData';
import type { GachaPool, GachaResultEntry } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren, marginLineX } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { gachaCardTexture, gachaFrameTexture, gachaBannerTexture, preloadGachaTextures } from '../render/gachaArt';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { buildIcon } from '../render/icons';

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
}

interface Hit { rect: Rect; fn: () => void; }

export class GachaScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: GachaSceneCallbacks;

  private pools: GachaPool[] = [];
  private poolIdx = 0;
  private get pool(): GachaPool | null { return this.pools[this.poolIdx] ?? null; }
  private loading = true;
  private readonly bt = new BusyTracker();

  /** Fate Point redeem cost (mirrors @nw/shared FATE_POINT_REDEEM_COST; GACHA_DESIGN §7). */
  private static readonly FATE_COST = 30;

  private toast: { text: string; color: number } | null = null;
  /** Reveal overlay: non-null while showing the latest draw's results. */
  private reveal: GachaResultEntry[] | null = null;
  /** Odds-detail overlay open (L1-3, Apple 3.1.1): lists per-item probability + pity rule. */
  private oddsOpen = false;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: GachaSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.loadPools();
    void preloadGachaTextures();
  }

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
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
    // While showing the odds detail, any tap closes it (modal, no inner controls).
    if (this.oddsOpen) { this.oddsOpen = false; this.render(); return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
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
    this.container.addChild(buildPaperBackground('gachabg', this.w, this.h));
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('gacha.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance: glyph + number, no "金币：" text prefix — matches ShopScene's header convention.
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
   * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), Gacha active: a vertical
   * rail stacked inside the left notebook-margin gutter (`marginLineX`), mirroring the
   * CardScene/EquipmentScene sidebar convention. Only drawn when in the group context (openShop
   * injected). Consumes no vertical space — drawBody shifts its content start x instead.
   */
  private drawSidebar(tbH: number): void {
    if (!this.cb.openShop) return;
    const { w, h } = this;
    const tabs: HubTab[] = [{ label: t('shop.title'), active: false, icon: 'tag' }];
    const actions: Array<() => void> = [() => this.cb.openShop?.()];
    if (this.cb.openCoins) {
      tabs.push({ label: t('shop.coinsTab'), active: false, icon: 'coin' });
      actions.push(() => this.cb.openCoins?.());
    }
    tabs.push({ label: t('gacha.title'), active: true, icon: 'capsule' });
    actions.push(() => {});
    if (this.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy' });
      actions.push(() => this.cb.openBattlePass?.());
    }
    const sidebarW = marginLineX(w);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, (i) => actions[i]?.());
    this.hits.push(...hits);
  }

  /** Content column bounds: shifted right of the sidebar rail when in the shop group, else full width. */
  private contentBounds(): { x0: number; w: number } {
    const { w } = this;
    if (!this.cb.openShop) return { x0: 0, w };
    const gap = Math.round(w * 0.02);
    const x0 = marginLineX(w) + gap;
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
      this.drawResultCard(r, cx, cy, cellW, cellH);
    });

    const hint = txt(t('gacha.tapContinue'), Math.round(h * 0.022), C.light);
    hint.anchor.set(0.5, 0.5); hint.x = w / 2; hint.y = Math.round(h * 0.92);
    this.container.addChild(hint);
  }

  private drawResultCard(r: GachaResultEntry, x: number, y: number, w: number, h: number): void {
    // Card background texture (rarity-specific).
    const cardSpr = new PIXI.Sprite(gachaCardTexture(r.rarity));
    cardSpr.x = x; cardSpr.y = y;
    cardSpr.width = w; cardSpr.height = h;
    this.container.addChild(cardSpr);

    // Item id.
    const idLbl = txt(r.itemId, Math.round(h * 0.10), C.dark);
    idLbl.anchor.set(0.5, 0.5); idLbl.x = x + w / 2; idLbl.y = y + h * 0.58;
    this.container.addChild(idLbl);

    // NEW / duplicate badge.
    const badge = txt(r.duplicate ? t('gacha.duplicate') : t('gacha.new'),
      Math.round(h * 0.11), r.duplicate ? C.mid : C.green, true);
    badge.anchor.set(0.5, 0.5); badge.x = x + w / 2; badge.y = y + h * 0.85;
    this.container.addChild(badge);

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
    const cellH = Math.min(gridH / rows, cellW * 0.92);
    // Cells may not fill the full grid height (short pools) — centre the block.
    const gridYOffset = gridTop + Math.max(0, (gridH - cellH * rows) / 2);
    const gap = Math.round(cellW * 0.08);

    let total = 0;
    entries.forEach((e, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cardW = cellW - gap, cardH = cellH - gap;
      const cardX = gridX + col * cellW + gap / 2;
      const cardY = gridYOffset + row * cellH + gap / 2;
      total += e.probability;

      const card = sketchPanel(cardW, cardH, {
        fill: C.paper, border: RARITY_COLOR[e.rarity], width: 1.8, seed: seedFor(cardX, cardY, i + 1),
      });
      card.x = cardX; card.y = cardY;
      this.container.addChild(card);

      const starSz = Math.round(cardH * 0.32);
      const star = buildIcon('star', starSz, RARITY_COLOR[e.rarity]);
      star.x = cardX + cardW / 2 - starSz / 2; star.y = cardY + cardH * 0.12;
      this.container.addChild(star);

      const nameSize = Math.max(9, Math.round(cardH * 0.15));
      const name = txt(e.itemId, nameSize, C.dark);
      name.anchor.set(0.5, 0); name.x = cardX + cardW / 2; name.y = cardY + cardH * 0.52;
      const nameMax = cardW * 0.9;
      if (name.width > nameMax) name.scale.set(nameMax / name.width);
      this.container.addChild(name);

      const probSize = Math.max(10, Math.round(cardH * 0.17));
      const prob = txt(`${(e.probability * 100).toFixed(2)}%`, probSize, C.accent, true);
      prob.anchor.set(0.5, 1); prob.x = cardX + cardW / 2; prob.y = cardY + cardH * 0.94;
      this.container.addChild(prob);
    });

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
