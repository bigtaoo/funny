import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import type { SaveData } from '../game/meta/SaveData';
import type { RetentionView } from '../net/ApiClient';
import {
  nextCheckinDay,
  dailyRewardClaimable,
  makeDayKey,
  makeMonthKey,
} from '../game/meta/retention';

// ── DailyScene — 每日签到 + 每日任务（B5，RETENTION_DESIGN）─────────────────────
//
// 入口：LobbyScene「每日」按钮（onOpenDaily）。
// 上半：30 格月历签到（当日格高亮，今日可领=绿色；已领=灰色；未到=虚线）。
// 下半：3 条每日任务卡片 + 满点领取按钮。

export interface DailyCallbacks {
  onBack(): void;
  getSave?(): SaveData | undefined;
  getRetention?(): Promise<RetentionView>;
  onCheckin?(): Promise<{ day: number; reward: { kind: string; count: number } }>;
  onClaimDaily?(): Promise<{ coins: number }>;
}

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

export class DailyScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly cb: DailyCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  private readonly bt = new BusyTracker();
  private toast: string | null = null;
  private toastTimer = 0;

  private retention: RetentionView | null = null;

  constructor(layout: ILayout, input: InputManager, cb: DailyCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.load();
  }

  update(dt: number): void {
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    for (const unsub of this.unsubs) unsub();
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

  private showToast(msg: string): void {
    this.toast = msg;
    this.toastTimer = 2.5;
    this.render();
  }

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('dailybg', w, h));

    const title = txt(t('daily.title'), Math.round(h * 0.045), C.dark, true);
    title.anchor.set(0.5, 0);
    title.x = w / 2;
    title.y = h * 0.03;
    this.container.addChild(title);

    const backBtn = txt(t('daily.back'), Math.round(h * 0.032), C.mid);
    backBtn.x = w * 0.05;
    backBtn.y = h * 0.04;
    backBtn.interactive = true;
    backBtn.cursor = 'pointer';
    backBtn.on('pointertap', () => this.cb.onBack());
    this.container.addChild(backBtn);

    const save = this.cb.getSave?.();
    if (!save) {
      const msg = txt(t('daily.loginRequired'), Math.round(h * 0.032), C.mid);
      msg.anchor.set(0.5, 0.5);
      msg.x = w / 2; msg.y = h / 2;
      this.container.addChild(msg);
      return;
    }

    const nowMs = Date.now();
    const contentTop = h * 0.12;
    const halfH = (h - contentTop) / 2;

    this.renderCheckin(contentTop, halfH, save, nowMs);
    this.renderDailyTasks(contentTop + halfH, halfH - h * 0.03, save, nowMs);

    if (this.toast) {
      const toastBg = new PIXI.Graphics();
      toastBg.beginFill(0x1a1408, 0.85);
      toastBg.drawRoundedRect(w * 0.15, h * 0.82, w * 0.7, h * 0.07, 8);
      toastBg.endFill();
      const toastTxt = txt(this.toast, Math.round(h * 0.028), 0xffd88a);
      toastTxt.anchor.set(0.5, 0.5);
      toastTxt.x = w / 2; toastTxt.y = h * 0.855;
      this.container.addChild(toastBg, toastTxt);
    }
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private renderCheckin(top: number, areaH: number, save: SaveData, nowMs: number): void {
    const { w, h } = this;
    const sec = txt(t('daily.checkin.title'), Math.round(h * 0.03), C.dark, true);
    sec.x = w * 0.05; sec.y = top;
    this.container.addChild(sec);

    const COLS = 6;
    const PAD = w * 0.04;
    const cellW = (w - PAD * 2) / COLS;
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
      const cx = PAD + col * cellW + cellW * 0.5;
      const cy = gridTop + row * (cellH + h * 0.006) + cellH * 0.5;
      const x = cx - cellW * 0.46;
      const y = cy - cellH * 0.46;
      const cw = cellW * 0.92;
      const ch = cellH * 0.92;

      // 顺序累计模型：已领格（≤ 已领数）打勾；下一未领格 = 可领（高亮）；其余 = 未解锁（暗）。
      // claimable 由 nextCheckinDay 给出，可能为 null（今日已领/月满）→ 无高亮格。
      const isClaimed = claimedDays.includes(day);
      const isClaimable = claimable !== null && day === claimable;
      const isLocked = !isClaimed && !isClaimable;
      const isMilestone = milestones.has(day);

      let fillColor = isClaimed ? 0xd0ccc0 : isLocked ? 0xf2ede0 : 0xb8e0c0;
      if (isMilestone && !isClaimed) fillColor = isClaimable ? 0xffd88a : 0xfaf0c8;

      const bg = sketchPanel(cw, ch, { fill: fillColor, border: isMilestone ? 0x8a7020 : C.line, width: isMilestone ? 1.8 : 1.2, seed: seedFor(x, y, day) });
      bg.x = x; bg.y = y;
      this.container.addChild(bg);

      const numTxt = txt(String(day), Math.round(ch * 0.32), isClaimed ? 0x999999 : isLocked ? 0xaaaaaa : 0x333333);
      numTxt.anchor.set(0.5, 0);
      numTxt.x = cx; numTxt.y = y + ch * 0.06;
      this.container.addChild(numTxt);

      const reward = rewards[day - 1];
      if (reward) {
        const rewardStr = reward.kind === 'coins' ? `+${reward.count}c` : `+${reward.count}`;
        const rt = txt(rewardStr, Math.round(ch * 0.24), reward.kind === 'coins' ? 0x8a7020 : 0x336644);
        rt.anchor.set(0.5, 1);
        rt.x = cx; rt.y = y + ch * 0.92;
        this.container.addChild(rt);
      }

      // 已领格：盖一个绿色对勾（用户反馈：领取后在已领日期打勾）。
      if (isClaimed) {
        const tick = txt('✓', Math.round(ch * 0.5), 0x2e7d32, true);
        tick.anchor.set(0.5, 0.5);
        tick.x = cx; tick.y = cy;
        tick.alpha = 0.85;
        this.container.addChild(tick);
      }

      if (isClaimable && this.cb.onCheckin) {
        this.hits.push({ x, y, w: cw, h: ch, fn: () => void this.doCheckin() });
      }
    }
  }

  private renderDailyTasks(top: number, areaH: number, save: SaveData, nowMs: number): void {
    const { w, h } = this;
    const sec = txt(t('daily.tasks.title'), Math.round(h * 0.03), C.dark, true);
    sec.x = w * 0.05; sec.y = top;
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
    const PAD = w * 0.05;
    const cardW = w - PAD * 2;

    taskLabels.forEach(([taskId, labelKey], i) => {
      const done = (completedTasks[taskId] ?? 0) > 0;
      const fillColor = done ? 0xe0ecd8 : 0xf5f0e8;
      const cy = cardY0 + i * (cardH + h * 0.008);
      const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: C.line, width: 1.2, seed: seedFor(PAD, cy, i) });
      bg.x = PAD; bg.y = cy;
      this.container.addChild(bg);

      const label = txt(t(labelKey as TranslationKey), Math.round(cardH * 0.34), 0x333333);
      label.anchor.set(0, 0.5);
      label.x = PAD + cardW * 0.05;
      label.y = cy + cardH * 0.5;
      this.container.addChild(label);

      const state = txt(done ? t('daily.tasks.done') : t('daily.tasks.pending'), Math.round(cardH * 0.3), done ? 0x336644 : 0x888888);
      state.anchor.set(1, 0.5);
      state.x = PAD + cardW * 0.96;
      state.y = cy + cardH * 0.5;
      this.container.addChild(state);
    });

    const summaryY = cardY0 + taskLabels.length * (cardH + h * 0.008) + h * 0.01;
    const ptTxt = txt(`${taskPoints} / 3`, Math.round(h * 0.03), taskPoints >= 3 ? 0x226622 : C.mid);
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
        Math.round(btnH * 0.36), 0xffffff,
      );
      btnLabel.anchor.set(0.5, 0.5);
      btnLabel.x = btnX + btnW / 2; btnLabel.y = btnY + btnH / 2;
      this.container.addChild(btnBg, btnLabel);

      if (isClaimable) {
        this.hits.push({ x: btnX, y: btnY, w: btnW, h: btnH, fn: () => void this.doClaim() });
      }
    }
  }

  private async doCheckin(): Promise<void> {
    if (this.bt.busy || !this.cb.onCheckin) return;
    this.bt.start();
    try {
      const r = await withTimeout(this.cb.onCheckin());
      const rewardDesc = r.reward.kind === 'coins'
        ? t('daily.tasks.rewardCoins', { n: r.reward.count })
        : `+${r.reward.count} 体力`;
      this.showToast(`${t('daily.checkin.day', { n: r.day })} ${rewardDesc}`);
    } catch (e) {
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('daily.tasks.claimFailed'));
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
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('daily.tasks.claimFailed'));
    } finally {
      this.bt.stop();
      void this.load();
    }
  }
}
