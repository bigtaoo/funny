import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren, marginLineX } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildCoinIcon } from '../render/coinIconAtlas';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData } from '../game/meta/SaveData';
import {
  BATTLEPASS_DEFS, BATTLEPASS_MAX_LEVEL, BATTLEPASS_BUY_COST, BP_XP_PER_LEVEL,
  BP_XP_PER_RANKED_WIN, BP_XP_PER_RANKED_LOSS,
  xpToLevel, xpToNextLevel,
} from '../game/balance/battlepassDefs';

// ── BattlePassScene — Battle Pass panel (SE-9) ────────────────────────────────
//
// Entry point: StatsScene "Battle Pass" button (onOpenBattlePass).
// Displays: current level progress bar + dual track (free/paid) 30-level reward cells, four states:
//   · Claimable (green) → tap to claim; · Claimed (grey); · Locked (dashed); · Pass-locked (gold lock).
// Buy Pass button: always visible at bottom when not purchased (goes through commercial).

export interface BattlePassCallbacks {
  onBack(): void;
  /** Current server-authoritative coin balance (read from SaveData), shown top-right in the header. */
  getCoins(): number;
  /**
   * Get the current save's battle pass data. Returns undefined when not yet joined this season.
   * Omitted when offline/not logged in → shows "login to view".
   */
  getBattlePass?(): SaveData['battlePass'];
  /** Purchase the current season Pass (600 coins). */
  onBuy?(): Promise<void>;
  /** Claim a reward. Returns actual coins awarded (0 = non-coin reward). */
  onClaim?(track: 'free' | 'paid', level: number): Promise<number>;
  /**
   * Direct navigation to sibling shop group tabs (LOBBY_IA_REDESIGN P1.5). Only injected in the
   * "Shop" group context; when injected, a [Shop|Coins|Gacha|BattlePass] tab bar appears at the top,
   * otherwise degrades to plain back button (standalone entry points like achievements).
   */
  openShop?(): void;
  /** Navigate to the shop's Coins tab. Only injected when a real IAP recharge route is available. */
  openCoins?(): void;
  openGacha?(): void;
}

interface Hit { rect: Rect; fn: () => void; }

/** Four cell states for a single reward cell */
type CellState = 'claimable' | 'claimed' | 'locked' | 'pass_required';

/**
 * Coin reward → escalating pile glyph so larger payouts read visibly richer at a glance
 * (single coin → cluster → stack → sack → chest). Milestone jackpots become chests.
 */
function coinIconTier(count: number): IconKind {
  if (count >= 300) return 'coinChest';
  if (count >= 150) return 'coinSack';
  if (count >= 80) return 'coinStack';
  if (count >= 40) return 'coins';
  return 'coin';
}

export class BattlePassScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: BattlePassCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  private readonly bt = new BusyTracker();
  private toast: string | null = null;
  private toastTimer = 0;
  private scrollY = 0;
  private scrollMax = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;

  constructor(layout: ILayout, input: InputManager, cb: BattlePassCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.render();
  }

  update(dt: number): void {
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
  }

  private handleMove(_x: number, y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragStart.scroll - dy));
      this.render();
    }
  }

  private handleUp(): void {
    this.dragStart = null;
  }

  private showToast(msg: string): void {
    this.toast = msg;
    this.toastTimer = 2.5;
    this.render();
  }

  /**
   * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), battle pass active: a
   * vertical rail stacked inside the left notebook-margin gutter (`marginLineX`), mirroring the
   * CardScene/EquipmentScene sidebar convention. Only drawn in group context (openShop injected).
   * Consumes no vertical space — render() shifts body content start x instead.
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
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    actions.push(() => this.cb.openGacha?.());
    tabs.push({ label: t('battlepass.title'), active: true, icon: 'trophy' });
    actions.push(() => {});
    const sidebarW = marginLineX(w);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, (i) => actions[i]?.());
    this.hits.push(...hits);
  }

  /**
   * Content column bounds: left edge shifts right of the sidebar rail when in the shop group
   * (else the standalone 5%-of-w pad); right edge always keeps the 5%-of-w pad.
   */
  private contentBounds(): { x0: number; w: number } {
    const { w } = this;
    const rightPad = Math.round(w * 0.05);
    const x0 = this.cb.openShop ? marginLineX(w) + Math.round(w * 0.02) : rightPad;
    return { x0, w: w - x0 - rightPad };
  }

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('bpbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // ── Title bar ────────────────────────────────────────────────────────────
    const hdr = drawSceneHeader(this.container, w, h, t('battlepass.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): glyph + number, no "金币：" text prefix — matches ShopScene/GachaScene.
    const balNum = txt(this.cb.getCoins().toLocaleString(), Math.round(h * 0.028), C.gold, true);
    balNum.anchor.set(1, 0.5); balNum.x = w - Math.round(w * 0.04); balNum.y = tbH / 2;
    this.container.addChild(balNum);
    const balIcon = Math.round(h * 0.036);
    const bIcon = buildCoinIcon('coin', balIcon, C.gold);
    bIcon.x = balNum.x - balNum.width - balIcon - Math.round(w * 0.008);
    bIcon.y = tbH / 2 - balIcon / 2;
    this.container.addChild(bIcon);

    // Shop group nav (LOBBY_IA_REDESIGN §9): [Shop|Coins|Gacha|BattlePass] sidebar rail, battle pass active. Only drawn in group context.
    this.drawSidebar(tbH);
    const top = tbH;
    const { x0: cx0, w: cw } = this.contentBounds();
    const centerX = cx0 + cw / 2;

    // ── Auth / offline guard ──────────────────────────────────────────────────
    if (!this.cb.getBattlePass) {
      const msg = txt(t('battlepass.loginRequired'), Math.round(h * 0.03), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = centerX; msg.y = h / 2;
      this.container.addChild(msg);
      this.renderToast();
      if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
      return;
    }

    const bp = this.cb.getBattlePass();
    const currentLevel = bp ? xpToLevel(bp.xp) : 1;
    const xp = bp?.xp ?? 0;
    const hasPass = bp?.hasPass ?? false;
    const claimedFree = new Set(bp?.claimedFree ?? []);
    const claimedPaid = new Set(bp?.claimedPaid ?? []);

    const pad = cx0;
    let y = top + Math.round(h * 0.02);

    // ── XP progress bar ───────────────────────────────────────────────────────
    const barH = Math.round(h * 0.07);
    const barW = cw;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(C.line).drawRoundedRect(pad, y, barW, barH, barH / 2).endFill();
    this.container.addChild(barBg);

    const maxXp = BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL;
    const fillFrac = Math.min(1, xp / maxXp);
    if (fillFrac > 0) {
      const fill = new PIXI.Graphics();
      fill.beginFill(C.accent).drawRoundedRect(pad, y, Math.round(barW * fillFrac), barH, barH / 2).endFill();
      this.container.addChild(fill);
    }

    const isMaxed = currentLevel >= BATTLEPASS_MAX_LEVEL;
    const levelLbl = txt(
      isMaxed ? t('battlepass.maxLevel') : t('battlepass.level', { n: String(currentLevel) }),
      Math.round(barH * 0.55), 0xffffff, true,
    );
    levelLbl.anchor.set(0, 0.5); levelLbl.x = pad + Math.round(barW * 0.03); levelLbl.y = y + barH / 2;
    this.container.addChild(levelLbl);

    const xpLbl = txt(
      isMaxed
        ? t('battlepass.xpProgress', { xp: String(maxXp), total: String(maxXp) })
        : t('battlepass.xpStatus', { xp: String(xp), n: String(xpToNextLevel(xp)) }),
      Math.round(barH * 0.42), C.light,
    );
    xpLbl.anchor.set(1, 0.5); xpLbl.x = pad + barW - Math.round(barW * 0.03); xpLbl.y = y + barH / 2;
    this.container.addChild(xpLbl);

    y += barH + Math.round(h * 0.014);

    // "How to earn XP" hint — XP only comes from ranked games (win/loss awards differ).
    if (!isMaxed) {
      const hint = txt(
        t('battlepass.xpEarnHint', { win: String(BP_XP_PER_RANKED_WIN), loss: String(BP_XP_PER_RANKED_LOSS) }),
        Math.round(h * 0.024), C.mid,
      );
      hint.anchor.set(0, 0.5); hint.x = pad + Math.round(barW * 0.01); hint.y = y + Math.round(h * 0.016);
      this.container.addChild(hint);
      y += Math.round(h * 0.032);
    }

    y += Math.round(h * 0.008);

    // ── Buy Pass button (if not purchased) ────────────────────────────────────
    const buyAreaH = Math.round(h * 0.072);
    let bodyTopY = y;
    if (!hasPass && this.cb.onBuy) {
      const btnBox = sketchPanel(barW, buyAreaH, { fill: 0xfef8e0, border: C.gold, width: 2, seed: seedFor(0, y, barW) });
      btnBox.x = pad; btnBox.y = y;
      this.container.addChild(btnBox);
      const btnLbl = txt(t('battlepass.buy', { coins: String(BATTLEPASS_BUY_COST) }), Math.round(buyAreaH * 0.5), C.gold, true);
      btnLbl.anchor.set(0.5, 0.5); btnLbl.x = centerX; btnLbl.y = y + buyAreaH / 2;
      this.container.addChild(btnLbl);
      this.hits.push({
        rect: { x: pad, y, w: barW, h: buyAreaH },
        fn: () => {
          if (!this.cb.onBuy || this.bt.busy) return;
          this.bt.start();
          this.render();
          withTimeout(this.cb.onBuy!())
            .then(() => { this.bt.stop(); this.render(); })
            .catch((e) => { this.bt.stop(); this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('battlepass.buyFailed')); });
        },
      });
      y += buyAreaH + Math.round(h * 0.015);
      bodyTopY = y;
    }

    // ── Scrollable track grid ─────────────────────────────────────────────────
    const headerH = Math.round(h * 0.05);
    const cellH = Math.round(h * 0.075);
    const cellGap = Math.round(h * 0.008);
    const halfW = Math.floor((barW - Math.round(w * 0.02)) / 2);
    const freeX = pad;
    const paidX = pad + halfW + Math.round(w * 0.02);

    const scrollBodyH = h - bodyTopY;
    const totalContentH = headerH + BATTLEPASS_MAX_LEVEL * (cellH + cellGap);
    const scrollMax = Math.max(0, totalContentH - scrollBodyH);
    this.scrollMax = scrollMax;
    const sy = Math.min(this.scrollY, scrollMax);

    const scrollContainer = new PIXI.Container();
    scrollContainer.x = 0;
    scrollContainer.y = bodyTopY - sy;

    // Column headers
    const freeHdr = txt(t('battlepass.free'), Math.round(headerH * 0.6), C.accent, true);
    freeHdr.anchor.set(0.5, 0.5); freeHdr.x = freeX + halfW / 2; freeHdr.y = headerH / 2;
    scrollContainer.addChild(freeHdr);

    const paidHdr = txt(t('battlepass.paid'), Math.round(headerH * 0.6), C.gold, true);
    paidHdr.anchor.set(0.5, 0.5); paidHdr.x = paidX + halfW / 2; paidHdr.y = headerH / 2;
    scrollContainer.addChild(paidHdr);

    // Level rows
    for (let i = 0; i < BATTLEPASS_MAX_LEVEL; i++) {
      const def = BATTLEPASS_DEFS[i]!;
      const lvl = def.level;
      const cellY = headerH + i * (cellH + cellGap);
      const absY = bodyTopY - sy + cellY;

      // Free track
      const freeState = this.cellState('free', lvl, currentLevel, claimedFree, claimedPaid, hasPass, !!def.free);
      this.drawCell(scrollContainer, freeX, cellY, halfW, cellH, lvl, def.free ?? null, freeState);
      if (absY + cellH > bodyTopY && absY < bodyTopY + scrollBodyH && this.cb.onClaim && freeState === 'claimable') {
        this.hits.push({
          rect: { x: freeX, y: absY, w: halfW, h: cellH },
          fn: () => this.doClaim('free', lvl),
        });
      }

      // Paid track
      const paidState = this.cellState('paid', lvl, currentLevel, claimedFree, claimedPaid, hasPass, !!def.paid);
      this.drawCell(scrollContainer, paidX, cellY, halfW, cellH, lvl, def.paid ?? null, paidState);
      if (absY + cellH > bodyTopY && absY < bodyTopY + scrollBodyH && this.cb.onClaim && paidState === 'claimable') {
        this.hits.push({
          rect: { x: paidX, y: absY, w: halfW, h: cellH },
          fn: () => this.doClaim('paid', lvl),
        });
      }
    }

    // Mask
    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, bodyTopY, w, scrollBodyH).endFill();
    this.container.addChild(maskGfx);
    scrollContainer.mask = maskGfx;
    this.container.addChild(scrollContainer);

    this.renderToast();
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private cellState(
    track: 'free' | 'paid',
    level: number,
    currentLevel: number,
    claimedFree: Set<number>,
    claimedPaid: Set<number>,
    hasPass: boolean,
    hasReward: boolean,
  ): CellState {
    if (!hasReward) return 'locked';
    const claimed = track === 'free' ? claimedFree.has(level) : claimedPaid.has(level);
    if (claimed) return 'claimed';
    if (level > currentLevel) return 'locked';
    if (track === 'paid' && !hasPass) return 'pass_required';
    return 'claimable';
  }

  private drawCell(
    parent: PIXI.Container,
    x: number, y: number, w: number, h: number,
    level: number,
    reward: { kind: string; id?: string; count: number } | null,
    state: CellState,
  ): void {
    // Milestone rows (every 5th level) carry the coin jackpots — tint them gold so they stand out
    // from the material-filler rows, unless an active state (claimable/claimed) owns the colour.
    const milestone = level % 5 === 0;
    const fillColor = state === 'claimable' ? 0xe8f5e9
      : state === 'claimed' ? 0xf0f0f0
        : milestone ? 0xfdf3d0
          : C.paper;
    const borderColor = state === 'claimable' ? C.green
      : state === 'claimed' ? C.line
        : (state === 'pass_required' || milestone) ? C.gold
          : C.line;
    const borderW = state === 'claimable' ? 2 : milestone ? 1.8 : 1.2;

    const box = sketchPanel(w, h, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y + level, w) });
    box.x = x; box.y = y;
    parent.addChild(box);

    // Level badge (+ a gold star flag on milestone rows).
    const lvlTxt = txt(t('battlepass.level', { n: String(level) }), Math.round(h * 0.32), C.mid);
    lvlTxt.anchor.set(0, 0); lvlTxt.x = x + Math.round(w * 0.05); lvlTxt.y = y + Math.round(h * 0.08);
    parent.addChild(lvlTxt);
    if (milestone) {
      const stSz = Math.round(h * 0.26);
      const star = buildIcon('star', stSz, C.gold);
      star.x = lvlTxt.x + lvlTxt.width + Math.round(w * 0.03); star.y = y + Math.round(h * 0.06);
      parent.addChild(star);
    }

    // Reward: hand-drawn glyph + amount. Coins use an escalating pile icon (coinIconTier) so a
    // 20-coin drop and a 520-coin jackpot read differently; materials use their craft icon.
    if (reward) {
      const iconKind: IconKind =
        reward.kind === 'coins' ? coinIconTier(reward.count)
          : reward.kind === 'skin' ? 'brush'
            : reward.id === 'lead' ? 'lead'
              : reward.id === 'binding' ? 'binding'
                : 'scrap';
      const rewardColor = state === 'claimed' ? C.mid : reward.kind === 'coins' ? C.gold : C.accent;
      const cy = y + h * 0.62;
      const ic = Math.round(h * 0.5);
      const glyph = reward.kind === 'coins'
        ? buildCoinIcon(iconKind, ic, rewardColor)
        : buildIcon(iconKind, ic, rewardColor);
      if (reward.kind === 'skin') {
        // Skins are singletons — glyph alone, centred.
        glyph.x = x + w / 2 - ic / 2; glyph.y = cy - ic / 2;
        parent.addChild(glyph);
      } else {
        const rew = txt(`×${reward.count}`, Math.round(h * 0.4), rewardColor, state === 'claimable');
        const gap = Math.round(w * 0.02);
        const groupW = ic + gap + rew.width;
        const gx = x + w / 2 - groupW / 2;
        glyph.x = gx; glyph.y = cy - ic / 2;
        rew.anchor.set(0, 0.5); rew.x = gx + ic + gap; rew.y = cy;
        parent.addChild(glyph, rew);
      }
    }

    // State overlay — pass_required shows a lock glyph; other states show a text label.
    // Both anchor to the cell's bottom-right corner.
    const anchorX = x + w - Math.round(w * 0.05);
    const anchorY = y + h - Math.round(h * 0.08);
    if (state === 'pass_required') {
      const lockSz = Math.round(h * 0.32);
      const lock = buildIcon('lock', lockSz, C.gold);
      lock.x = anchorX - lockSz; lock.y = anchorY - lockSz;
      parent.addChild(lock);
    } else {
      let stateLbl: string | null = null;
      if (state === 'claimed') stateLbl = t('battlepass.claimed');
      else if (state === 'locked') stateLbl = t('battlepass.locked');
      else if (state === 'claimable') stateLbl = t('battlepass.claim');

      if (stateLbl) {
        const stateColor = state === 'claimable' ? C.green : C.mid;
        const sl = txt(stateLbl, Math.round(h * 0.34), stateColor, state === 'claimable');
        sl.anchor.set(1, 1); sl.x = anchorX; sl.y = anchorY;
        parent.addChild(sl);
      }
    }
  }

  private doClaim(track: 'free' | 'paid', level: number): void {
    if (!this.cb.onClaim || this.bt.busy) return;
    this.bt.start();
    this.render();
    withTimeout(this.cb.onClaim(track, level))
      .then((coins) => {
        this.bt.stop();
        if (coins > 0) this.showToast(t('battlepass.claimToast', { n: String(coins) }));
        else this.render();
      })
      .catch((e) => {
        this.bt.stop();
        this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('battlepass.claimFailed'));
      });
  }

  private renderToast(): void {
    if (!this.toast) return;
    const { w, h } = this;
    const tBg = new PIXI.Graphics();
    tBg.beginFill(C.dark, 0.88).drawRoundedRect(Math.round(w * 0.15), Math.round(h * 0.82), Math.round(w * 0.7), Math.round(h * 0.08), 8).endFill();
    this.container.addChild(tBg);
    const tTxt = txt(this.toast, Math.round(h * 0.028), 0xffffff);
    tTxt.anchor.set(0.5, 0.5); tTxt.x = w / 2; tTxt.y = Math.round(h * 0.86);
    this.container.addChild(tTxt);
  }
}
