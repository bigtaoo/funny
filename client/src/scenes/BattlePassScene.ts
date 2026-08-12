import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { FS, snapFont } from '../render/fontScale';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader, drawHeaderCurrency, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage, type ToastKind } from '../net/log';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { peekViewportH } from '../ui/widgets/scrollPeek';
import { wheelScrollY } from '../ui/wheelScroll';
import type { SaveData } from '../game/meta/SaveData';
import {
  BATTLEPASS_DEFS, BATTLEPASS_MAX_LEVEL, BATTLEPASS_BUY_COST, BP_XP_PER_LEVEL,
  BP_XP_PER_RANKED_WIN, BP_XP_PER_RANKED_LOSS,
  xpToLevel, xpToNextLevel,
} from '../game/balance/battlepassDefs';
import { cellState } from './BattlePassScene/cell';
import { RewardRowVirtualizer, type RowVizContext } from './BattlePassScene/rows';

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
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene changes the wallet. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
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
  /** Whether the Shop peer tab has an unclaimed monthly-card reward (mirrors ShopScene's own Shop-tab badge, LOBBY_IA_REDESIGN P1.5). */
  getShopBadge?(): boolean;
  /** Cumulative recharge milestone entry point (GACHA_DESIGN §13, ADR-045). Only provided when logged in online; absent = tab not drawn. */
  openRecharge?(): void;
  /** Whether the Recharge peer tab has a claimable milestone reward at the current cumulative spend. */
  getRechargeBadge?(): boolean;
}

interface Hit { rect: Rect; fn: () => void; }

export class BattlePassScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: BattlePassCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async re-render can't paint into a torn-down container. */
  private destroyed = false;

  private readonly bt = new BusyTracker();
  private scrollY = 0;
  private scrollMax = 0;
  /**
   * Tap-vs-drag gesture tracker: defers a reward cell's hit action to pointer-up and drops it if the
   * pointer dragged (so a drag starting on a reward cell scrolls instead of firing it). See ScrollTapGesture.
   */
  private readonly gesture = new ScrollTapGesture();
  /**
   * One-shot flag: on the first render that has battle-pass data we auto-scroll so the current
   * level lands on the 3rd visible reward row (two earned rows above it as context). Subsequent
   * renders (claim / toast / manual drag) must not snap back, so this only runs once.
   */
  private scrolledToCurrent = false;

  // Scroll-drag fast path (avoids full tearDownChildren+redraw of all 30 reward cells per
  // pointermove — that was the dropped-frames cause). handleMove only repositions
  // scrollContainer and recomputes hit rects from cached cell defs; render() still does the
  // full rebuild for everything else (claim, buy, toast, data refresh).
  private scrollContainer: PIXI.Container | null = null;
  private bodyTopY = 0;
  private staticHits: Hit[] = [];
  /**
   * Portrait's bottom nav bar hits (§18) — kept separate from `staticHits` because drawSidebar()
   * runs *after* the scroll body is built (so the bar visually paints on top of it), which is after
   * `staticHits` was already captured. `updateScrollPosition()` prepends this on every rebuild
   * (including the drag fast-path) so the bar stays tappable mid-drag. Empty in landscape, where
   * the rail is drawn early and folds into `staticHits` as before.
   */
  private navHits: Hit[] = [];
  private scrollCellDefs: Array<{ x: number; cellY: number; w: number; h: number; fn: () => void }> = [];
  /** Scroll viewport rect (mask bounds), cached so the drag fast-path can redraw the indicator. */
  private scrollView: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private scrollbar: PIXI.Graphics | null = null;

  // Reward-cell virtualization (see BattlePassScene/rows.ts for the why — mobile OOM/reload bug,
  // 2026-08-12): only rows within one viewport of the visible area are built as real PIXI
  // DisplayObjects; scrollCellDefs above (hit-test only, cheap) still covers all levels
  // unconditionally as before. Composed rather than inlined so this class stays under the
  // 500-line convention (client-modules.md). `rowCtx` caches the per-render level/track state
  // sync() needs, since it's also called from the drag/wheel fast path (updateScrollPosition),
  // not just from render().
  private readonly rowViz = new RewardRowVirtualizer();
  private rowCtx: RowVizContext | null = null;

  constructor(layout: ILayout, input: InputManager, cb: BattlePassCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => this.render()));
    this.render();
  }

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    this.rowViz.clear();
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    // Defer the hit action to pointer-up — if the pointer drags past the threshold it becomes a
    // scroll and the tap is dropped, so a drag starting on a reward cell scrolls instead of firing it.
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

  /**
   * Cheap per-move update: reposition the already-built scroll container and recompute hit
   * rects from cached cell defs, without tearing down/redrawing the reward-cell graphics.
   */
  private updateScrollPosition(): void {
    if (!this.scrollContainer) return;
    const sy = Math.min(this.scrollY, this.scrollMax);
    this.scrollContainer.y = this.bodyTopY - sy;
    // Cell hit rects are pure math, not clipped by the scroll mask — so a cell scrolled *out* of
    // the viewport (above bodyTopY, or below the bottom edge) still has a live rect that could
    // steal a tap meant for the header/XP bar. Keep only cells whose rect intersects the viewport.
    const vTop = this.scrollView.y;
    const vBot = this.scrollView.y + this.scrollView.h;
    this.hits = this.navHits.concat(
      this.staticHits,
      this.scrollCellDefs
        .map((d) => ({ rect: { x: d.x, y: this.bodyTopY - sy + d.cellY, w: d.w, h: d.h }, fn: d.fn }))
        .filter((hit) => hit.rect.y + hit.rect.h > vTop && hit.rect.y < vBot),
    );
    if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, sy, this.scrollMax);
    if (this.rowCtx) this.rowViz.sync(this.scrollContainer, this.scrollY, this.scrollMax, this.scrollView.h, this.rowCtx);
  }

  private handleUp(): void {
    // Fires only for a genuine tap (pointer didn't drag); a released drag returns null.
    this.gesture.up()?.();
  }

  /** Mouse-wheel scroll over the reward track (browser/PC only — see wheelScroll.ts). */
  private handleWheel(y: number, deltaY: number): void {
    const next = wheelScrollY(this.scrollView.y, this.scrollView.y + this.scrollView.h, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.updateScrollPosition(); }
  }

  private showToast(msg: string, kind: ToastKind = 'success'): void {
    showToastMessage(msg, kind);
  }

  /**
   * Shop group nav [Shop|Coins|Gacha|BattlePass] (LOBBY_IA_REDESIGN §9), battle pass active. Only
   * drawn in group context (openShop injected). Landscape: a vertical rail (`sidebarNavW`, matching
   * every other hub's left tab rail) — consumes no vertical space, render() shifts body content
   * start x instead. Portrait: a bottom nav bar instead (§18), drawn after the body (see render())
   * so it's never run under by the scroll track; hits are unshifted to the front to match.
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
    tabs.push({ label: t('gacha.title'), active: false, icon: 'capsule' });
    actions.push(() => this.cb.openGacha?.());
    tabs.push({ label: t('battlepass.title'), active: true, icon: 'trophy' });
    actions.push(() => {});
    if (this.cb.openRecharge) {
      tabs.push({ label: t('recharge.title'), active: false, icon: 'coinChest', badge: this.cb.getRechargeBadge?.() ?? false });
      actions.push(() => this.cb.openRecharge?.());
    }
    const onSelect = (i: number): void => actions[i]?.();
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(this.container, w, h - barH, barH, tabs, onSelect);
      // Kept in navHits (see field doc) rather than unshifted into `this.hits` directly — the
      // scroll-content render path rebuilds `this.hits` via updateScrollPosition() right after this
      // call, which folds navHits back in; the no-scroll early-return path never calls
      // updateScrollPosition(), so it also unshifts directly here to take effect immediately.
      this.navHits = hits.map((hit) => ({ rect: hit.rect, fn: hit.fn }));
      this.hits.unshift(...hits);
      return;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(this.container, sidebarW, tbH, h, tabs, onSelect);
    this.hits.push(...hits);
  }

  /**
   * Content column bounds: left edge shifts right of the sidebar rail when in the shop group AND
   * landscape (portrait's bottom bar reserves no width — else the standalone 5%-of-w pad); right
   * edge always keeps the 5%-of-w pad.
   */
  private contentBounds(): { x0: number; w: number } {
    const { w, h, landscape } = this;
    const rightPad = Math.round(w * 0.05);
    const x0 = this.cb.openShop && landscape ? sidebarNavW(w, h, true) + Math.round(w * 0.02) : rightPad;
    return { x0, w: w - x0 - rightPad };
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    this.navHits = [];
    this.scrollContainer = null;
    this.scrollCellDefs = [];
    this.scrollbar = null; // torn down with the container above; drop the stale ref
    this.rowViz.clear(); // rows already destroyed by tearDownChildren above; just drop refs
    const { w, h, landscape } = this;

    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('bpbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // ── Title bar ────────────────────────────────────────────────────────────
    const hdr = drawSceneHeader(this.container, w, h, t('battlepass.title'), { accent: HEADER_ACCENT.spend });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Coin balance (top-right): shared header readout — identical across every scene.
    drawHeaderCurrency(this.container, w, tbH, this.cb.getCoins());

    // Shop group nav (LOBBY_IA_REDESIGN §9): [Shop|Coins|Gacha|BattlePass], battle pass active. Only
    // drawn in group context. Landscape draws it now (disjoint rail); portrait defers to after the
    // body (see bottom of this method) so the bottom bar paints on top.
    if (landscape) this.drawSidebar(tbH);
    const top = tbH;
    const { x0: cx0, w: cw } = this.contentBounds();
    const centerX = cx0 + cw / 2;

    // ── Auth / offline guard ──────────────────────────────────────────────────
    if (!this.cb.getBattlePass) {
      const msg = txt(t('battlepass.loginRequired'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = centerX; msg.y = h / 2;
      this.container.addChild(msg);
      if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
      if (!landscape) this.drawSidebar(tbH);
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
      snapFont(Math.round(barH * 0.55)), 0xffffff, true,
    );
    levelLbl.anchor.set(0, 0.5); levelLbl.x = pad + Math.round(barW * 0.03); levelLbl.y = y + barH / 2;
    this.container.addChild(levelLbl);

    const xpLbl = txt(
      isMaxed
        ? t('battlepass.xpProgress', { xp: String(maxXp), total: String(maxXp) })
        : t('battlepass.xpStatus', { xp: String(xp), n: String(xpToNextLevel(xp)) }),
      snapFont(Math.round(barH * 0.42)), C.light,
    );
    xpLbl.anchor.set(1, 0.5); xpLbl.x = pad + barW - Math.round(barW * 0.03); xpLbl.y = y + barH / 2;
    // Both labels' font sizes scale off barH (bar *height*), but barW is the content column's
    // *width* — narrow in portrait. "{xp} XP · {n} XP to next level" (and German's longer
    // wording) can out-measure the gap left of it by levelLbl, rendering the two directly on top
    // of each other (2026-08-10 bug report, screenshot). Shrink only the right-hand status text
    // to whatever room actually remains next to the measured level badge, same idiom as every
    // other label-vs-available-width clamp in this codebase.
    const xpAvailW = xpLbl.x - (levelLbl.x + levelLbl.width) - Math.round(barW * 0.02);
    if (xpAvailW > 0 && xpLbl.width > xpAvailW) xpLbl.scale.set(Math.max(0.55, xpAvailW / xpLbl.width));
    this.container.addChild(xpLbl);

    y += barH + Math.round(h * 0.014);

    // "How to earn XP" hint — XP only comes from ranked games (win/loss awards differ).
    if (!isMaxed) {
      const hint = txt(
        t('battlepass.xpEarnHint', { win: String(BP_XP_PER_RANKED_WIN), loss: String(BP_XP_PER_RANKED_LOSS) }),
        FS.heading, C.mid,
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
      const btnLbl = txt(t('battlepass.buy', { coins: String(BATTLEPASS_BUY_COST) }), snapFont(Math.round(buyAreaH * 0.5)), C.gold, true);
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
            .catch((e) => { this.bt.stop(); this.render(); this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('battlepass.buyFailed'), 'error'); });
        },
      });
      y += buyAreaH + Math.round(h * 0.015);
      bodyTopY = y;
    }

    // ── Scrollable track grid ─────────────────────────────────────────────────
    this.staticHits = this.hits.slice();
    const headerH = Math.round(h * 0.05);
    const cellH = Math.round(h * 0.075);
    const cellGap = Math.round(h * 0.008);
    const halfW = Math.floor((barW - Math.round(w * 0.02)) / 2);
    const freeX = pad;
    const paidX = pad + halfW + Math.round(w * 0.02);

    // Portrait's group nav is a bottom bar (§18) — reserve bottomNavH off the bottom.
    const availH = h - bodyTopY - (this.cb.openShop && !landscape ? bottomNavH(h) : 0);
    const totalContentH = headerH + BATTLEPASS_MAX_LEVEL * (cellH + cellGap);
    // Peek-adjusted viewport height: when the track overflows, the cut always lands mid-row so a
    // partial next reward row is always visible above the fold (not just the thin scroll indicator).
    const scrollBodyH = peekViewportH(availH, cellH + cellGap, totalContentH);
    const scrollMax = Math.max(0, totalContentH - scrollBodyH);
    this.scrollMax = scrollMax;
    this.scrollView = { x: pad, y: bodyTopY, w: barW, h: scrollBodyH };

    // First open: drop the current level onto the 3rd reward row (rows for currentLevel-2 and
    // currentLevel-1 sit above it). cellY(level) = headerH + (level-1)*(cellH+cellGap); to place it
    // two rows down from the viewport top we subtract two row heights. Clamped to the scroll range,
    // so early levels (where the target is negative) stay pinned at the top.
    if (!this.scrolledToCurrent) {
      const rowStride = cellH + cellGap;
      const target = headerH + (currentLevel - 3) * rowStride;
      this.scrollY = Math.max(0, Math.min(scrollMax, target));
      this.scrolledToCurrent = true;
    }

    const sy = Math.min(this.scrollY, scrollMax);

    const scrollContainer = new PIXI.Container();
    scrollContainer.x = 0;
    scrollContainer.y = bodyTopY - sy;
    this.scrollContainer = scrollContainer;
    this.bodyTopY = bodyTopY;
    this.scrollCellDefs = [];

    // Column headers
    const freeHdr = txt(t('battlepass.free'), snapFont(Math.round(headerH * 0.6)), C.accent, true);
    freeHdr.anchor.set(0.5, 0.5); freeHdr.x = freeX + halfW / 2; freeHdr.y = headerH / 2;
    scrollContainer.addChild(freeHdr);

    const paidHdr = txt(t('battlepass.paid'), snapFont(Math.round(headerH * 0.6)), C.gold, true);
    paidHdr.anchor.set(0.5, 0.5); paidHdr.x = paidX + halfW / 2; paidHdr.y = headerH / 2;
    scrollContainer.addChild(paidHdr);

    // Level rows: cache every claimable cell's *hit-test* def regardless of whether it's within
    // the current render's viewport (cheap — pure numbers) — updateScrollPosition() re-derives
    // absolute hit rects from this cache on every drag move without a full re-render, so a cell
    // that scrolls into view later still needs an entry. The actual display objects are NOT built
    // here — that's virtualized, see BattlePassScene/rows.ts's RewardRowVirtualizer.
    this.rowCtx = { currentLevel, claimedFree, claimedPaid, hasPass, headerH, cellH, cellGap, freeX, paidX, halfW };
    for (let i = 0; i < BATTLEPASS_MAX_LEVEL; i++) {
      const def = BATTLEPASS_DEFS[i]!;
      const lvl = def.level;
      const cellY = headerH + i * (cellH + cellGap);

      const freeState = cellState('free', lvl, currentLevel, claimedFree, claimedPaid, hasPass, !!def.free);
      if (this.cb.onClaim && freeState === 'claimable') {
        this.scrollCellDefs.push({ x: freeX, cellY, w: halfW, h: cellH, fn: () => this.doClaim('free', lvl) });
      }

      const paidState = cellState('paid', lvl, currentLevel, claimedFree, claimedPaid, hasPass, !!def.paid);
      if (this.cb.onClaim && paidState === 'claimable') {
        this.scrollCellDefs.push({ x: paidX, cellY, w: halfW, h: cellH, fn: () => this.doClaim('paid', lvl) });
      }
    }

    // Mask
    const maskGfx = new PIXI.Graphics();
    maskGfx.beginFill(0xffffff).drawRect(0, bodyTopY, w, scrollBodyH).endFill();
    this.container.addChild(maskGfx);
    scrollContainer.mask = maskGfx;
    this.container.addChild(scrollContainer);
    // Portrait's bottom bar draws AFTER the scroll body (visually on top), then
    // updateScrollPosition() folds its navHits into `this.hits` — must run in this order so both
    // the initial render and the drag fast-path (which also calls updateScrollPosition()) agree.
    if (!landscape) this.drawSidebar(tbH);
    this.updateScrollPosition();

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private doClaim(track: 'free' | 'paid', level: number): void {
    if (!this.cb.onClaim || this.bt.busy) return;
    this.bt.start();
    this.render();
    withTimeout(this.cb.onClaim(track, level))
      .then((coins) => {
        this.bt.stop();
        this.render();
        if (coins > 0) this.showToast(t('battlepass.claimToast', { n: String(coins) }));
      })
      .catch((e) => {
        this.bt.stop();
        this.render();
        this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('battlepass.claimFailed'), 'error');
      });
  }

}
