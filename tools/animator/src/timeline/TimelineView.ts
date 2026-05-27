import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { CommandManager, Command } from '../core/CommandManager';
import type { AnimationClip, BoneKeyframe, EasingType, Keyframe } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';
import { ContextMenu } from './ContextMenu';

const ROW_H   = 26;
const RULER_H = 20;

// ── Commands ──────────────────────────────────────────────────────────────────

class MoveKeyframeCommand implements Command {
  readonly label: string;
  constructor(
    private readonly animCtrl: AnimationController,
    private readonly oldTime: number,
    private readonly newTime: number,
  ) {
    this.label = `Move Keyframe ${oldTime.toFixed(3)}s → ${newTime.toFixed(3)}s`;
  }
  execute(): void { this.animCtrl.moveKeyframe(this.oldTime, this.newTime); }
  undo():    void { this.animCtrl.moveKeyframe(this.newTime, this.oldTime); }
}

class SetEasingCommand implements Command {
  readonly label: string;
  private old: EasingType | undefined;
  constructor(
    private readonly animCtrl: AnimationController,
    private readonly time: number,
    private readonly boneId: string,
    private readonly easing: EasingType,
  ) {
    this.label = `Set easing ${boneId} @ ${time.toFixed(3)}s`;
  }
  execute(): void {
    const kf = this.animCtrl.currentClip?.keyframes.find(k => Math.abs(k.time - this.time) < 0.001);
    this.old = kf?.bones.get(this.boneId)?.easing;
    this.animCtrl.updateKeyframeProp(this.time, this.boneId, { easing: this.easing });
  }
  undo(): void {
    this.animCtrl.updateKeyframeProp(this.time, this.boneId, { easing: this.old });
  }
}

class DeleteKeyframeCommand implements Command {
  readonly label: string;
  private deleted: Map<string, BoneKeyframe> | null = null;
  constructor(
    private readonly animCtrl: AnimationController,
    private readonly time: number,
  ) {
    this.label = `Delete Keyframe @ ${time.toFixed(3)}s`;
  }
  execute(): void {
    const kf = this.animCtrl.currentClip?.keyframes.find(k => Math.abs(k.time - this.time) < 0.001);
    if (kf) this.deleted = new Map(Array.from(kf.bones.entries()).map(([id, b]) => [id, { ...b }]));
    this.animCtrl.deleteKeyframeAt(this.time);
  }
  undo(): void {
    if (this.deleted) this.animCtrl.addKeyframeAt(this.time, this.deleted);
  }
}

// ── TimelineView ──────────────────────────────────────────────────────────────

export class TimelineView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly contextMenu: ContextMenu;

  private isScrubbing  = false;
  private isDraggingKf = false;
  private dragKfTime   = 0;

  constructor(
    private readonly canvasEl: HTMLCanvasElement,
    private readonly labelContainer: HTMLElement,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly cmdManager: CommandManager,
  ) {
    this.ctx = canvasEl.getContext('2d')!;
    this.contextMenu = new ContextMenu();

    canvasEl.addEventListener('mousedown',   e => this.onMouseDown(e));
    canvasEl.addEventListener('mousemove',   e => this.onMouseMove(e));
    canvasEl.addEventListener('mouseup',     e => this.onMouseUp(e));
    canvasEl.addEventListener('mouseleave',  () => { this.isScrubbing = false; this.isDraggingKf = false; });
    canvasEl.addEventListener('contextmenu', e => this.onContextMenu(e));

    bus.on('kf:change',   () => this.render());
    bus.on('time:change', () => this.render());
    bus.on('anim:select', () => this.render());
    bus.on('bone:select', () => this.render());
  }

  render(): void {
    const W = this.canvasEl.parentElement!.clientWidth;
    const H = this.canvasEl.parentElement!.clientHeight;
    if (this.canvasEl.width !== W || this.canvasEl.height !== H) {
      this.canvasEl.width  = W;
      this.canvasEl.height = H;
    }

    const clip = this.animCtrl.currentClip;
    const dur  = clip?.duration ?? 0.5;

    this.ctx.clearRect(0, 0, W, H);
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, W, H);

    this.drawRuler(W, dur);
    this.drawRows(W, clip, dur);
    this.drawPlayhead(W, dur);
    this.renderLabels(clip);
  }

  destroy(): void {
    this.contextMenu.destroy();
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private drawRuler(W: number, dur: number): void {
    this.ctx.fillStyle = '#2e2e46';
    this.ctx.fillRect(0, 0, W, RULER_H);
    this.ctx.strokeStyle = '#3a3a58';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath(); this.ctx.moveTo(0, RULER_H); this.ctx.lineTo(W, RULER_H); this.ctx.stroke();

    for (let i = 0; i <= 10; i++) {
      const x = (i / 10) * W;
      const t = (i / 10) * dur;
      this.ctx.strokeStyle = '#6e6e8a';
      this.ctx.beginPath(); this.ctx.moveTo(x, RULER_H - 8); this.ctx.lineTo(x, RULER_H); this.ctx.stroke();
      this.ctx.fillStyle = '#89899a';
      this.ctx.font = '9px monospace';
      this.ctx.fillText(t.toFixed(2), x + 2, 13);
    }
  }

  private drawRows(W: number, clip: AnimationClip | null, dur: number): void {
    Skeleton.TIMELINE_BONES.forEach((boneId, ri) => {
      const y = RULER_H + ri * ROW_H;
      this.ctx.fillStyle = ri % 2 === 0 ? '#1e1e30' : '#1a1a2e';
      this.ctx.fillRect(0, y, W, ROW_H);
      this.ctx.strokeStyle = '#2a2a40';
      this.ctx.lineWidth = 1;
      this.ctx.beginPath(); this.ctx.moveTo(0, y + ROW_H); this.ctx.lineTo(W, y + ROW_H); this.ctx.stroke();

      if (!clip) return;

      clip.keyframes.forEach(kf => {
        if (!kf.bones.has(boneId)) return;
        const kx = (kf.time / Math.max(dur, 0.001)) * W;
        const ky = y + ROW_H / 2;
        const isSelected = this.state.selectedKfTime != null &&
          Math.abs(kf.time - this.state.selectedKfTime) < 0.001;

        this.ctx.fillStyle   = isSelected ? '#74c7ec' : '#f9e2af';
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth   = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(kx, ky - 6); this.ctx.lineTo(kx + 5, ky);
        this.ctx.lineTo(kx, ky + 6); this.ctx.lineTo(kx - 5, ky);
        this.ctx.closePath();
        this.ctx.fill(); this.ctx.stroke();
      });
    });
  }

  private drawPlayhead(W: number, dur: number): void {
    const px = (this.state.currentTime / Math.max(dur, 0.001)) * W;
    const H  = this.canvasEl.height;
    this.ctx.strokeStyle = '#f38ba8';
    this.ctx.lineWidth   = 2;
    this.ctx.beginPath(); this.ctx.moveTo(px, 0); this.ctx.lineTo(px, H); this.ctx.stroke();
    this.ctx.fillStyle = '#f38ba8';
    this.ctx.fillRect(px - 4, 0, 8, RULER_H);
  }

  private renderLabels(clip: AnimationClip | null): void {
    this.labelContainer.innerHTML = '<div class="tl-label-spacer"></div>';

    Skeleton.TIMELINE_BONES.forEach(boneId => {
      const bone  = Skeleton.BONE_MAP.get(boneId);
      const hasKf = clip?.keyframes.some(kf => kf.bones.has(boneId)) ?? false;

      const row = document.createElement('div');
      row.className = 'tl-label-row' + (boneId === this.state.selectedBone ? ' active' : '');
      row.innerHTML = `<div class="tl-label-dot" style="opacity:${hasKf ? 1 : 0.3}"></div>${bone?.label ?? boneId}`;
      row.addEventListener('click', () => this.state.setSelectedBone(boneId));
      this.labelContainer.appendChild(row);
    });
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  private getTimeFromX(clientX: number): number {
    const rect = this.canvasEl.getBoundingClientRect();
    const x    = clientX - rect.left;
    const dur  = this.animCtrl.currentClip?.duration ?? 0.5;
    return Math.max(0, Math.min(dur, (x / this.canvasEl.width) * dur));
  }

  private getRowFromY(clientY: number): { ri: number; boneId: string } | null {
    const rect = this.canvasEl.getBoundingClientRect();
    const y    = clientY - rect.top;
    const ri   = Math.floor((y - RULER_H) / ROW_H);
    if (ri < 0 || ri >= Skeleton.TIMELINE_BONES.length) return null;
    return { ri, boneId: Skeleton.TIMELINE_BONES[ri] };
  }

  private findKfAt(clientX: number, clientY: number): { kf: Keyframe; boneId: string } | null {
    const row = this.getRowFromY(clientY);
    if (!row) return null;
    const clip = this.animCtrl.currentClip;
    if (!clip) return null;

    const rect = this.canvasEl.getBoundingClientRect();
    const x    = clientX - rect.left;
    const dur  = clip.duration;
    const { boneId } = row;

    for (const kf of clip.keyframes) {
      if (!kf.bones.has(boneId)) continue;
      const kx = (kf.time / Math.max(dur, 0.001)) * this.canvasEl.width;
      if (Math.abs(kx - x) < 8) return { kf, boneId };
    }
    return null;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    const hit = this.findKfAt(e.clientX, e.clientY);
    if (hit) {
      this.isDraggingKf = true;
      this.dragKfTime   = hit.kf.time;
      this.state.setSelectedKfTime(hit.kf.time);
      this.state.setCurrentTime(hit.kf.time);
      this.state.setSelectedBone(hit.boneId);
    } else {
      this.isScrubbing = true;
      const row = this.getRowFromY(e.clientY);
      if (row) this.state.setSelectedBone(row.boneId);
      const t = this.getTimeFromX(e.clientX);
      this.state.setCurrentTime(t);
      this.state.setSelectedKfTime(null);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isDraggingKf && !this.state.isPlaying) {
      const newT = this.getTimeFromX(e.clientX);
      this.animCtrl.moveKeyframe(this.dragKfTime, newT);
      this.dragKfTime = newT;
      this.state.setCurrentTime(newT);
    } else if (this.isScrubbing && !this.state.isPlaying) {
      const t = this.getTimeFromX(e.clientX);
      this.state.setCurrentTime(t);
      this.state.setSelectedKfTime(null);
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (this.isDraggingKf) {
      // Already mutated via moveKeyframe; commit as Command if time actually changed
      this.isDraggingKf = false;
    }
    this.isScrubbing = false;
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const hit = this.findKfAt(e.clientX, e.clientY);
    if (!hit) return;

    const { kf, boneId } = hit;
    const easings: EasingType[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'step'];
    const current = kf.bones.get(boneId)?.easing ?? 'linear';

    this.contextMenu.show(e.clientX, e.clientY, [
      { label: '─── Easing ───', disabled: true, action: () => {} },
      ...easings.map(eas => ({
        label:  (eas === current ? '✓ ' : '  ') + eas,
        action: () => this.cmdManager.execute(new SetEasingCommand(this.animCtrl, kf.time, boneId, eas)),
      })),
      { label: '─────────────', disabled: true, action: () => {} },
      { label: 'Copy keyframe',  action: () => this.animCtrl.copyKeyframe(kf.time) },
      { label: 'Paste keyframe', action: () => this.animCtrl.pasteKeyframe(this.state.currentTime) },
      { label: 'Delete keyframe', action: () => this.cmdManager.execute(new DeleteKeyframeCommand(this.animCtrl, kf.time)) },
    ]);
  }
}
