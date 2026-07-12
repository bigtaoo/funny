import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, drawLoadingOverlay, tearDownChildren } from '../render/sketchUi';
import { buildIcon, type IconKind } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { BusyTracker, withTimeout, TimeoutError } from '../ui/busyTracker';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';

/** Map a reward's craft-material id to its hand-drawn icon (scrap / lead / binding), else null. */
function materialIcon(id: string | undefined): IconKind | null {
  return id === 'scrap' || id === 'lead' || id === 'binding' ? id : null;
}

// ── EventScene — limited-time events (B6, ADR-014) ────────────────────────────
//
// Entry: LobbyScene "events" button (onOpenEvents).
// Layout: event tab list (if multiple) → task progress cards + points shop for the selected event.
// Portrait: task area in the upper half, redemption area in the lower half;
// Landscape: tasks in the left column, redemption in the right column.
// Redemption goes via POST /api/events/claim; rewards are delivered by mail or via commercial coins.

export interface EventTaskView {
  taskId: string;
  kind: string;
  target: number;
  points: number;
  progress: number;
  done: boolean;
}

export interface EventRewardView {
  rewardId: string;
  cost: number;
  kind: string;
  id?: string;
  count?: number;
  maxClaims?: number;
  claimedCount: number;
}

export interface EventView {
  eventId: string;
  title: string;
  description?: string;
  windowStart: number;
  windowEnd: number;
  myPoints: number;
  tasks: EventTaskView[];
  rewards: EventRewardView[];
}

export interface EventCallbacks {
  onBack(): void;
  getEvents?(): Promise<EventView[]>;
  onClaimReward?(eventId: string, rewardId: string): Promise<{ pointsLeft: number }>;
}

interface Hit { x: number; y: number; w: number; h: number; fn: () => void }

export class EventScene implements Scene {
  readonly container: PIXI.Container;
  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: EventCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Set in destroy(); guards render() so a late async load() re-render can't paint into a torn-down container. */
  private destroyed = false;

  private readonly bt = new BusyTracker();
  private toast: string | null = null;
  private toastTimer = 0;
  private events: EventView[] = [];
  private selectedIdx = 0;

  constructor(layout: ILayout, input: InputManager, cb: EventCallbacks) {
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
    if (this.toast !== null) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) { this.toast = null; this.render(); }
    }
    if (this.bt.tick(dt)) this.render();
  }

  destroy(): void {
    this.destroyed = true;
    for (const unsub of this.unsubs) unsub();
    this.container.destroy({ children: true });
  }

  private async load(): Promise<void> {
    if (!this.cb.getEvents) return;
    try {
      this.events = await this.cb.getEvents();
      this.selectedIdx = 0;
    } catch { /* silently show empty */ }
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
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('eventbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('event.title'));
    this.hits.push({ ...hdr.backRect, fn: () => this.cb.onBack() });

    if (this.events.length === 0) {
      const empty = txt(t('event.noEvents'), Math.round(h * 0.035), C.mid);
      empty.anchor.set(0.5, 0.5);
      empty.x = w / 2; empty.y = h * 0.5;
      this.container.addChild(empty);
      this.renderToast();
      if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
      return;
    }

    const event = this.events[this.selectedIdx];
    if (!event) {
      this.renderToast();
      if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
      return;
    }

    const contentTop = h * 0.12;

    // Event tabs (shown when there are multiple events)
    if (this.events.length > 1) {
      this.renderTabs(contentTop, h * 0.07);
    }
    const bodyTop = this.events.length > 1 ? contentTop + h * 0.09 : contentTop;

    this.renderEvent(event, bodyTop, h - bodyTop - h * 0.03);
    this.renderToast();
    if (this.bt.loadingVisible) drawLoadingOverlay(this.container, w, h, this.bt.dots, t('common.processing'));
  }

  private renderTabs(top: number, tabH: number): void {
    const { w, h } = this;
    const tabW = (w * 0.9) / this.events.length;
    const startX = w * 0.05;
    this.events.forEach((ev, i) => {
      const x = startX + i * tabW;
      const isSelected = i === this.selectedIdx;
      const bg = sketchPanel(tabW - w * 0.01, tabH, {
        fill: isSelected ? 0xdde8cc : 0xf5f0e8,
        border: isSelected ? 0x4a7030 : C.line,
        width: isSelected ? 1.8 : 1.2,
        seed: seedFor(x, top, i),
      });
      bg.x = x; bg.y = top;
      this.container.addChild(bg);
      const label = txt(ev.title, Math.round(tabH * 0.38), isSelected ? 0x2a5018 : C.mid);
      label.anchor.set(0.5, 0.5);
      label.x = x + (tabW - w * 0.01) / 2;
      label.y = top + tabH / 2;
      this.container.addChild(label);
      const idx = i;
      this.hits.push({ x, y: top, w: tabW - w * 0.01, h: tabH, fn: () => { this.selectedIdx = idx; this.render(); } });
    });
  }

  private renderEvent(event: EventView, top: number, availH: number): void {
    const { w, h } = this;
    const PAD = w * 0.05;
    const now = Date.now();
    const timeLeft = Math.max(0, event.windowEnd - now);
    const daysLeft = Math.ceil(timeLeft / 86_400_000);

    // Event title + countdown
    const evTitle = txt(event.title, Math.round(h * 0.038), C.dark, true);
    evTitle.x = PAD; evTitle.y = top;
    this.container.addChild(evTitle);

    const countdown = txt(
      daysLeft > 0 ? t('event.daysLeft', { n: daysLeft }) : t('event.ending'),
      Math.round(h * 0.028), 0x886622,
    );
    countdown.anchor.set(1, 0);
    countdown.x = w - PAD; countdown.y = top;
    this.container.addChild(countdown);

    // Points display
    const ptsTxt = txt(t('event.points', { n: event.myPoints }), Math.round(h * 0.032), 0x226644);
    ptsTxt.x = PAD; ptsTxt.y = top + h * 0.05;
    this.container.addChild(ptsTxt);

    const headerH = h * 0.09;
    const bodyTop = top + headerH;
    const bodyH = availH - headerH;

    if (this.landscape) {
      // Landscape: tasks in the left column, redemption in the right column
      const colGap = Math.round(w * 0.015);
      const leftW = Math.round((w - colGap) * 0.5);
      const rightX = leftW + colGap;
      const rightW = w - rightX;
      this.renderTasks(event, 0, bodyTop, leftW, bodyH - h * 0.04);
      this.renderRewards(event, rightX, bodyTop, rightW, bodyH);
    } else {
      // Portrait: tasks in the upper half, redemption in the lower half
      const halfH = bodyH * 0.5;
      this.renderTasks(event, 0, bodyTop, w, halfH - h * 0.04);
      this.renderRewards(event, 0, bodyTop + halfH, w, halfH);
    }
  }

  private renderTasks(event: EventView, areaX: number, top: number, areaW: number, areaH: number): void {
    const { h } = this;
    const PAD = areaX + areaW * 0.05;

    const sec = txt(t('event.tasks.title'), Math.round(h * 0.03), C.dark, true);
    sec.x = PAD; sec.y = top;
    this.container.addChild(sec);

    const cardH = Math.min(areaH * 0.28, h * 0.1);
    const cardW = areaW * 0.9;

    event.tasks.forEach((task, i) => {
      const cy = top + sec.height + h * 0.01 + i * (cardH + h * 0.008);
      const fillColor = task.done ? 0xe0ecd8 : 0xf5f0e8;
      const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: C.line, width: 1.2, seed: seedFor(PAD, cy, i) });
      bg.x = PAD; bg.y = cy;
      this.container.addChild(bg);

      const label = txt(t(`event.tasks.${task.kind}` as any) ?? task.kind, Math.round(cardH * 0.34), 0x333333);
      label.anchor.set(0, 0.5);
      label.x = PAD + cardW * 0.04;
      label.y = cy + cardH * 0.5;
      this.container.addChild(label);

      const progTxt = txt(`${Math.min(task.progress, task.target)} / ${task.target}`, Math.round(cardH * 0.3), task.done ? 0x336644 : C.mid);
      progTxt.anchor.set(0.5, 0.5);
      progTxt.x = PAD + cardW * 0.7;
      progTxt.y = cy + cardH * 0.5;
      this.container.addChild(progTxt);

      const rewardTxt = txt(`+${task.points}pt`, Math.round(cardH * 0.3), task.done ? 0x888888 : 0x226644);
      rewardTxt.anchor.set(1, 0.5);
      rewardTxt.x = PAD + cardW * 0.97;
      rewardTxt.y = cy + cardH * 0.5;
      this.container.addChild(rewardTxt);
    });
  }

  private renderRewards(event: EventView, areaX: number, top: number, areaW: number, areaH: number): void {
    const { h } = this;
    const PAD = areaX + areaW * 0.05;

    const sec = txt(t('event.rewards.title'), Math.round(h * 0.03), C.dark, true);
    sec.x = PAD; sec.y = top;
    this.container.addChild(sec);

    const cardH = Math.min(areaH * 0.25, h * 0.09);
    const cardW = areaW * 0.9;

    event.rewards.forEach((reward, i) => {
      const cy = top + sec.height + h * 0.01 + i * (cardH + h * 0.008);
      const canClaim = event.myPoints >= reward.cost &&
        (reward.maxClaims === undefined || reward.claimedCount < reward.maxClaims);
      const exhausted = reward.maxClaims !== undefined && reward.claimedCount >= reward.maxClaims;

      const fillColor = exhausted ? 0xd8d8d8 : canClaim ? 0xe0f0e8 : 0xf5f0e8;
      const bg = sketchPanel(cardW, cardH, { fill: fillColor, border: canClaim ? 0x4a7030 : C.line, width: canClaim ? 1.5 : 1.2, seed: seedFor(PAD, cy, i + 100) });
      bg.x = PAD; bg.y = cy;
      this.container.addChild(bg);

      const rewardLabel = reward.kind === 'coins'
        ? t('event.rewards.coins', { n: reward.count ?? 0 })
        : reward.id ?? reward.kind;
      // Type glyph prefix (coins → coin, craft material → its icon, skin → brush) when mappable.
      const rk: IconKind | null = reward.kind === 'coins' ? 'coin'
        : reward.kind === 'skin' ? 'brush'
          : materialIcon(reward.id) ?? materialIcon(reward.kind);
      let labelX = PAD + cardW * 0.04;
      if (rk) {
        const ic = Math.round(cardH * 0.42);
        const glyph = buildIcon(rk, ic, exhausted ? C.mid : reward.kind === 'coins' ? C.gold : C.accent);
        glyph.x = labelX; glyph.y = cy + cardH * 0.5 - ic / 2;
        this.container.addChild(glyph);
        labelX += ic + Math.round(cardH * 0.12);
      }
      const label = txt(rewardLabel, Math.round(cardH * 0.34), exhausted ? 0x999999 : 0x333333);
      label.anchor.set(0, 0.5);
      label.x = labelX;
      label.y = cy + cardH * 0.5;
      this.container.addChild(label);

      const costTxt = txt(`${reward.cost}pt`, Math.round(cardH * 0.32), canClaim ? 0x226644 : 0x888888);
      costTxt.anchor.set(0.5, 0.5);
      costTxt.x = PAD + cardW * 0.72;
      costTxt.y = cy + cardH * 0.5;
      this.container.addChild(costTxt);

      const claimedBadge = reward.maxClaims !== undefined
        ? txt(`${reward.claimedCount}/${reward.maxClaims}`, Math.round(cardH * 0.28), 0x888888)
        : null;
      if (claimedBadge) {
        claimedBadge.anchor.set(1, 1);
        claimedBadge.x = PAD + cardW * 0.97;
        claimedBadge.y = cy + cardH * 0.9;
        this.container.addChild(claimedBadge);
      }

      if (canClaim && this.cb.onClaimReward) {
        const claimLabel = txt(t('event.rewards.claim'), Math.round(cardH * 0.34), 0x2a5018);
        claimLabel.anchor.set(1, 0.5);
        claimLabel.x = PAD + cardW * 0.97;
        claimLabel.y = cy + cardH * 0.5;
        this.container.addChild(claimLabel);
        const { eventId } = event;
        const { rewardId } = reward;
        this.hits.push({ x: PAD, y: cy, w: cardW, h: cardH, fn: () => void this.doClaim(eventId, rewardId) });
      }
    });
  }

  private renderToast(): void {
    if (!this.toast) return;
    const { w, h } = this;
    const toastBg = new PIXI.Graphics();
    toastBg.beginFill(0x1a1408, 0.85);
    toastBg.drawRoundedRect(w * 0.15, h * 0.82, w * 0.7, h * 0.07, 8);
    toastBg.endFill();
    const toastTxt = txt(this.toast, Math.round(h * 0.028), 0xffd88a);
    toastTxt.anchor.set(0.5, 0.5);
    toastTxt.x = w / 2; toastTxt.y = h * 0.855;
    this.container.addChild(toastBg, toastTxt);
  }

  private async doClaim(eventId: string, rewardId: string): Promise<void> {
    if (this.bt.busy || !this.cb.onClaimReward) return;
    this.bt.start();
    try {
      const r = await withTimeout(this.cb.onClaimReward(eventId, rewardId));
      this.showToast(t('event.rewards.claimToast', { n: r.pointsLeft }));
      await this.load();
    } catch (e) {
      this.showToast(e instanceof TimeoutError ? t('common.networkTimeout') : t('event.rewards.claimFailed'));
    } finally {
      this.bt.stop();
    }
  }
}
