import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, type TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren, drawLoadingOverlay } from '../render/sketchUi';
import { FS } from '../render/fontScale';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs as drawSidebarTabsShared, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage, type ToastKind } from '../net/log';
import type { SaveData } from '../game/meta/SaveData';
import type { RetentionView } from '../net/ApiClient';
import { nextCheckinDay, dailyRewardClaimable, weeklyClaimableTiers } from '../game/meta/retention';
import type { DailyCallbacks } from './DailyScene/types';
import { renderCheckin, renderDailyTasks, renderWeekly, renderAds, type DailyPanelCtx, type Hit } from './DailyScene/panels';
import { preloadRewardIconArt } from '../render/rewardIcon';

export type { DailyCallbacks } from './DailyScene/types';

// ── DailyScene — daily check-in + daily tasks (B5, RETENTION_DESIGN) ────────────
//
// Entry: LobbyScene "daily" button (onOpenDaily).
// Tab layout (2026-07-05): Calendar/Daily-tasks are a vertical sidebar left of the notebook's red
// margin rule (mirrors AchievementScene's category sidebar); content sits to its right and
// shows only the active tab at a time, at full width, regardless of orientation.
//
// 2026-08-13: the four tab bodies (renderCheckin/renderDailyTasks/renderWeekly/renderAds) were
// pulled out into DailyScene/panels.ts as form① free functions (claudedocs/client-modules.md
// "单文件 500 行收敛") — this file kept only the scene lifecycle, tab-switch chrome, and the
// busy-tracked action wrappers those panels call back into via DailyPanelCtx.

type DailyTab = 'checkin' | 'tasks' | 'weekly' | 'ads';

/** Per-tab header title key — the top bar reflects the active sub-tab (was a hardcoded 'daily.title'
 * ("Daily") no matter which tab was selected, which read wrong while e.g. viewing Weekly Chest). */
const TAB_TITLE_KEY: Record<DailyTab, TranslationKey> = {
  checkin: 'daily.checkin.title',
  tasks: 'daily.tasks.title',
  weekly: 'daily.weekly.title',
  ads: 'daily.ads.title',
};

export class DailyScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: DailyCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private activeTab: DailyTab = 'checkin';

  private readonly bt = new BusyTracker();

  private retention: RetentionView | null = null;
  /** Set in destroy(); guards render() so a late async load() re-render can't paint into a torn-down container. */
  private destroyed = false;

  private readonly landscape: boolean;

  /** Seconds accumulator driving the ads-tab cooldown countdown (re-renders once/sec so "mm:ss" ticks down without a network refetch). */
  private cooldownTick = 0;

  constructor(layout: ILayout, input: InputManager, cb: DailyCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.activeTab = DailyScene.pickInitialTab(cb.getSave?.());
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));
    this.render();
    // Reward glyphs come from AI art (coin/material atlases + the shared tab-icon PNGs) — warm
    // them and repaint once decoded, else the first frame draws the procedural fallbacks.
    void preloadRewardIconArt().then(() => { if (!this.destroyed) this.render(); });
    void this.load();
  }

  /**
   * Which sub-tab to land on when the scene first opens (09.08.2026 bug report follow-up).
   * DailyScene used to always start on 'checkin' regardless of where the actual reward was — the
   * lobby's "每日" red dot lights up on `checkin || daily-tasks || weekly` (see lobby.ts
   * refreshLobbyBadges), but on most days the checkin slot is already claimed and the daily-tasks
   * threshold isn't reached yet, so the *only* lit sub-tab is Weekly. A player tapping the red dot
   * landed on an empty-looking Checkin tab and never noticed the small badge dot on the Weekly tab
   * over in the sidebar, reporting it as "red dot lit, nothing to claim" even though a weekly chest
   * tier was sitting there claimable the whole time.
   * Priority mirrors the lobby's OR order exactly, so whichever tab the red dot is "about" is the
   * one the player actually lands on; falls back to 'checkin' (the pre-fix default) when nothing is
   * claimable, same as visiting Daily with a clean slate always has.
   */
  private static pickInitialTab(save: SaveData | undefined): DailyTab {
    if (!save) return 'checkin';
    const nowMs = Date.now();
    if (nextCheckinDay(save, nowMs) !== null) return 'checkin';
    if (dailyRewardClaimable(save, nowMs)) return 'tasks';
    if (weeklyClaimableTiers(save, nowMs).length > 0) return 'weekly';
    return 'checkin';
  }

  update(dt: number): void {
    if (this.bt.tick(dt)) this.render();
    if (this.activeTab === 'ads' && (this.retention?.ads.nextAvailableAt ?? 0) > 0) {
      this.cooldownTick += dt;
      if (this.cooldownTick >= 1) {
        this.cooldownTick = 0;
        this.render();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const unsub of this.unsubs) unsub();
    this.container.destroy({ children: true });
  }

  private async load(): Promise<void> {
    if (!this.cb.getRetention) return;
    try {
      this.retention = await this.cb.getRetention();
    } catch { /* silently use save-derived state */ }
    this.render();
  }

  private handleDown(x: number, y: number): void {
    if (this.bt.busy) return;
    for (const h of this.hits) {
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        h.fn();
        return;
      }
    }
  }

  private showToast(msg: string, kind: ToastKind = 'success'): void {
    showToastMessage(msg, kind);
  }

  /** Bundles what panels.ts's render functions need instead of them closing over `this`. */
  private panelCtx(): DailyPanelCtx {
    return {
      container: this.container,
      hits: this.hits,
      h: this.h,
      landscape: this.landscape,
      retention: this.retention,
      cb: this.cb,
      doCheckin: () => void this.doCheckin(),
      doClaim: () => void this.doClaim(),
      doClaimWeekly: (threshold: number) => void this.doClaimWeekly(threshold),
      doWatchAd: () => void this.doWatchAd(),
    };
  }

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h, landscape } = this;

    // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const railX = landscape ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('dailybg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    // Title bar (unified SceneHeader: back top-left + cached chrome, UI_DESIGN §3.1/§2.1).
    const hdr = drawSceneHeader(this.container, w, h, t(TAB_TITLE_KEY[this.activeTab]));
    this.hits.push({ x: hdr.backRect.x, y: hdr.backRect.y, w: hdr.backRect.w, h: hdr.backRect.h, fn: () => this.cb.onBack() });

    const save = this.cb.getSave?.();
    if (!save) {
      const msg = txt(t('daily.loginRequired'), FS.title, C.mid);
      msg.anchor.set(0.5, 0.5);
      msg.x = w / 2; msg.y = h / 2;
      this.container.addChild(msg);
      return;
    }

    const nowMs = Date.now();
    const contentTop = hdr.headerH + h * 0.02;
    // Portrait's Calendar/Tasks/Ads tabs are a bottom nav bar instead of a left rail (§18) — content
    // no longer reserves width for them, but does reserve `bottomNavH` off the bottom of its height.
    const availH = h - contentTop - h * 0.03 - (this.landscape ? 0 : bottomNavH(h));

    this.drawSidebarTabs(contentTop, save, nowMs);

    const contentX = this.landscape ? sidebarNavW(w, h, true) + Math.round(w * 0.025) : Math.round(w * 0.06);
    const contentW = w - contentX - Math.round(w * 0.04);
    const ctx = this.panelCtx();
    if (this.activeTab === 'checkin') {
      renderCheckin(ctx, contentX, contentTop, contentW, availH, save, nowMs);
    } else if (this.activeTab === 'tasks') {
      renderDailyTasks(ctx, contentX, contentTop, contentW, availH, save, nowMs);
    } else if (this.activeTab === 'weekly') {
      renderWeekly(ctx, contentX, contentTop, contentW, availH, save, nowMs);
    } else {
      renderAds(ctx, contentX, contentTop, contentW, availH, nowMs);
    }

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  /**
   * Calendar/Daily-tasks tabs. Landscape draws them in the left-edge sidebar rail (same
   * HubTabs.drawSidebarTabs convention as every other hub's left tab rail); portrait draws them
   * as a bottom nav bar instead (§18). Tapping a tab swaps the single content pane — only one
   * tab's content is ever drawn at a time.
   */
  private drawSidebarTabs(top: number, save: SaveData, nowMs: number): void {
    const { w, h } = this;
    const checkinBadge = nextCheckinDay(save, nowMs) !== null;
    const tasksBadge = dailyRewardClaimable(save, nowMs);
    const weeklyBadge = weeklyClaimableTiers(save, nowMs).length > 0;
    const adsBadge = !!this.retention && this.retention.ads.watchedToday < this.retention.ads.cap && this.retention.ads.nextAvailableAt <= nowMs;
    const tabs: HubTab[] = [
      { label: t('daily.checkin.title'), active: this.activeTab === 'checkin', badge: checkinBadge },
      { label: t('daily.tasks.title'), active: this.activeTab === 'tasks', badge: tasksBadge },
      { label: t('daily.weekly.title'), active: this.activeTab === 'weekly', badge: weeklyBadge },
    ];
    const keys: DailyTab[] = ['checkin', 'tasks', 'weekly'];
    // Hidden entirely (not just disabled) on platforms without a real ad integration — no
    // mock/placeholder ad is ever shown to a real player (see IPlatform.hasRewardedAd).
    if (this.cb.onWatchAd) {
      tabs.push({ label: t('daily.ads.title'), active: this.activeTab === 'ads', badge: adsBadge });
      keys.push('ads');
    }
    const onSelect = (i: number): void => {
      this.activeTab = keys[i]!;
      this.render();
    };
    if (!this.landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(this.container, w, h - barH, barH, tabs, onSelect);
      for (const hit of hits) this.hits.push({ x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h, fn: hit.fn });
      return;
    }
    const { hits } = drawSidebarTabsShared(this.container, sidebarNavW(w, h, true), top, h, tabs, onSelect);
    for (const hit of hits) {
      this.hits.push({ x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h, fn: hit.fn });
    }
  }

  private async doCheckin(): Promise<void> {
    if (this.bt.busy || !this.cb.onCheckin) return;
    this.bt.start();
    try {
      const r = await withTimeout(this.cb.onCheckin());
      const rewardDesc =
        r.reward.kind === 'coins' ? t('daily.tasks.rewardCoins', { n: r.reward.count })
        : r.reward.kind === 'material' ? t('daily.checkin.rewardMaterial', { n: r.reward.count })
        : r.reward.kind === 'card' ? t('daily.checkin.rewardCard')
        : r.reward.kind === 'equipment' ? t('daily.checkin.rewardEquipment')
        : t('daily.checkin.rewardStamina', { n: r.reward.count });
      const bonusDesc = r.reward.bonusCoins ? ` + ${t('daily.checkin.bonusCoins', { n: r.reward.bonusCoins })}` : '';
      this.showToast(`${t('daily.checkin.day', { n: r.day })} ${rewardDesc}${bonusDesc}`);
    } catch (e) {
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('daily.tasks.claimFailed'), 'error');
    } finally {
      this.bt.stop();
      void this.load();
    }
  }

  private async doClaim(): Promise<void> {
    if (this.bt.busy || !this.cb.onClaimDaily) return;
    this.bt.start();
    try {
      const r = await withTimeout(this.cb.onClaimDaily());
      this.showToast(t('daily.tasks.claimToast', { n: r.coins }));
    } catch (e) {
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('daily.tasks.claimFailed'), 'error');
    } finally {
      this.bt.stop();
      void this.load();
    }
  }

  private async doClaimWeekly(threshold: number): Promise<void> {
    if (this.bt.busy || !this.cb.onClaimWeekly) return;
    this.bt.start();
    try {
      const r = await withTimeout(this.cb.onClaimWeekly(threshold));
      const rewardDesc =
        r.reward.kind === 'material' ? t('daily.checkin.rewardMaterial', { n: r.reward.count })
        : r.reward.kind === 'equipment' ? t('daily.checkin.rewardEquipment')
        : t('daily.weekly.rewardCard');
      this.showToast(rewardDesc);
    } catch (e) {
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('daily.tasks.claimFailed'), 'error');
    } finally {
      this.bt.stop();
      void this.load();
    }
  }

  /**
   * No withTimeout here: onWatchAd() opens a user-paced ad player (real ad duration, or the web
   * mock's fixed countdown) before it ever touches the network — bounding it at BUSY_TIMEOUT_MS
   * (10s) would fail a real ad mid-playback. The callback always resolves (never throws), so the
   * busy spinner still clears deterministically.
   */
  private async doWatchAd(): Promise<void> {
    if (this.bt.busy || !this.cb.onWatchAd) return;
    this.bt.start();
    try {
      const r = await this.cb.onWatchAd();
      if (r.ok) this.showToast(t('daily.tasks.claimToast', { n: r.coins }));
      else this.showToast(t(r.key), 'error');
    } finally {
      this.bt.stop();
      void this.load();
    }
  }
}
