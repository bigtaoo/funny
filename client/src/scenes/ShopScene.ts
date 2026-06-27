import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import type { ShopItem } from '../net/ApiClient';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { caretDisplay } from '../render/inputDisplay';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';

// ── ShopScene (S2-6) — direct-purchase shop + virtual top-up entry ─────────────
//
// Canvas-drawn (mirrors LoginScene/RoomScene): a render()-on-change tree with a
// flat hit-list, plus a hidden <input> for the top-up code overlay. The economy
// itself is server-authoritative — every buy/top-up returns a fresh SaveData that
// the app adopts; this scene only reads the current wallet via getCoins() and
// re-renders. Gacha lives in its own scene, reached via the 🎁 button.

/** Outcome of a buy/top-up — ok, or a message key to surface as a toast. */
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
  /** Virtual top-up: a magic code credits coins (dev stub; real IAP SDK later). */
  recharge(code: string): Promise<ShopActionResult>;
  openGacha(): void;
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

  /** Top-up code overlay state. */
  private rechargeOpen = false;
  private rechargeCode = '';
  private caretOn = true;
  private caretTimer = 0;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private hiddenInput: HTMLInputElement | null = null;

  constructor(layout: ILayout, input: InputManager, cb: ShopSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.setupHiddenInput();
    this.render();
    void this.loadItems();
  }

  // ── Scene interface ──────────────────────────────────────────────────────────

  update(dt: number): void {
    if (this.rechargeOpen) {
      this.caretTimer += dt;
      if (this.caretTimer >= 0.5) { this.caretTimer = 0; this.caretOn = !this.caretOn; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.unsubs.forEach((u) => u());
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
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

  // ── Hidden input (top-up code capture) ─────────────────────────────────────────

  private setupHiddenInput(): void {
    if (typeof document === 'undefined') return; // non-DOM platform
    const el = document.createElement('input');
    el.type = 'text';
    el.autocomplete = 'off';
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;' +
      'border:0;padding:0;margin:0;font-size:16px;z-index:-1;';
    el.addEventListener('input', () => {
      if (this.rechargeOpen) { this.rechargeCode = el.value; this.render(); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void this.submitRecharge(); }
    });
    document.body.appendChild(el);
    this.hiddenInput = el;
  }

  private openRecharge(): void {
    this.rechargeOpen = true;
    this.rechargeCode = '';
    this.toast = null;
    this.caretOn = true; this.caretTimer = 0;
    const el = this.hiddenInput;
    if (el) { el.value = ''; el.focus(); }
    this.render();
  }

  private closeRecharge(): void {
    this.rechargeOpen = false;
    this.hiddenInput?.blur();
    this.render();
  }

  private async submitRecharge(): Promise<void> {
    if (this.bt.busy) return;
    const code = this.rechargeCode.trim();
    if (!code) { this.closeRecharge(); return; }
    this.bt.start();
    this.rechargeOpen = false;
    this.hiddenInput?.blur();
    this.render();
    try {
      const res = await withTimeout(this.cb.recharge(code));
      this.toast = res.ok
        ? { text: t('shop.rechargeOk', { coins: res.coins ?? 0 }), color: C.green }
        : { text: t('shop.rechargeFail'), color: C.red };
    } catch (e) {
      this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.rechargeFail'), color: C.red };
    } finally {
      this.bt.stop();
      this.render();
    }
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
    tearDownChildren(this.container); // caret blink (~2×/s) + per-keystroke recharge field → free Text textures
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawList(tbH);
    this.drawFooter();
    if (this.toast) this.drawToast();
    if (this.rechargeOpen) this.drawRechargeOverlay();
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

  private drawList(tbH: number): void {
    const { w, h } = this;
    const listX = Math.round(w * 0.06);
    const listW = w - listX * 2;
    let y = tbH + Math.round(h * 0.04);

    if (this.loading) {
      const lbl = txt(t('shop.loading'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = tbH + Math.round(h * 0.18);
      this.container.addChild(lbl);
      return;
    }
    if (!this.items || this.items.length === 0) {
      const lbl = txt(t('shop.empty'), Math.round(h * 0.028), C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = tbH + Math.round(h * 0.18);
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

  /** Bottom row: gacha + top-up entries. */
  private drawFooter(): void {
    const { w, h } = this;
    const navH = Math.round(h * 0.10);
    const y = h - navH;
    const navBg = new PIXI.Graphics();
    navBg.beginFill(C.dark, 0.92); navBg.drawRect(0, y, w, navH); navBg.endFill();
    this.container.addChild(navBg);

    const bw = Math.round(w * 0.40);
    const bh = Math.round(navH * 0.62);
    const by = y + (navH - bh) / 2;
    const gap = Math.round(w * 0.04);
    const totalW = bw * 2 + gap;
    const startX = (w - totalW) / 2;

    this.addButton(t('shop.openGacha'), startX, by, bw, bh, C.dark, C.gold, () => this.cb.openGacha());
    this.addButton(t('shop.recharge'), startX + bw + gap, by, bw, bh, C.dark, C.green,
      () => this.openRecharge());
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

  private drawRechargeOverlay(): void {
    const { w, h } = this;
    // Overlay is modal: discard the base-scene hits drawn underneath so only the
    // overlay's controls are tappable (handleDown matches the first hit in order).
    this.hits = [];

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
    this.container.addChild(dim);

    const panelW = Math.round(w * 0.84);
    const panelH = Math.round(h * 0.40);
    const px = (w - panelW) / 2;
    const py = (h - panelH) / 2;
    const panel = sketchPanel(panelW, panelH, { fill: C.bg, border: C.gold, width: 2.4, seed: seedFor(panelW, panelH, 7) });
    panel.x = px; panel.y = py;
    this.container.addChild(panel);

    const title = txt(t('shop.rechargeTitle'), Math.round(h * 0.030), C.dark, true);
    title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.03);
    this.container.addChild(title);

    const hint = txt(t('shop.rechargeHint'), Math.round(h * 0.020), C.mid);
    hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = py + Math.round(h * 0.075);
    this.container.addChild(hint);

    // Code field.
    const fieldW = Math.round(panelW * 0.84);
    const fieldH = Math.round(h * 0.072);
    const fieldX = (w - fieldW) / 2;
    const fieldY = py + Math.round(h * 0.13);
    const box = sketchPanel(fieldW, fieldH, { fill: C.paper, border: C.accent, width: 2, seed: seedFor(fieldX, fieldY, fieldW) });
    box.x = fieldX; box.y = fieldY;
    this.container.addChild(box);

    const hasText = this.rechargeCode.length > 0;
    const display = caretDisplay(this.rechargeCode, this.caretOn, t('shop.tapToType'));
    const valTxt = txt(display, Math.round(fieldH * 0.40), (hasText || this.caretOn) ? C.dark : C.light);
    valTxt.anchor.set(0, 0.5); valTxt.x = fieldX + Math.round(fieldW * 0.04); valTxt.y = fieldY + fieldH / 2;
    this.container.addChild(valTxt);
    this.hits.push({ rect: { x: fieldX, y: fieldY, w: fieldW, h: fieldH }, fn: () => this.hiddenInput?.focus() });

    // Confirm / cancel.
    const btnW = Math.round(panelW * 0.40);
    const btnH = Math.round(h * 0.072);
    const btnY = py + panelH - btnH - Math.round(h * 0.03);
    const btnGap = Math.round(panelW * 0.04);
    const btnStartX = px + (panelW - btnW * 2 - btnGap) / 2;
    this.addButton(t('shop.rechargeCancel'), btnStartX, btnY, btnW, btnH, C.paper, C.mid,
      () => this.closeRecharge(), C.dark);
    this.addButton(t('shop.rechargeConfirm'), btnStartX + btnW + btnGap, btnY, btnW, btnH, C.dark, C.green,
      () => void this.submitRecharge());

    // Hit priority (handleDown returns on first match): field + buttons above were
    // pushed first; a panel-area no-op next; the full-screen cancel goes LAST so a
    // tap anywhere outside the panel dismisses it, but taps inside don't.
    this.hits.push({ rect: { x: px, y: py, w: panelW, h: panelH }, fn: () => { /* keep open */ } });
    this.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => this.closeRecharge() });
  }

  private addButton(
    label: string, x: number, y: number, w: number, h: number,
    fill: number, stroke: number, fn: () => void, textColor = 0xffffff,
  ): void {
    const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
    g.x = x; g.y = y;
    this.container.addChild(g);

    const tl = txt(label, Math.round(h * 0.38), textColor, true);
    tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
    this.container.addChild(tl);

    this.hits.push({ rect: { x, y, w, h }, fn });
  }
}
