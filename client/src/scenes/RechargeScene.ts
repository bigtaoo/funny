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
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage, type ToastKind } from '../net/log';
import { RECHARGE_TIERS, type RechargeTierDef, type RechargeReward } from '../game/balance/rechargeTierDefs';

// ── RechargeScene — Cumulative recharge milestone panel (GACHA_DESIGN §13, ADR-045) ──────────────
//
// Entry point: Shop group peer tab [Shop|Coins|Gacha|BattlePass|Recharge].
// Shows a lifetime progress bar (totalRechargeCents, never resets except on Paddle refund) and a
// single-column list of tier cards, three states: claimable (green) → tap to claim; claimed (grey);
// locked (dashed). Unlike BattlePassScene there is no scroll — 5 tiers fit the viewport directly.

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

  constructor(layout: ILayout, input: InputManager, cb: RechargeCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
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
    for (const h of this.hits) {
      const r = h.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { h.fn(); return; }
    }
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

    // ── Tier list (single column, no scroll — 5 tiers fit the viewport) ─────
    const n = RECHARGE_TIERS.length;
    const gap = Math.round(h * 0.012);
    const availH = h - y - Math.round(h * 0.02);
    const cellH = Math.min(Math.round(h * 0.13), Math.floor((availH - gap * (n - 1)) / n));

    for (let i = 0; i < n; i++) {
      const def = RECHARGE_TIERS[i]!;
      const state: CellState = claimed.has(def.id)
        ? 'claimed'
        : totalRechargeCents >= def.thresholdCents
          ? 'claimable'
          : 'locked';
      this.drawTierCard(pad, y, cw, cellH, def, state);
      y += cellH + gap;
    }

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private drawTierCard(x: number, y: number, w: number, h: number, def: RechargeTierDef, state: CellState): void {
    const fillColor = state === 'claimable' ? 0xe8f5e9 : state === 'claimed' ? 0xf0f0f0 : C.paper;
    const borderColor = state === 'claimable' ? C.green : state === 'claimed' ? C.line : C.line;
    const borderW = state === 'claimable' ? 2 : 1.2;
    const box = sketchPanel(w, h, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    this.container.addChild(box);

    const pad = Math.round(w * 0.03);
    const thresholdLbl = txt(t('recharge.tierThreshold', { amount: usd(def.thresholdCents) }), snapFont(Math.round(h * 0.28)), C.dark, true);
    thresholdLbl.anchor.set(0, 0); thresholdLbl.x = x + pad; thresholdLbl.y = y + Math.round(h * 0.1);
    this.container.addChild(thresholdLbl);

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
      this.container.addChild(glyph);
      const amt = txt(`×${reward.count}`, snapFont(Math.round(h * 0.22)), color, state === 'claimable');
      amt.anchor.set(0, 0.5); amt.x = rx + ic + Math.round(w * 0.01); amt.y = ry + ic / 2;
      this.container.addChild(amt);
      rx += ic + Math.round(w * 0.01) + amt.width + Math.round(w * 0.04);
    }

    // State control, bottom-right corner: claim button / claimed label / locked label.
    const anchorX = x + w - Math.round(w * 0.03);
    const anchorY = y + h - Math.round(h * 0.12);
    if (state === 'claimable') {
      const btnW = Math.round(w * 0.2);
      const btnH = Math.round(h * 0.32);
      const btnX = anchorX - btnW;
      const btnY = anchorY - btnH;
      const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.green, width: 2, seed: seedFor(btnX, btnY, btnW) });
      btn.x = btnX; btn.y = btnY;
      this.container.addChild(btn);
      const lbl = txt(t('recharge.claim'), snapFont(Math.round(btnH * 0.45)), 0xffffff, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = btnX + btnW / 2; lbl.y = btnY + btnH / 2;
      this.container.addChild(lbl);
      if (this.cb.onClaim) {
        this.hits.push({ rect: { x: btnX, y: btnY, w: btnW, h: btnH }, fn: () => this.doClaim(def.id) });
      }
    } else {
      const lbl = state === 'claimed' ? t('recharge.claimed') : t('recharge.locked');
      const l = txt(lbl, snapFont(Math.round(h * 0.24)), C.mid, false);
      l.anchor.set(1, 1); l.x = anchorX; l.y = anchorY;
      this.container.addChild(l);
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
