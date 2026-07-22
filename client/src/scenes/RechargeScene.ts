import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import type { IconKind } from '../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../render/materialAtlas';
import { FS, snapFont } from '../render/fontScale';
import { buildCoinIcon } from '../render/coinIconAtlas';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { peekViewportH } from '../ui/widgets/scrollPeek';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage, type ToastKind } from '../net/log';
import { RECHARGE_TIERS, type RechargeTierDef, type RechargeReward } from '../game/balance/rechargeTierDefs';

// ── RechargeScene — Cumulative recharge milestone panel (GACHA_DESIGN §13, ADR-045) ──────────────
//
// Entry point: Shop group peer tab [Shop|Coins|Gacha|BattlePass|Recharge].
// Shows a lifetime progress bar (totalRechargeCents, never resets except on Paddle refund) and a
// single-column list of tier cards, three states: claimable (green) → tap to claim; claimed (grey);
// locked (dashed). The list scrolls (drag + ScrollIndicator + peek) when the tiers overflow the
// viewport — same scroll harness as BattlePassScene (ScrollTapGesture / updateScrollPosition).

export interface RechargeCallbacks {
  onBack(): void;
  getCoins(): number;
  /** Current cumulative recharge progress + claimed tier ids. Omitted when offline/not logged in → shows "login to view". */
  getData?(): { totalRechargeCents: number; claimed: number[] };
  /** Claim a tier reward. Returns the granted rewards (for the toast). */
  onClaim?(tierId: number): Promise<RechargeReward[]>;
  openShop?(): void;
  openCoins?(): void;
  openGacha?(): void;
  openBattlePass?(): void;
  getShopBadge?(): boolean;
  getBattlePassBadge?(): boolean;
}

interface Hit { rect: Rect; fn: () => void; }

type CellState = 'claimable' | 'claimed' | 'locked';

function coinIconTier(count: number): IconKind {
  if (count >= 2000) return 'coinChest';
  if (count >= 800) return 'coinSack';
  if (count >= 300) return 'coinStack';
  if (count >= 100) return 'coins';
  return 'coin';
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export class RechargeScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: RechargeCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private destroyed = false;
  private readonly bt = new BusyTracker();

  // ── Scroll harness (mirrors BattlePassScene) ──────────────────────────────
  private scrollY = 0;
  private scrollMax = 0;
  /** Tap-vs-drag tracker: defers a card's claim to pointer-up, dropped if the pointer dragged (→ scroll). */
  private readonly gesture = new ScrollTapGesture();
  // Scroll-drag fast path: handleMove only repositions scrollContainer + recomputes hit rects from
  // cached cell defs, no full tearDownChildren/redraw (see BattlePassScene for the rationale).
  private scrollContainer: PIXI.Container | null = null;
  private bodyTopY = 0;
  private staticHits: Hit[] = [];
  private scrollCellDefs: Array<{ x: number; cellY: number; w: number; h: number; fn: () => void }> = [];
  /** Scroll viewport rect (mask bounds), cached so the drag fast-path can redraw the indicator. */
  private scrollView: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private scrollbar: PIXI.Graphics | null = null;

  constructor(layout: ILayout, input: InputManager, cb: RechargeCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.render();
  }

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    // Defer the hit action to pointer-up — a drag past the threshold becomes a scroll and drops the tap,
    // so a drag starting on a card scrolls instead of firing its claim (see BattlePassScene).
    let hit: (() => void) | null = null;
    for (const h of this.hits) {
      const r = h.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit = h.fn; break; }
    }
    this.gesture.down(this.scrollY, y, hit);
  }

  private handleMove(_x: number, y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll !== null) { this.scrollY = Math.min(this.scrollMax, scroll); this.updateScrollPosition(); }
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /**
   * Cheap per-move update: reposition the already-built scroll container and recompute hit rects
   * from cached cell defs, without tearing down/redrawing the tier-card graphics.
   */
  private updateScrollPosition(): void {
    if (!this.scrollContainer) return;
    const sy = Math.min(this.scrollY, this.scrollMax);
    this.scrollContainer.y = this.bodyTopY - sy;
    // Hit rects are pure math, not clipped by the scroll mask — a card scrolled out of the viewport
    // still has a live rect that could steal a tap meant for the header/sidebar. Keep only cards
    // whose rect intersects the viewport.
    const vTop = this.scrollView.y;
    const vBot = this.scrollView.y + this.scrollView.h;
    this.hits = this.staticHits.concat(
      this.scrollCellDefs
        .map((d) => ({ rect: { x: d.x, y: this.bodyTopY - sy + d.cellY, w: d.w, h: d.h }, fn: d.fn }))
        .filter((hit) => hit.rect.y + hit.rect.h > vTop && hit.rect.y < vBot),
    );
    if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, sy, this.scrollMax);
  }

  private showToast(msg: string, kind: ToastKind = 'success'): void {
    showToastMessage(msg, kind);
  }

  /** Shop group nav [Shop|Coins|Gacha|BattlePass|Recharge] — same rail convention as BattlePassScene.drawSidebar. */
  private drawSidebar(tbH: number): void {
    if (!this.cb.openShop) return;
    const { w, h, landscape } = this;
    const tabs: HubTab[] = [{ label: t('shop.title'), active: false, icon: 'tag', badge: this.cb.getShopBadge?.() ?? false }];
    const actions: Array<() => void> = [() => this.cb.openShop?.()];
    if (this.cb.openCoins) {
      tabs.push({ label: t('shop.coinsTab'), active: false, icon: 'coin' });
      actions.push(() => this.cb.openCoins?.());
    }
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    actions.push(() => this.cb.openGacha?.());
    if (this.cb.openBattlePass) {
      tabs.push({ label: t('battlepass.title'), active: false, icon: 'trophy', badge: this.cb.getBattlePassBadge?.() ?? false });
      actions.push(() => this.cb.openBattlePass?.());
    }
    tabs.push({ label: t('recharge.title'), active: true, icon: 'coinChest' });
    actions.push(() => {});
    const sidebarW = sidebarNavW(w, h, landscape);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, (i) => actions[i]?.());
    this.hits.push(...hits);
  }

  private contentBounds(): { x0: number; w: number } {
    const { w, h, landscape } = this;
    const rightPad = Math.round(w * 0.05);
    const x0 = this.cb.openShop ? sidebarNavW(w, h, landscape) + Math.round(w * 0.02) : rightPad;
    return { x0, w: w - x0 - rightPad };
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    this.scrollContainer = null;
    this.scrollCellDefs = [];
    this.scrollbar = null; // torn down with the container above; drop the stale ref
    const { w, h, landscape } = this;

    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('rechargebg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('recharge.title'), { accent: HEADER_ACCENT.spend });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
    drawHeaderCurrency(this.container, w, tbH, this.cb.getCoins());
    this.drawSidebar(tbH);

    const top = tbH;
    const { x0: cx0, w: cw } = this.contentBounds();
    const centerX = cx0 + cw / 2;

    if (!this.cb.getData) {
      const msg = txt(t('recharge.loginRequired'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = centerX; msg.y = h / 2;
      this.container.addChild(msg);
      if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
      return;
    }

    const { totalRechargeCents, claimed: claimedList } = this.cb.getData();
    const claimed = new Set(claimedList);
    const pad = cx0;
    let y = top + Math.round(h * 0.02);

    // ── Lifetime progress readout ──────────────────────────────────────────
    const progLbl = txt(t('recharge.progress', { amount: usd(totalRechargeCents) }), snapFont(Math.round(h * 0.045)), C.dark, true);
    progLbl.anchor.set(0, 0.5); progLbl.x = pad; progLbl.y = y + Math.round(h * 0.02);
    this.container.addChild(progLbl);
    y += Math.round(h * 0.05);

    const hint = txt(t('recharge.hint'), FS.body, C.mid, false, cw);
    hint.anchor.set(0, 0); hint.x = pad; hint.y = y;
    this.container.addChild(hint);
    y += hint.height + Math.round(h * 0.02);

    // ── Scrollable tier list (single column) ────────────────────────────────
    // Static hits captured before the scroll cards so the drag fast-path can rebuild card hits
    // on top of them (back button, sidebar) without a full re-render.
    this.staticHits = this.hits.slice();
    const n = RECHARGE_TIERS.length;
    const cellH = Math.round(h * 0.13);
    const gap = Math.round(h * 0.012);
    const rowStride = cellH + gap;

    const bodyTopY = y;
    const availH = h - bodyTopY - Math.round(h * 0.02);
    const totalContentH = n * rowStride;
    // Peek-adjusted viewport: when the list overflows, the cut lands mid-card so a partial next
    // card peeks above the fold (not just the thin scroll indicator).
    const scrollBodyH = peekViewportH(availH, rowStride, totalContentH);
    this.scrollMax = Math.max(0, totalContentH - scrollBodyH);
    this.scrollView = { x: pad, y: bodyTopY, w: cw, h: scrollBodyH };
    const sy = Math.min(this.scrollY, this.scrollMax);

    const scrollContainer = new PIXI.Container();
    scrollContainer.x = 0;
    scrollContainer.y = bodyTopY - sy;
    this.scrollContainer = scrollContainer;
    this.bodyTopY = bodyTopY;
    this.scrollCellDefs = [];

    for (let i = 0; i < n; i++) {
      const def = RECHARGE_TIERS[i]!;
      const state: CellState = claimed.has(def.id)
        ? 'claimed'
        : totalRechargeCents >= def.thresholdCents
          ? 'claimable'
          : 'locked';
      const cellY = i * rowStride;
      this.drawTierCard(scrollContainer, pad, cellY, cw, cellH, def, state);
      // Whole card is the claim target when claimable (bigger tap target than the button glyph, and
      // matches BattlePassScene's whole-cell hit). updateScrollPosition() derives the absolute rect.
      if (this.cb.onClaim && state === 'claimable') {
        this.scrollCellDefs.push({ x: pad, cellY, w: cw, h: cellH, fn: () => this.doClaim(def.id) });
      }
    }

    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, bodyTopY, w, scrollBodyH).endFill();
    this.container.addChild(maskGfx);
    scrollContainer.mask = maskGfx;
    this.container.addChild(scrollContainer);
    this.updateScrollPosition();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private drawTierCard(parent: PIXI.Container, x: number, y: number, w: number, h: number, def: RechargeTierDef, state: CellState): void {
    const fillColor = state === 'claimable' ? 0xe8f5e9 : state === 'claimed' ? 0xf0f0f0 : C.paper;
    const borderColor = state === 'claimable' ? C.green : state === 'claimed' ? C.line : C.line;
    const borderW = state === 'claimable' ? 2 : 1.2;
    const box = sketchPanel(w, h, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    parent.addChild(box);

    const pad = Math.round(w * 0.03);
    const thresholdLbl = txt(t('recharge.tierThreshold', { amount: usd(def.thresholdCents) }), snapFont(Math.round(h * 0.28)), C.dark, true);
    thresholdLbl.anchor.set(0, 0); thresholdLbl.x = x + pad; thresholdLbl.y = y + Math.round(h * 0.1);
    parent.addChild(thresholdLbl);

    // Reward icons, stacked horizontally beneath the threshold label.
    let rx = x + pad;
    const ry = y + Math.round(h * 0.5);
    const ic = Math.round(h * 0.36);
    for (const reward of def.rewards) {
      const iconKind: IconKind = reward.kind === 'coins' ? coinIconTier(reward.count)
        : reward.id === 'lead' ? 'lead' : reward.id === 'binding' ? 'binding' : 'scrap';
      const color = state === 'claimed' ? C.mid : reward.kind === 'coins' ? C.gold : C.accent;
      const glyph = reward.kind === 'coins'
        ? buildCoinIcon(iconKind, ic, color)
        : buildMaterialIcon(iconKind as MaterialKind, ic, color);
      glyph.x = rx; glyph.y = ry;
      parent.addChild(glyph);
      const amt = txt(`×${reward.count}`, snapFont(Math.round(h * 0.22)), color, state === 'claimable');
      amt.anchor.set(0, 0.5); amt.x = rx + ic + Math.round(w * 0.01); amt.y = ry + ic / 2;
      parent.addChild(amt);
      rx += ic + Math.round(w * 0.01) + amt.width + Math.round(w * 0.04);
    }

    // State control, bottom-right corner: claim button / claimed label / locked label.
    // The whole card is the tap target (hit registered by render's scroll loop); the button is a visual affordance.
    const anchorX = x + w - Math.round(w * 0.03);
    const anchorY = y + h - Math.round(h * 0.12);
    if (state === 'claimable') {
      const btnW = Math.round(w * 0.2);
      const btnH = Math.round(h * 0.32);
      const btnX = anchorX - btnW;
      const btnY = anchorY - btnH;
      const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.green, width: 2, seed: seedFor(btnX, btnY, btnW) });
      btn.x = btnX; btn.y = btnY;
      parent.addChild(btn);
      const lbl = txt(t('recharge.claim'), snapFont(Math.round(btnH * 0.45)), 0xffffff, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = btnX + btnW / 2; lbl.y = btnY + btnH / 2;
      parent.addChild(lbl);
    } else {
      const lbl = state === 'claimed' ? t('recharge.claimed') : t('recharge.locked');
      const l = txt(lbl, snapFont(Math.round(h * 0.24)), C.mid, false);
      l.anchor.set(1, 1); l.x = anchorX; l.y = anchorY;
      parent.addChild(l);
    }
  }

  private doClaim(tierId: number): void {
    if (!this.cb.onClaim || this.bt.busy) return;
    this.bt.start();
    this.render();
    withTimeout(this.cb.onClaim(tierId))
      .then((rewards) => {
        this.bt.stop();
        const coinsReward = rewards.find((r) => r.kind === 'coins');
        if (coinsReward) this.showToast(t('recharge.claimToast', { n: String(coinsReward.count) }));
        else this.render();
      })
      .catch((e) => {
        this.bt.stop();
        this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('recharge.claimFailed'), 'error');
      });
  }
}
