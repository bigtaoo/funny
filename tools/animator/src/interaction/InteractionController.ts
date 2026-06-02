import type { Renderer } from '../rendering/Renderer';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { CommandManager, Command } from '../core/CommandManager';
import type { BoneKeyframe } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';

// ── Hit-test ──────────────────────────────────────────────────────────────────

const HIT_RADIUS = 10;

// Pre-computed reversed draw order for front-first hit testing (computed lazily
// after Skeleton static init runs).
let _drawOrderReversed: readonly string[] | null = null;
function getDrawOrderReversed(): readonly string[] {
  if (!_drawOrderReversed) _drawOrderReversed = [...Skeleton.DRAW_ORDER].reverse();
  return _drawOrderReversed;
}

// ── Commands ──────────────────────────────────────────────────────────────────

class RotateBoneCommand implements Command {
  readonly label: string;

  constructor(
    private readonly animCtrl: AnimationController,
    private readonly boneId: string,
    private readonly oldRotation: number,
    private readonly newRotation: number,
    private readonly time: number,
    private readonly hadKeyframe: boolean,
  ) {
    this.label = `Rotate ${boneId} @ ${time.toFixed(3)}s`;
  }

  execute(): void {
    // Ensure a keyframe exists at this time, then update rotation
    const clip = this.animCtrl.currentClip;
    if (!clip) return;
    const existing = clip.keyframes.find(k => Math.abs(k.time - this.time) < 0.001);
    if (!existing) {
      // Create a keyframe with the current interpolated pose, patching this bone's rotation
      const frame = this.animCtrl.getCurrentFrame();
      const bones = new Map<string, BoneKeyframe>();
      frame.forEach((t, id) => {
        bones.set(id, {
          rotation:   id === this.boneId ? this.newRotation : t.rotation,
          scaleX:     t.scaleX,
          scaleY:     t.scaleY,
          translateX: t.translateX,
          translateY: t.translateY,
          alpha:      t.alpha,
          frameId:    t.frameId,
        });
      });
      if (!bones.has(this.boneId)) bones.set(this.boneId, { rotation: this.newRotation });
      this.animCtrl.addKeyframeAt(this.time, bones);
    } else {
      this.animCtrl.updateKeyframeProp(this.time, this.boneId, { rotation: this.newRotation });
    }
  }

  undo(): void {
    if (!this.hadKeyframe) {
      // Remove the keyframe we created
      this.animCtrl.deleteKeyframeAt(this.time);
    } else {
      this.animCtrl.updateKeyframeProp(this.time, this.boneId, { rotation: this.oldRotation });
    }
  }
}

class AddKeyframeCommand implements Command {
  readonly label: string;
  private snapshot: Map<string, BoneKeyframe> | null = null;

  constructor(
    private readonly animCtrl: AnimationController,
    private readonly time: number,
  ) {
    this.label = `Add Keyframe @ ${time.toFixed(3)}s`;
  }

  execute(): void {
    // Capture current interpolated pose on first execute
    if (!this.snapshot) {
      const frame = this.animCtrl.getCurrentFrame();
      this.snapshot = new Map(Array.from(frame.entries()).map(([id, t]) => [id, {
        rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY,
        translateX: t.translateX, translateY: t.translateY,
        alpha: t.alpha, frameId: t.frameId,
      }]));
    }
    this.animCtrl.addKeyframeAt(this.time, this.snapshot);
  }

  undo(): void {
    this.animCtrl.deleteKeyframeAt(this.time);
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

// ── InteractionController ─────────────────────────────────────────────────────

export class InteractionController {
  private isDragging     = false;
  private dragBoneId:    string | null = null;
  private dragStartX     = 0;
  private dragStartAngle = 0;  // angle at drag start
  private dragOldRotation = 0; // rotation delta before drag

  constructor(
    private readonly renderer: Renderer,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly cmdManager: CommandManager,
  ) {
    const canvas = renderer.pixiApp.view as HTMLCanvasElement;
    canvas.addEventListener('mousedown',  e => this.onMouseDown(e));
    canvas.addEventListener('mousemove',  e => this.onMouseMove(e));
    canvas.addEventListener('mouseup',    () => this.onMouseUp());
    canvas.addEventListener('mouseleave', () => this.onMouseUp());
    canvas.addEventListener('contextmenu', e => this.onRightDown(e));
    window.addEventListener('keydown',    e => this.onKeyDown(e));
  }

  // ── Mouse ─────────────────────────────────────────────────────────────────

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    const { x, y } = this.renderer.toStageCoords(e.clientX, e.clientY);
    const wp = this.animCtrl.getCurrentFrame();
    const worldPose = Skeleton.computeFK(this.state.rootX, this.state.rootY, wp);

    const boneId = this.findBoneAt(x, y, worldPose);

    if (boneId) {
      this.state.setSelectedBone(boneId);
      this.isDragging      = true;
      this.dragBoneId      = boneId;
      this.dragStartX      = e.clientX;

      // Bone's pivot position for angle calculation
      const pivot = worldPose.get(boneId)!;
      this.dragStartAngle  = Math.atan2(y - pivot.sy, x - pivot.sx);
      this.dragOldRotation = wp.get(boneId)?.rotation ?? 0;
    } else {
      this.state.setSelectedBone(null);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isDragging || !this.dragBoneId || this.state.isPlaying) return;

    const { x, y } = this.renderer.toStageCoords(e.clientX, e.clientY);
    const frame = this.animCtrl.getCurrentFrame();
    const worldPose = Skeleton.computeFK(this.state.rootX, this.state.rootY, frame);
    const pivot = worldPose.get(this.dragBoneId);
    if (!pivot) return;

    const angle = Math.atan2(y - pivot.sy, x - pivot.sx);
    const deltaDeg = ((angle - this.dragStartAngle) * 180) / Math.PI;
    this.animCtrl.setBoneDelta(this.dragBoneId, deltaDeg);
  }

  private onMouseUp(): void {
    if (!this.isDragging || !this.dragBoneId) {
      this.isDragging = false;
      return;
    }

    const frame = this.animCtrl.getCurrentFrame();
    const newRotation = frame.get(this.dragBoneId)?.rotation ?? 0;

    if (Math.abs(newRotation - this.dragOldRotation) > 0.01) {
      const t = this.state.currentTime;
      const clip = this.animCtrl.currentClip;
      const hadKf = clip?.keyframes.some(k => Math.abs(k.time - t) < 0.001) ?? false;
      const cmd = new RotateBoneCommand(
        this.animCtrl,
        this.dragBoneId,
        this.dragOldRotation,
        newRotation,
        t,
        hadKf,
      );
      this.animCtrl.clearLiveDelta();
      this.cmdManager.execute(cmd);
    } else {
      this.animCtrl.clearLiveDelta();
    }

    this.isDragging = false;
    this.dragBoneId = null;
  }

  private onRightDown(e: MouseEvent): void {
    e.preventDefault();
    // Pan: store start offset
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = this.state.rootX;
    const oy = this.state.rootY;

    const move = (ev: MouseEvent) => {
      const { x, y } = this.renderer.toStageCoords(ev.clientX, ev.clientY);
      const { x: sx, y: sy } = this.renderer.toStageCoords(startX, startY);
      this.state.setRootPos(ox + x - sx, oy + y - sy);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); this.cmdManager.undo(); return; }
      if (e.key === 'z' &&  e.shiftKey) { e.preventDefault(); this.cmdManager.redo(); return; }
      if (e.key === 'y')                { e.preventDefault(); this.cmdManager.redo(); return; }
    }

    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        this.state.setPreviewMode(this.state.previewMode === 'skeleton' ? 'sprite' : 'skeleton');
        break;
      case 'k':
      case 'K': {
        const t = this.state.currentTime;
        this.cmdManager.execute(new AddKeyframeCommand(this.animCtrl, t));
        this.bus.emit('status', `Keyframe added @ ${t.toFixed(3)}s`);
        break;
      }
      case 'Delete':
      case 'Backspace': {
        const t = this.state.selectedKfTime ?? this.state.currentTime;
        this.cmdManager.execute(new DeleteKeyframeCommand(this.animCtrl, t));
        this.bus.emit('status', `Keyframe deleted @ ${t.toFixed(3)}s`);
        break;
      }
      case ' ':
        e.preventDefault();
        this.animCtrl.toggle();
        break;
    }
  }

  // ── Hit-test ──────────────────────────────────────────────────────────────

  private findBoneAt(
    x: number,
    y: number,
    worldPose: ReturnType<typeof Skeleton.computeFK>,
  ): string | null {
    // Check head first (circle)
    const head = worldPose.get('head');
    if (head) {
      const dx = x - head.ex, dy = y - head.ey;
      if (Math.sqrt(dx * dx + dy * dy) <= Skeleton.HEAD_R + 4) return 'head';
    }

    // Check tubular bones — closest segment in reversed draw order (front first)
    let best: string | null = null;
    let bestDist = Infinity;

    for (const boneId of getDrawOrderReversed()) {
      if (boneId === 'head') continue;
      if (!Skeleton.SELECTABLE_BONES.includes(boneId)) continue;
      const pos = worldPose.get(boneId);
      if (!pos) continue;

      const dist = pointToSegmentDist(x, y, pos.sx, pos.sy, pos.ex, pos.ey);
      if (dist < HIT_RADIUS && dist < bestDist) {
        bestDist = dist;
        best = boneId;
      }
    }

    return best;
  }
}

// ── Geometry helper ───────────────────────────────────────────────────────────

function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
