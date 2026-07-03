import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData } from '../game/meta/SaveData';
import {
  BATTLEPASS_DEFS, BATTLEPASS_MAX_LEVEL, BATTLEPASS_BUY_COST, BP_XP_PER_LEVEL,
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
   * "Shop" group context; when injected, a [Shop|Gacha|BattlePass] tab bar appears at the top,
   * otherwise degrades to plain back button (standalone entry points like achievements).
   */
  openShop?(): void;
  openGacha?(): void;
}

interface Hit { rect: Rect; fn: () => void; }

/** Four cell states for a single reward cell */
type CellState = 'claimable' | 'claimed' | 'locked' | 'pass_required';

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

  constructor(layout: ILayout, input: InputManager, cb: BattlePassCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
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
  }

  private showToast(msg: string): void {
    this.toast = msg;
    this.toastTimer = 2.5;
    this.render();
  }

  /** Shop group tab bar (battle pass active). Only drawn in group context (openShop injected); returns body start y. */
  private drawGroupTabs(tbH: number): number {
    if (!this.cb.openShop) return tbH;
    const { w, h } = this;
    const stripH = hubTabsHeight(h);
    const tabs: HubTab[] = [
      { label: t('shop.title'), active: false, icon: 'tag' },
      { label: t('gacha.title'), active: false, icon: 'capsule' },
      { label: t('battlepass.title'), active: true, icon: 'trophy' },
    ];
    const hits = drawHubTabs(this.container, w, tbH, stripH, tabs, (i) => {
      if (i === 0) this.cb.openShop?.();
      else if (i === 1) this.cb.openGacha?.();
    });
    this.hits.push(...hits);
    return tbH + stripH;
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

    // Shop group tab bar (LOBBY_IA_REDESIGN P1.5): [Shop|Gacha|BattlePass], battle pass active. Only drawn in group context.
    const top = this.drawGroupTabs(tbH);

    // ── Auth / offline guard ──────────────────────────────────────────────────
    if (!this.cb.getBattlePass) {
      const msg = txt(t('battlepass.loginRequired'), Math.round(h * 0.03), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = w / 2; msg.y = h / 2;
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

    const pad = Math.round(w * 0.05);
    let y = top + Math.round(h * 0.02);

    // ── XP progress bar ───────────────────────────────────────────────────────
    const barH = Math.round(h * 0.07);
    const barW = w - pad * 2;
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
        : t('battlepass.xpToNext', { n: String(xpToNextLevel(xp)) }),
      Math.round(barH * 0.42), C.light,
    );
    xpLbl.anchor.set(1, 0.5); xpLbl.x = pad + barW - Math.round(barW * 0.03); xpLbl.y = y + barH / 2;
    this.container.addChild(xpLbl);

    y += barH + Math.round(h * 0.018);

    // ── Buy Pass button (if not purchased) ────────────────────────────────────
    const buyAreaH = Math.round(h * 0.072);
    let bodyTopY = y;
    if (!hasPass && this.cb.onBuy) {
      const btnBox = sketchPanel(barW, buyAreaH, { fill: 0xfef8e0, border: C.gold, width: 2, seed: seedFor(0, y, barW) });
      btnBox.x = pad; btnBox.y = y;
      this.container.addChild(btnBox);
      const btnLbl = txt(t('battlepass.buy', { coins: String(BATTLEPASS_BUY_COST) }), Math.round(buyAreaH * 0.5), C.gold, true);
      btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = y + buyAreaH / 2;
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
    const fillColor = state === 'claimable' ? 0xe8f5e9 : state === 'claimed' ? 0xf0f0f0 : C.paper;
    const borderColor = state === 'claimable' ? C.green : state === 'claimed' ? C.line : state === 'pass_required' ? C.gold : C.line;
    const borderW = state === 'claimable' ? 2 : 1.2;

    const box = sketchPanel(w, h, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y + level, w) });
    box.x = x; box.y = y;
    parent.addChild(box);

    // Level badge
    const lvlTxt = txt(t('battlepass.level', { n: String(level) }), Math.round(h * 0.32), C.mid);
    lvlTxt.anchor.set(0, 0); lvlTxt.x = x + Math.round(w * 0.05); lvlTxt.y = y + Math.round(h * 0.08);
    parent.addChild(lvlTxt);

    // Reward: hand-drawn type glyph + amount (coins → coin, material → its craft icon, skin → brush).
    if (reward) {
      const iconKind: IconKind =
        reward.kind === 'coins' ? 'coin'
          : reward.kind === 'skin' ? 'brush'
            : reward.id === 'lead' ? 'lead'
              : reward.id === 'binding' ? 'binding'
                : 'scrap';
      const rewardColor = state === 'claimed' ? C.mid : reward.kind === 'coins' ? C.gold : C.accent;
      const cy = y + h * 0.62;
      const ic = Math.round(h * 0.42);
      const glyph = buildIcon(iconKind, ic, rewardColor);
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
