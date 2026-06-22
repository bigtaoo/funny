import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { Rarity } from '../game/meta/SaveData';
import type { GachaPool, GachaResultEntry } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay } from '../render/sketchUi';
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
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    this.container.removeChildren();
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawBody(tbH);
    if (this.toast) this.drawToast();
    if (this.reveal) this.drawReveal(this.reveal);
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('gachabg', this.w, this.h));
  }

  private drawHeader(): number {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('gacha.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('gacha.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    const pad = Math.round(h * 0.02);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + pad, h: tbH }, fn: () => this.cb.onBack() });

    const coins = txt(t('gacha.coins', { coins: this.cb.getCoins() }), Math.round(h * 0.026), C.gold, true);
    coins.anchor.set(1, 0.5); coins.x = w - Math.round(w * 0.04); coins.y = tbH / 2;
    this.container.addChild(coins);

    return tbH;
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

    // Banner card (placeholder art pending; rarity legend as a flourish).
    const bannerW = Math.round(w * 0.78);
    const bannerH = Math.round(h * 0.26);
    const bx = (w - bannerW) / 2;
    const by = tbH + Math.round(h * 0.05);
    const banner = sketchPanel(bannerW, bannerH, { fill: C.paper, border: C.gold, width: 2.8, seed: seedFor(bannerW, bannerH, 5) });
    banner.x = bx; banner.y = by;
    this.container.addChild(banner);

    const bTitle = txt(t('gacha.title'), Math.round(h * 0.045), C.dark, true);
    bTitle.anchor.set(0.5, 0.5); bTitle.x = w / 2; bTitle.y = by + bannerH * 0.32;
    this.container.addChild(bTitle);

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
    const color = RARITY_COLOR[r.rarity];
    const card = sketchPanel(w, h, { fill: C.paper, border: color, width: 2.6, seed: seedFor(x, y, w) });
    card.x = x; card.y = y;
    this.container.addChild(card);

    // Rarity band at top.
    const band = new PIXI.Graphics();
    band.beginFill(color); band.drawRect(0, 0, w, Math.round(h * 0.22)); band.endFill();
    band.x = x; band.y = y;
    this.container.addChild(band);

    const rarLbl = txt(t(('rarity.' + r.rarity) as TranslationKey), Math.round(h * 0.12), 0xffffff, true);
    rarLbl.anchor.set(0.5, 0.5); rarLbl.x = x + w / 2; rarLbl.y = y + Math.round(h * 0.11);
    this.container.addChild(rarLbl);

    // Item id (placeholder; real skin art pending).
    const idLbl = txt(r.itemId, Math.round(h * 0.10), C.dark);
    idLbl.anchor.set(0.5, 0.5); idLbl.x = x + w / 2; idLbl.y = y + h * 0.58;
    this.container.addChild(idLbl);

    // NEW / duplicate badge.
    const badge = txt(r.duplicate ? t('gacha.duplicate') : t('gacha.new'),
      Math.round(h * 0.11), r.duplicate ? C.mid : C.green, true);
    badge.anchor.set(0.5, 0.5); badge.x = x + w / 2; badge.y = y + h * 0.85;
    this.container.addChild(badge);
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
