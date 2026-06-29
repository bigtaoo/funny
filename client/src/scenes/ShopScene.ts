import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { ShopItem } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';

// ── ShopScene (S2-6) — direct-purchase shop ────────────────────────────────────
//
// Canvas-drawn (mirrors LoginScene/RoomScene): a render()-on-change tree with a
// flat hit-list. The economy itself is server-authoritative — every buy returns a
// fresh SaveData that the app adopts; this scene only reads the current wallet via
// getCoins() and re-renders. Gacha lives in its own scene, reached via the 🎁 tab.
// (Top-up: the dev magic-code path was removed; real IAP / 优惠码兑换 lands later.)

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
  openGacha(): void;
  /**
   * 战令 Battle Pass 入口（LOBBY_IA_REDESIGN §3：付费主轴并入「商城」tab，主页不放 banner）。
   * 仅登录在线时提供；缺省时不绘制该按钮。点击导航到 BattlePassScene（返回回到商城）。
   */
  openBattlePass?(): void;
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

  /** Transient toast message (success / error), cleared on next action. */
  private toast: { text: string; color: number } | null = null;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.loadItems();
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
  }

  // ── Loading ──────────────────────────────────────────────────────────────────

  private async loadItems(): Promise<void> {
    try {
      this.items = await this.cb.loadItems();
    } catch {
      // 加载失败别假装空店：明确提示玩家（返回重进即重试）。
      this.items = [];
      this.toast = { text: t('common.networkError'), color: C.red };
    }
    this.loading = false;
    this.render();
  }

  // ── Buy ──────────────────────────────────────────────────────────────────────

  private async onBuy(itemId: string): Promise<void> {
    if (this.bt.busy) return;
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

  // ── Input ──────────────────────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    tearDownChildren(this.container); // free Text textures on each rebuild
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    const top = this.drawGroupTabs(tbH);
    this.drawList(top);
    if (this.toast) this.drawToast();
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, this.w, this.h, this.bt.dots, t('common.processing'));
  }

  private drawBackground(): void {
    this.container.addChild(buildPaperBackground('shopbg', this.w, this.h));
  }

  /** Header bar with title, back, and coin balance. Returns its height. */
  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('shop.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right).
    const coins = txt(t('shop.coins', { coins: this.cb.getCoins() }), Math.round(h * 0.026), C.gold, true);
    coins.anchor.set(1, 0.5); coins.x = w - Math.round(w * 0.04); coins.y = tbH / 2;
    this.container.addChild(coins);

    return tbH;
  }

  /**
   * 商城分组 tab 条（LOBBY_IA_REDESIGN P1.5）：[商城|盲盒|战令]，商城 active。
   * 战令格仅在 openBattlePass 提供（登录在线）时出现。返回正文起点 y（strip 下沿）。
   */
  private drawGroupTabs(tbH: number): number {
    const { w, h } = this;
    const stripH = hubTabsHeight(h);
    const tabs: HubTab[] = [
      { label: t('shop.title'), active: true },
      { label: t('gacha.title'), active: false },
    ];
    if (this.cb.openBattlePass) tabs.push({ label: t('battlepass.title'), active: false });
    const hits = drawHubTabs(this.container, w, tbH, stripH, tabs, (i) => {
      if (i === 1) this.cb.openGacha();
      else if (i === 2) this.cb.openBattlePass?.();
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
    if (!this.items || this.items.length === 0) {
      const lbl = txt(t('shop.empty'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = top + Math.round(h * 0.14);
      this.container.addChild(lbl);
      return;
    }

    const rowH = Math.round(h * 0.10);
    const gap = Math.round(h * 0.018);
    const owned = new Set(this.cb.getOwnedSkins());
    for (const item of this.items) {
      this.drawItemRow(item, owned.has(item.grants ?? item.id), listX, y, listW, rowH);
      y += rowH + gap;
    }
  }

  private drawItemRow(
    item: ShopItem, isOwned: boolean, x: number, y: number, w: number, h: number,
  ): void {
    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, C.accent, seedFor(x, h, 3));
    this.container.addChild(box);

    // Name (placeholder: kind label + id, real skin art/names pending).
    const name = txt(`${t('shop.skinLabel')} · ${item.id}`, Math.round(h * 0.22), C.dark, true);
    name.anchor.set(0, 0.5); name.x = x + Math.round(w * 0.04); name.y = y + h * 0.36;
    this.container.addChild(name);

    const cost = txt(`◎ ${item.cost}`, Math.round(h * 0.22), C.gold, true);
    cost.anchor.set(0, 0.5); cost.x = x + Math.round(w * 0.04); cost.y = y + h * 0.70;
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
