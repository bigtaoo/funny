import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../render/pixiText';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../render/materialAtlas';

function isMaterialKind(kind: IconKind): kind is MaterialKind {
  return kind === 'scrap' || kind === 'lead' || kind === 'binding';
}
import { FS, snapFont } from '../render/fontScale';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawSidebarTabs as drawSidebarTabsShared, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { showToastMessage, type ToastKind } from '../net/log';
import type { SaveData } from '../game/meta/SaveData';
import type { RetentionView } from '../net/ApiClient';
import {
  nextCheckinDay,
  dailyRewardClaimable,
  makeDayKey,
  makeMonthKey,
} from '../game/meta/retention';

// ── DailyScene — daily check-in + daily tasks (B5, RETENTION_DESIGN) ────────────
//
// Entry: LobbyScene "daily" button (onOpenDaily).
// Tab layout (2026-07-05): Calendar/Daily-tasks are a vertical sidebar left of the notebook's red
// margin rule (mirrors AchievementScene's category sidebar); content sits to its right and
// shows only the active tab at a time, at full width, regardless of orientation.

export interface DailyCallbacks {
  onBack(): void;
  getSave?(): SaveData | undefined;
  getRetention?(): Promise<RetentionView>;
  onCheckin?(): Promise<{ day: number; reward: { kind: string; count: number; id?: string } }>;
  onClaimDaily?(): Promise<{ coins: number }>;
  /** Always resolves (never throws) — `ok: false` covers both "no ad available" and server rejection (cooldown/cap/error), distinguished by `key`. */
  onWatchAd?(): Promise<{ ok: true; coins: number } | { ok: false; key: TranslationKey }>;
}

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

type DailyTab = 'checkin' | 'tasks' | 'ads';

/** Formats a remaining-ms duration as "mm:ss" for the ads-tab cooldown button label. */
function formatCooldown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Reward-kind glyph (mirrors BattlePassScene/EventScene's kind→IconKind mapping). */
function rewardIcon(kind: string, id?: string): IconKind | null {
  if (kind === 'coins') return 'coin';
  if (kind === 'material') return id === 'lead' ? 'lead' : id === 'binding' ? 'binding' : 'scrap';
  if (kind === 'card') return 'cards';
  if (kind === 'equipment') return 'armor';
  return null; // stamina: plain "+N" text, no glyph
}

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
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.load();
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
    const hdr = drawSceneHeader(this.container, w, h, t('daily.title'));
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
    const availH = h - contentTop - h * 0.03;

    this.drawSidebarTabs(contentTop, save, nowMs);

    const contentX = sidebarNavW(w, h, this.landscape) + Math.round(w * 0.025);
    const contentW = w - contentX - Math.round(w * 0.04);
    if (this.activeTab === 'checkin') {
      this.renderCheckin(contentX, contentTop, contentW, availH, save, nowMs);
    } else if (this.activeTab === 'tasks') {
      this.renderDailyTasks(contentX, contentTop, contentW, availH, save, nowMs);
    } else {
      this.renderAds(contentX, contentTop, contentW, availH, nowMs);
    }

    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  /**
   * Calendar/Daily-tasks tabs in the left-edge sidebar rail (same HubTabs.drawSidebarTabs
   * convention as every other hub's left tab rail). Tapping a tab swaps the single content
   * pane on the right — only one tab's content is ever drawn at a time.
   */
  private drawSidebarTabs(top: number, save: SaveData, nowMs: number): void {
    const { w, h } = this;
    const checkinBadge = nextCheckinDay(save, nowMs) !== null;
    const tasksBadge = dailyRewardClaimable(save, nowMs);
    const adsBadge = !!this.retention && this.retention.ads.watchedToday < this.retention.ads.cap && this.retention.ads.nextAvailableAt <= nowMs;
    const tabs: HubTab[] = [
      { label: t('daily.checkin.title'), active: this.activeTab === 'checkin', badge: checkinBadge },
      { label: t('daily.tasks.title'), active: this.activeTab === 'tasks', badge: tasksBadge },
    ];
    const keys: DailyTab[] = ['checkin', 'tasks'];
    // Hidden entirely (not just disabled) on platforms without a real ad integration — no
    // mock/placeholder ad is ever shown to a real player (see IPlatform.hasRewardedAd).
    if (this.cb.onWatchAd) {
      tabs.push({ label: t('daily.ads.title'), active: this.activeTab === 'ads', badge: adsBadge });
      keys.push('ads');
    }
    const { hits } = drawSidebarTabsShared(this.container, sidebarNavW(w, h, this.landscape), top, h, tabs, (i) => {
      this.activeTab = keys[i]!;
      this.render();
    });
    for (const hit of hits) {
      this.hits.push({ x: hit.rect.x, y: hit.rect.y, w: hit.rect.w, h: hit.rect.h, fn: hit.fn });
    }
  }

  private renderCheckin(areaX: number, top: number, areaW: number, areaH: number, save: SaveData, nowMs: number): void {
    const { h } = this;
    const sec = txt(t('daily.checkin.title'), FS.title, C.dark, true);
    sec.x = areaX + areaW * 0.05; sec.y = top;
    this.container.addChild(sec);

    const COLS = 6;
    const innerPad = areaW * 0.04;
    const cellW = (areaW - innerPad * 2) / COLS;
    const cellH = Math.min(areaH * 0.78 / 5, cellW * 0.8);
    const gridTop = top + sec.height + h * 0.015;

    const monthKey = makeMonthKey(nowMs);
    const claimedDays = (save.retention?.checkin?.monthKey === monthKey
      ? save.retention.checkin.claimedDays
      : []) as number[];
    const claimable = nextCheckinDay(save, nowMs);
    const rewards = this.retention?.defs?.rewards ?? [];
    const milestones = new Set([7, 14, 21, 30]);

    for (let day = 1; day <= 30; day++) {
      const col = (day - 1) % COLS;
      const row = Math.floor((day - 1) / COLS);
      const cx = areaX + innerPad + col * cellW + cellW * 0.5;
      const cy = gridTop + row * (cellH + h * 0.006) + cellH * 0.5;
      const x = cx - cellW * 0.46;
      const y = cy - cellH * 0.46;
      const cw = cellW * 0.92;
      const ch = cellH * 0.92;

      // Sequential accumulation model: claimed cells (≤ claimed count) get a checkmark;
      // the next unclaimed cell = claimable (highlighted); the rest = locked (dimmed).
      // claimable is provided by nextCheckinDay, may be null (already claimed today / month full) → no highlighted cell.
      const isClaimed = claimedDays.includes(day);
      const isClaimable = claimable !== null && day === claimable;
      const isLocked = !isClaimed && !isClaimable;
      const isMilestone = milestones.has(day);

      let fillColor = isClaimed ? 0xd0ccc0 : isLocked ? 0xf2ede0 : 0xb8e0c0;
      if (isMilestone && !isClaimed) fillColor = isClaimable ? 0xffd88a : 0xfaf0c8;

      const bg = sketchPanel(cw, ch, { fill: fillColor, border: isMilestone ? 0x8a7020 : C.line, width: isMilestone ? 1.8 : 1.2, seed: seedFor(x, y, day) });
      bg.x = x; bg.y = y;
      this.container.addChild(bg);

      const numTxt = txt(String(day), snapFont(Math.round(ch * 0.32)), isClaimed ? 0x999999 : isLocked ? 0xaaaaaa : 0x333333);
      numTxt.anchor.set(0.5, 0);
      numTxt.x = cx; numTxt.y = y + ch * 0.06;
      this.container.addChild(numTxt);

      const reward = rewards[day - 1];
      if (reward) {
        const icon = rewardIcon(reward.kind, reward.id);
        // Card/equipment milestones are single items (drawn randomly at claim time) — glyph only,
        // no "+1" (mirrors BattlePassScene's skin reward: single item, no count).
        const singleItem = reward.kind === 'card' || reward.kind === 'equipment';
        const baseY = y + ch * 0.92;
        if (icon) {
          const rc = Math.round(ch * 0.26);
          const ic = isMaterialKind(icon)
            ? buildMaterialIcon(icon, rc, 0x336644)
            : buildIcon(icon, rc, reward.kind === 'coins' ? C.gold : 0x336644);
          if (singleItem) {
            ic.x = cx - rc / 2; ic.y = baseY - rc;
            this.container.addChild(ic);
          } else {
            const rt = txt(`+${reward.count}`, snapFont(Math.round(ch * 0.24)), reward.kind === 'coins' ? 0x8a7020 : 0x336644);
            const groupW = rc + Math.round(ch * 0.03) + rt.width;
            const gx = cx - groupW / 2;
            ic.x = gx; ic.y = baseY - rc;
            rt.anchor.set(0, 1);
            rt.x = gx + rc + Math.round(ch * 0.03); rt.y = baseY;
            this.container.addChild(ic, rt);
          }
        } else {
          const rt = txt(`+${reward.count}`, snapFont(Math.round(ch * 0.24)), 0x336644);
          rt.anchor.set(0.5, 1);
          rt.x = cx; rt.y = baseY;
          this.container.addChild(rt);
        }
      }

      // Claimed cell: stamp a green checkmark (user feedback: tick the claimed date after collecting).
      if (isClaimed) {
        const tickSz = Math.round(ch * 0.5);
        const tick = buildIcon('check', tickSz, 0x2e7d32);
        tick.x = cx - tickSz / 2; tick.y = cy - tickSz / 2;
        tick.alpha = 0.85;
        this.container.addChild(tick);
      }

      if (isClaimable && this.cb.onCheckin) {
        this.hits.push({ x, y, w: cw, h: ch, fn: () => void this.doCheckin() });
      }
    }
  }

  private renderDailyTasks(areaX: number, top: number, areaW: number, areaH: number, save: SaveData, nowMs: number): void {
    const { h } = this;
    const sec = txt(t('daily.tasks.title'), FS.title, C.dark, true);
    sec.x = areaX + areaW * 0.05; sec.y = top;
    this.container.addChild(sec);

    const taskLabels: [string, string][] = [
      ['pve.clear', 'daily.tasks.pveLabel'],
      ['pvp.match', 'daily.tasks.pvpLabel'],
      ['gacha.draw', 'daily.tasks.gachaLabel'],
    ];

    const dayKey = makeDayKey(nowMs);
    const daily = save.retention?.daily?.dayKey === dayKey ? save.retention.daily : null;
    const completedTasks: Record<string, number> = daily?.completedTasks ?? {};
    const taskPoints = daily?.taskPoints ?? 0;
    const isClaimable = dailyRewardClaimable(save, nowMs);
    const isClaimed = daily?.rewardClaimed ?? false;

    const cardH = areaH * 0.22;
    const cardY0 = top + sec.height + h * 0.015;
    const PAD = areaX + areaW * 0.05;
    const cardW = areaW * 0.9;

    taskLabels.forEach(([taskId, labelKey], i) => {
      const done = (completedTasks[taskId] ?? 0) > 0;
      const fillColor = done ? 0xe0ecd8 : 0xf5f0e8;
      const cy = cardY0 + i * (cardH + h * 0.008);
      const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: C.line, width: 1.2, seed: seedFor(PAD, cy, i) });
      bg.x = PAD; bg.y = cy;
      this.container.addChild(bg);

      // Label is wrapped and width-capped to the left ~62% of the card so long
      // labels (e.g. "Clear any PvE level") can never grow into the right-aligned state text.
      const label = makeText(t(labelKey as TranslationKey), {
        fontSize: snapFont(Math.round(cardH * 0.3)), fill: 0x333333, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: cardW * 0.6, breakWords: true,
      });
      label.anchor.set(0, 0.5);
      label.x = PAD + cardW * 0.05;
      label.y = cy + cardH * 0.5;
      this.container.addChild(label);

      const state = txt(done ? t('daily.tasks.done') : t('daily.tasks.pending'), snapFont(Math.round(cardH * 0.3)), done ? 0x336644 : 0x888888);
      state.anchor.set(1, 0.5);
      state.x = PAD + cardW * 0.96;
      state.y = cy + cardH * 0.5;
      this.container.addChild(state);
    });

    const summaryY = cardY0 + taskLabels.length * (cardH + h * 0.008) + h * 0.01;
    const ptTxt = txt(`${taskPoints} / 3`, FS.title, taskPoints >= 3 ? 0x226622 : C.mid);
    ptTxt.anchor.set(0, 0.5);
    ptTxt.x = PAD; ptTxt.y = summaryY + cardH * 0.5;
    this.container.addChild(ptTxt);

    if (this.cb.onClaimDaily) {
      const btnW = cardW * 0.45;
      const btnH = cardH * 0.85;
      const btnX = PAD + cardW - btnW;
      const btnY = summaryY + cardH * 0.08;
      const btnFill = isClaimed ? 0xaaaaaa : isClaimable ? 0x336644 : 0xaaaaaa;
      const btnBg = sketchPanel(btnW, btnH, { fill: btnFill, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
      btnBg.x = btnX; btnBg.y = btnY;
      const coinsReward = this.retention?.defs?.dailyCoinsReward ?? 2;
      const btnLabel = txt(
        isClaimed ? t('daily.tasks.rewardClaimed') : t('daily.tasks.rewardCoins', { n: coinsReward }),
        snapFont(Math.round(btnH * 0.36)), 0xffffff,
      );
      btnLabel.anchor.set(0.5, 0.5);
      btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
      this.container.addChild(btnBg, btnLabel);

      if (isClaimable) {
        this.hits.push({ x: btnX, y: btnY, w: btnW, h: btnH, fn: () => void this.doClaim() });
      }
    }
  }

  /** "Watch an ad for coins" tab (ECONOMY_NUMBERS §6.2): watched/cap counter + reward button, or a live cooldown countdown once the per-ad interval gate is active. */
  private renderAds(areaX: number, top: number, areaW: number, areaH: number, nowMs: number): void {
    const { h } = this;
    const sec = txt(t('daily.ads.title'), FS.title, C.dark, true);
    sec.x = areaX + areaW * 0.05; sec.y = top;
    this.container.addChild(sec);

    const ads = this.retention?.ads;
    const PAD = areaX + areaW * 0.05;
    const cardW = areaW * 0.9;
    const cardH = areaH * 0.24;
    const cardY = top + sec.height + h * 0.02;

    const watched = ads?.watchedToday ?? 0;
    const cap = ads?.cap ?? 0;
    const rewardCoins = ads?.rewardCoins ?? 0;
    const nextAvailableAt = ads?.nextAvailableAt ?? 0;
    const capReached = cap > 0 && watched >= cap;
    const cooling = nextAvailableAt > nowMs;
    const available = !!ads && !capReached && !cooling;

    const countTxt = txt(t('daily.ads.watchedCount', { n: watched, cap }), FS.title, capReached ? 0xaa4444 : C.mid);
    countTxt.x = PAD; countTxt.y = cardY;
    this.container.addChild(countTxt);

    const bg = sketchPanel(cardW, cardH, { fill: available ? 0xe0ecd8 : 0xf5f0e8, border: C.line, width: 1.2, seed: seedFor(PAD, cardY, 0) });
    bg.x = PAD; bg.y = cardY + countTxt.height + h * 0.015;
    this.container.addChild(bg);

    const rewardTxt = txt(t('daily.ads.rewardCoins', { n: rewardCoins }), snapFont(Math.round(cardH * 0.3)), 0x333333);
    rewardTxt.x = bg.x + cardW * 0.05;
    rewardTxt.y = bg.y + cardH * 0.5 - rewardTxt.height / 2;
    this.container.addChild(rewardTxt);

    const btnW = cardW * 0.4;
    const btnH = cardH * 0.6;
    const btnX = bg.x + cardW - btnW - cardW * 0.05;
    const btnY = bg.y + cardH * 0.5 - btnH / 2;
    const btnBg = sketchPanel(btnW, btnH, { fill: available ? 0x336644 : 0xaaaaaa, border: 0x666666, width: 1.5, seed: seedFor(btnX, btnY, 0) });
    btnBg.x = btnX; btnBg.y = btnY;
    this.container.addChild(btnBg);

    let btnLabelText: string;
    if (capReached) btnLabelText = t('daily.ads.capReached');
    else if (cooling) btnLabelText = t('daily.ads.cooldown', { time: formatCooldown(nextAvailableAt - nowMs) });
    else btnLabelText = t('daily.ads.watch');
    const btnLabel = txt(btnLabelText, snapFont(Math.round(btnH * 0.32)), 0xffffff);
    btnLabel.anchor.set(0.5, 0.5);
    btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
    this.container.addChild(btnLabel);

    if (available && this.cb.onWatchAd) {
      this.hits.push({ x: btnX, y: btnY, w: btnW, h: btnH, fn: () => void this.doWatchAd() });
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
      this.showToast(`${t('daily.checkin.day', { n: r.day })} ${rewardDesc}`);
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
