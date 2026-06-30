import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { Rarity } from '../game/meta/SaveData';
import type { GachaPool, GachaResultEntry } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { gachaCardTexture, gachaFrameTexture, gachaBannerTexture, preloadGachaTextures } from '../render/gachaArt';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';

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

export type GachaDrawResult =
  | { ok: true; results: GachaResultEntry[] }
  | { ok: false; key: TranslationKey };

export interface GachaSceneCallbacks {
  onBack(): void;
  getCoins(): number;
  /** Current pity counter for a pool (server-authoritative mirror in SaveData). */
  getPity(poolId: string): number;
  loadPools(): Promise<GachaPool[]>;
  draw(poolId: string, count: 1 | 10): Promise<GachaDrawResult>;
  /**
   * 商城分组同级直达（LOBBY_IA_REDESIGN P1.5）。仅在「商城」分组语境下注入；
   * 注入后顶部出现 [商城|盲盒|战令] tab 条，否则退化为纯 back。
   */
  openShop?(): void;
  openBattlePass?(): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class GachaScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: GachaSceneCallbacks;

  private pool: GachaPool | null = null;
  private loading = true;
  private readonly bt = new BusyTracker();

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
      const pools = await this.cb.loadPools();
      this.pool = pools[0] ?? null;
    } catch {
      this.pool = null;
    }
    this.loading = false;
    this.render();
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
    this.drawBody(this.drawGroupTabs(tbH));
    if (this.toast) this.drawToast();
    if (this.reveal) this.drawReveal(this.reveal);
    if (this.oddsOpen && this.pool) this.drawOdds(this.pool);
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('gachabg', this.w, this.h));
  }

  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('gacha.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    const coins = txt(t('gacha.coins', { coins: this.cb.getCoins() }), Math.round(h * 0.026), C.gold, true);
    coins.anchor.set(1, 0.5); coins.x = w - Math.round(w * 0.04); coins.y = tbH / 2;
    this.container.addChild(coins);

    return tbH;
  }

  /**
   * 商城分组 tab 条（LOBBY_IA_REDESIGN P1.5）：[商城|盲盒|战令]，盲盒 active。
   * 仅在分组语境（openShop 注入）时绘制；返回正文起点 y。否则原样返回 tbH。
   */
  private drawGroupTabs(tbH: number): number {
    if (!this.cb.openShop) return tbH;
    const { w, h } = this;
    const stripH = hubTabsHeight(h);
    const tabs: HubTab[] = [
      { label: t('shop.title'), active: false },
      { label: t('gacha.title'), active: true },
    ];
    if (this.cb.openBattlePass) tabs.push({ label: t('battlepass.title'), active: false });
    const hits = drawHubTabs(this.container, w, tbH, stripH, tabs, (i) => {
      if (i === 0) this.cb.openShop?.();
      else if (i === 2) this.cb.openBattlePass?.();
    });
    this.hits.push(...hits);
    return tbH + stripH;
  }

  private drawBody(tbH: number): void {
    const { w, h } = this;
    if (this.loading) {
      const lbl = txt(t('gacha.loading'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = tbH + Math.round(h * 0.20);
      this.container.addChild(lbl);
      return;
    }
    if (!this.pool) {
      const lbl = txt(t('gacha.error'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = tbH + Math.round(h * 0.20);
      this.container.addChild(lbl);
      return;
    }

    const pool = this.pool;

    // Banner image.
    const bannerW = Math.round(w * 0.78);
    const bannerH = Math.round(h * 0.26);
    const bx = (w - bannerW) / 2;
    const by = tbH + Math.round(h * 0.05);
    const bannerTex = gachaBannerTexture(pool.id);
    const bannerSpr = new PIXI.Sprite(bannerTex);
    bannerSpr.x = bx; bannerSpr.y = by;
    bannerSpr.width = bannerW; bannerSpr.height = bannerH;
    this.container.addChild(bannerSpr);

    // Rarity legend dots.
    const dotR = Math.round(h * 0.012);
    const order: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    const legendY = by + bannerH * 0.68;
    const legendGap = bannerW / (order.length + 1);
    order.forEach((rar, i) => {
      const cx = bx + legendGap * (i + 1);
      const dot = new PIXI.Graphics();
      dot.beginFill(RARITY_COLOR[rar]); dot.drawCircle(0, 0, dotR); dot.endFill();
      dot.x = cx; dot.y = legendY - Math.round(h * 0.02);
      this.container.addChild(dot);
      const lbl = txt(t(('rarity.' + rar) as TranslationKey), Math.round(h * 0.016), C.mid);
      lbl.anchor.set(0.5, 0); lbl.x = cx; lbl.y = legendY;
      this.container.addChild(lbl);
    });

    // 概率详情 button (L1-3, Apple 3.1.1) — top-right of the banner.
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
      pity.anchor.set(0.5, 0.5); pity.x = w / 2; pity.y = by + bannerH + Math.round(h * 0.05);
      this.container.addChild(pity);

      const barW = Math.round(w * 0.7);
      const barH = Math.round(h * 0.018);
      const barX = (w - barW) / 2;
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
    const btnW = Math.round(w * 0.78);
    const btnH = Math.round(h * 0.092);
    const btnX = (w - btnW) / 2;
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
   * Odds-detail overlay (L1-3, Apple 3.1.1): a per-item probability table plus the
   * pity rule. Probabilities come straight from the server (`entry.probability`,
   * 0–1) — the client only renders, never computes. Any tap closes it.
   */
  private drawOdds(pool: GachaPool): void {
    const { w, h } = this;
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.78); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const pw = Math.round(w * 0.86), ph = Math.round(h * 0.8);
    const px = (w - pw) / 2, py = (h - ph) / 2;
    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.gold, width: 2.6, seed: seedFor(pw, ph, 7) });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const header = txt(t('gacha.oddsDetail.title'), Math.round(h * 0.032), C.dark, true);
    header.anchor.set(0.5, 0); header.x = w / 2; header.y = py + Math.round(h * 0.025);
    this.container.addChild(header);

    const entries = pool.entries;
    const listTop = py + Math.round(h * 0.08);
    const listBottom = py + ph - Math.round(h * 0.13);
    const rowH = Math.min(Math.round(h * 0.05), Math.max(1, (listBottom - listTop) / Math.max(1, entries.length)));
    const colDotX = px + Math.round(pw * 0.08);
    const colNameX = px + Math.round(pw * 0.14);
    const colProbX = px + pw - Math.round(pw * 0.08);
    const fontSize = Math.max(10, Math.round(rowH * 0.42));

    let total = 0;
    entries.forEach((e, i) => {
      const cy = listTop + i * rowH + rowH / 2;
      total += e.probability;
      const dot = new PIXI.Graphics();
      dot.beginFill(RARITY_COLOR[e.rarity]); dot.drawCircle(colDotX, cy, Math.round(rowH * 0.2)); dot.endFill();
      this.container.addChild(dot);

      const name = txt(e.itemId, fontSize, C.dark);
      name.anchor.set(0, 0.5); name.x = colNameX; name.y = cy;
      // Clamp overly long ids so the percentage column stays legible.
      const nameMax = colProbX - colNameX - Math.round(pw * 0.16);
      if (name.width > nameMax) name.scale.set(nameMax / name.width);
      this.container.addChild(name);

      const prob = txt(`${(e.probability * 100).toFixed(2)}%`, fontSize, C.accent, true);
      prob.anchor.set(1, 0.5); prob.x = colProbX; prob.y = cy;
      this.container.addChild(prob);
    });

    // Total + pity rule + close hint.
    const totalLbl = txt(t('gacha.oddsDetail.total', { pct: (total * 100).toFixed(2) }), Math.round(h * 0.022), C.mid, true);
    totalLbl.anchor.set(0.5, 1); totalLbl.x = w / 2; totalLbl.y = listBottom + Math.round(h * 0.005);
    this.container.addChild(totalLbl);

    const pity = pool.pityThreshold ?? 0;
    if (pity > 0) {
      const pityLbl = new PIXI.Text(t('gacha.oddsDetail.pityRule', { n: pity }), {
        fontSize: Math.round(h * 0.02), fill: C.dark, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: pw * 0.84, align: 'center',
      });
      pityLbl.anchor.set(0.5, 0); pityLbl.x = w / 2; pityLbl.y = listBottom + Math.round(h * 0.02);
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
