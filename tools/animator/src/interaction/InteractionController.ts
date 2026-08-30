import type { Renderer } from '../rendering/Renderer';
import type { EventBus, AppEvents } from '../core/EventBus';
import type { AppState } from '../core/AppState';
import type { AnimationController } from '../animation/AnimationController';
import type { ImageController } from '../images/ImageController';
import type { CommandManager } from '../core/CommandManager';
import type { WorldPose, WorldPositions, SpriteBinding } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';
import {
  bindingToSpriteFrame, rotationHandlePos, spriteCorners, pointInQuad, computeAnchorDrag,
  worldToLocalPixel, alphaAt, MIN_HIT_ALPHA,
  type Vec2, type AlphaMask,
} from '../rendering/spriteGeometry';
import {
  RotateBoneCommand, AddKeyframeCommand, DeleteKeyframeCommand,
  SetLengthScaleCommand, SetBindingPropCommand,
} from './commands';

// ── Angle math ────────────────────────────────────────────────────────────────

/**
 * Unwrap one incremental angle step (radians, `to - from`) into `(-π, π]`.
 *
 * `Math.atan2` wraps at ±180°. Diffing the *current* drag angle against the
 * angle captured once at drag-start breaks the moment a continuous drag
 * crosses that seam: the raw difference suddenly jumps by a full turn,
 * making the bone snap backward (or spin an extra turn it shouldn't).
 * Instead, accumulate the small step between *consecutive* mousemove
 * samples — physical mouse movement between two samples never approaches
 * 180°, so unwrapping each step individually keeps a continuous drag
 * continuous, however many turns it spans.
 */
export function unwrapAngleStep(fromRad: number, toRad: number): number {
  let step = toRad - fromRad;
  if (step > Math.PI)  step -= 2 * Math.PI;
  if (step < -Math.PI) step += 2 * Math.PI;
  return step;
}

// ── Hit-test ──────────────────────────────────────────────────────────────────

const HIT_RADIUS        = 10;  // bone-segment hit radius (animate-mode rotate drag)
const HANDLE_HIT_RADIUS = 9;   // skin-mode handle hit radius (length tip / rotation knob)

// Pre-computed reversed draw order for front-first hit testing (computed lazily
// after Skeleton static init runs).
let _drawOrderReversed: readonly string[] | null = null;
function getDrawOrderReversed(): readonly string[] {
  if (!_drawOrderReversed) _drawOrderReversed = [...Skeleton.DRAW_ORDER].reverse();
  return _drawOrderReversed;
}

// ── Drag state ────────────────────────────────────────────────────────────────

type DragState =
  | { mode: 'bone-rotate'; boneId: string; lastAngle: number; accumDeg: number; oldRotation: number }
  | { mode: 'bone-length'; boneId: string; boneLen: number; oldScale: number }
  | { mode: 'binding-rotate'; boneId: string; lastAngle: number; accumDeg: number; oldRotation: number }
  | {
      mode: 'binding-anchor';
      boneId: string;
      startMouse: Vec2;
      startAnchor: Vec2;
      rotationRad: number;
      scaleX: number;
      scaleY: number;
      texW: number;
      texH: number;
    };

// ── InteractionController ─────────────────────────────────────────────────────

export class InteractionController {
  private drag: DragState | null = null;

  constructor(
    private readonly renderer: Renderer,
    private readonly bus: EventBus<AppEvents>,
    private readonly state: AppState,
    private readonly animCtrl: AnimationController,
    private readonly cmdManager: CommandManager,
    private readonly imageCtrl: ImageController,
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

    const skinMode = this.state.editorMode === 'skin';
    // In Skin mode the pose is fixed at rest; hit-test against the rest pose.
    const frame = skinMode
      ? new Map<string, import('../core/types').ResolvedBoneTransform>()
      : this.animCtrl.getCurrentFrame();
    const { x, y } = this.renderer.toStageCoords(e.clientX, e.clientY);
    const worldPose = Skeleton.computeFK(this.state.rootX, this.state.rootY, frame, this.state.boneLengthScales);

    if (skinMode) {
      // Priority 1: a handle on the already-selected bone (length tip / rotation knob).
      if (this.tryStartSkinHandleDrag(x, y, worldPose)) return;

      // Priority 2: click directly on a sprite (front-to-back by zOrder) — selects
      // its bone and arms an anchor drag in the same gesture, only when the sprite
      // is actually visible on screen (Sprite preview mode).
      if (this.state.previewMode === 'sprite') {
        const spriteHit = findSpriteAt(x, y, worldPose, this.state.boneBindings, id => this.imageCtrl.getTexture(id), {
          getAlphaMask: id => this.imageCtrl.getAlphaMask(id),
          preferBone:   this.state.selectedBone,
        });
        if (spriteHit) {
          this.state.setSelectedBone(spriteHit);
          this.startBindingAnchorDrag(spriteHit, worldPose, x, y);
          return;
        }
      }

      // Priority 3: fall back to selecting a bone by its (invisible, in Sprite
      // preview) segment — bone rotation is locked in Skin mode, selection only.
      this.state.setSelectedBone(findBoneAt(x, y, worldPose));
      return;
    }

    // Animate mode: canvas-drag rotates the selected bone (unchanged behaviour).
    const boneId = findBoneAt(x, y, worldPose);
    if (boneId) {
      this.state.setSelectedBone(boneId);
      const pivot = worldPose.get(boneId)!;
      this.drag = {
        mode:        'bone-rotate',
        boneId,
        lastAngle:   Math.atan2(y - pivot.sy, x - pivot.sx),
        accumDeg:    0,
        oldRotation: frame.get(boneId)?.rotation ?? 0,
      };
    } else {
      this.state.setSelectedBone(null);
    }
  }

  /** Skin-mode handle hit-test for the CURRENTLY selected bone (length tip, and —
   *  only in Sprite preview — its binding's rotation knob). Arms the matching drag
   *  and returns true on hit. Geometry lives in the free `findSkinHandleAt` below;
   *  this just fetches the live state it needs and builds the resulting DragState. */
  private tryStartSkinHandleDrag(x: number, y: number, worldPose: WorldPositions): boolean {
    const boneId = this.state.selectedBone;
    if (!boneId) return false;
    const pos     = worldPose.get(boneId);
    const binding = this.state.previewMode === 'sprite' ? this.state.getBinding(boneId) : undefined;
    const texture = binding ? this.imageCtrl.getTexture(boneId) : undefined;

    const hit = findSkinHandleAt(x, y, boneId, worldPose, this.state.previewMode, binding, texture);
    if (!hit || !pos) return false;

    if (hit === 'length') {
      const bone = Skeleton.BONE_MAP.get(boneId)!;
      this.drag = { mode: 'bone-length', boneId, boneLen: bone.len, oldScale: this.state.getLengthScale(boneId) };
    } else {
      this.drag = {
        mode:        'binding-rotate',
        boneId,
        lastAngle:   Math.atan2(y - pos.sy, x - pos.sx),
        accumDeg:    0,
        oldRotation: binding!.rotation ?? 0,
      };
    }
    return true;
  }

  private startBindingAnchorDrag(boneId: string, worldPose: WorldPositions, x: number, y: number): void {
    const binding = this.state.getBinding(boneId);
    const pos     = worldPose.get(boneId);
    const texture = this.imageCtrl.getTexture(boneId);
    if (!binding || !pos || !texture) return;

    this.drag = {
      mode:        'binding-anchor',
      boneId,
      startMouse:  { x, y },
      startAnchor: { x: binding.anchorX, y: binding.anchorY },
      rotationRad: ((pos.wa + (binding.rotation ?? 0)) * Math.PI) / 180,
      scaleX:      (binding.flipX ? -1 : 1) * (binding.scaleX ?? 1),
      scaleY:      binding.scaleY ?? 1,
      texW:        texture.width,
      texH:        texture.height,
    };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.drag || this.state.isPlaying) return;
    const { x, y } = this.renderer.toStageCoords(e.clientX, e.clientY);

    switch (this.drag.mode) {
      case 'bone-rotate': {
        const frame     = this.animCtrl.getCurrentFrame();
        const worldPose = Skeleton.computeFK(this.state.rootX, this.state.rootY, frame, this.state.boneLengthScales);
        const pivot     = worldPose.get(this.drag.boneId);
        if (!pivot) return;
        const angle = Math.atan2(y - pivot.sy, x - pivot.sx);
        this.drag.accumDeg += (unwrapAngleStep(this.drag.lastAngle, angle) * 180) / Math.PI;
        this.drag.lastAngle = angle;
        this.animCtrl.setBoneDelta(this.drag.boneId, this.drag.accumDeg);
        break;
      }

      case 'bone-length': {
        const pos = this.restPos(this.drag.boneId);
        if (!pos) return;
        const newLen = Math.hypot(x - pos.sx, y - pos.sy);
        const scale  = Math.max(0.05, newLen / this.drag.boneLen);
        this.state.setLengthScale(this.drag.boneId, scale);
        break;
      }

      case 'binding-rotate': {
        const pos = this.restPos(this.drag.boneId);
        if (!pos) return;
        const angle = Math.atan2(y - pos.sy, x - pos.sx);
        this.drag.accumDeg += (unwrapAngleStep(this.drag.lastAngle, angle) * 180) / Math.PI;
        this.drag.lastAngle = angle;
        const binding = this.state.getBinding(this.drag.boneId);
        if (binding) {
          this.state.setBinding(this.drag.boneId, { ...binding, rotation: this.drag.oldRotation + this.drag.accumDeg });
        }
        break;
      }

      case 'binding-anchor': {
        const binding = this.state.getBinding(this.drag.boneId);
        if (!binding) return;
        const anchor = computeAnchorDrag(
          this.drag.startMouse, this.drag.startAnchor, this.drag.rotationRad,
          this.drag.scaleX, this.drag.scaleY, this.drag.texW, this.drag.texH,
          x, y,
        );
        this.state.setBinding(this.drag.boneId, { ...binding, anchorX: anchor.x, anchorY: anchor.y });
        break;
      }
    }
  }

  private onMouseUp(): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;

    switch (drag.mode) {
      case 'bone-rotate': {
        const frame        = this.animCtrl.getCurrentFrame();
        const newRotation  = frame.get(drag.boneId)?.rotation ?? 0;
        if (Math.abs(newRotation - drag.oldRotation) > 0.01) {
          const t     = this.state.currentTime;
          const clip  = this.animCtrl.currentClip;
          const hadKf = clip?.keyframes.some(k => Math.abs(k.time - t) < 0.001) ?? false;
          this.animCtrl.clearLiveDelta();
          this.cmdManager.execute(new RotateBoneCommand(this.animCtrl, drag.boneId, drag.oldRotation, newRotation, t, hadKf));
        } else {
          this.animCtrl.clearLiveDelta();
        }
        break;
      }

      case 'bone-length': {
        const newScale = this.state.getLengthScale(drag.boneId);
        if (Math.abs(newScale - drag.oldScale) > 1e-4) {
          this.cmdManager.pushExecuted(new SetLengthScaleCommand(this.state, drag.boneId, drag.oldScale, newScale));
        }
        break;
      }

      case 'binding-rotate': {
        const newRotation = this.state.getBinding(drag.boneId)?.rotation ?? drag.oldRotation;
        if (Math.abs(newRotation - drag.oldRotation) > 0.01) {
          const label = `Rotate ${Skeleton.BONE_MAP.get(drag.boneId)?.label ?? drag.boneId} Image`;
          this.cmdManager.pushExecuted(new SetBindingPropCommand(
            this.state, drag.boneId, { rotation: drag.oldRotation }, { rotation: newRotation }, label,
          ));
        }
        break;
      }

      case 'binding-anchor': {
        const b         = this.state.getBinding(drag.boneId);
        const newAnchor = { anchorX: b?.anchorX ?? drag.startAnchor.x, anchorY: b?.anchorY ?? drag.startAnchor.y };
        const oldAnchor = { anchorX: drag.startAnchor.x, anchorY: drag.startAnchor.y };
        if (Math.hypot(newAnchor.anchorX - oldAnchor.anchorX, newAnchor.anchorY - oldAnchor.anchorY) > 1e-4) {
          const label = `Move ${Skeleton.BONE_MAP.get(drag.boneId)?.label ?? drag.boneId} Image`;
          this.cmdManager.pushExecuted(new SetBindingPropCommand(this.state, drag.boneId, oldAnchor, newAnchor, label));
        }
        break;
      }
    }
  }

  /** Rest-pose (all keyframe rotations = 0) world pose for one bone — the frame
   *  every Skin-mode handle drags against, regardless of Animate-mode playback state. */
  private restPos(boneId: string): WorldPose | undefined {
    const worldPose = Skeleton.computeFK(this.state.rootX, this.state.rootY, new Map(), this.state.boneLengthScales);
    return worldPose.get(boneId);
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
      case 's':
      case 'S':
        e.preventDefault();
        this.state.setEditorMode(this.state.editorMode === 'skin' ? 'animate' : 'skin');
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
}

// ── Geometry helper ───────────────────────────────────────────────────────────

export function pointToSegmentDist(
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

/** Nearest hit-testable bone at a stage point (head circle first, then closest
 *  tubular-bone segment within HIT_RADIUS, front-first draw order). Doesn't
 *  depend on controller state — free function so it's testable without wiring
 *  up canvas/window listeners. */
export function findBoneAt(
  x: number,
  y: number,
  worldPose: WorldPositions,
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

export type SkinHandleKind = 'length' | 'rotate';

/** Which skin-mode handle (if any) sits under a stage point, for the CURRENTLY
 *  selected bone — its length tip (always, when the bone has length and isn't the
 *  head), or its binding's rotation knob (only in Sprite preview, when it has a
 *  binding + loaded texture). Doesn't build the resulting drag state (the caller
 *  still needs live state — `AppState.getLengthScale`, the binding's own
 *  `rotation` — to do that) or depend on controller state itself — free function
 *  so it's testable without wiring up canvas listeners. */
export function findSkinHandleAt(
  x: number,
  y: number,
  boneId: string,
  worldPose: WorldPositions,
  previewMode: 'skeleton' | 'sprite',
  binding: SpriteBinding | undefined,
  texture: { width: number; height: number } | undefined,
): SkinHandleKind | null {
  const bone = Skeleton.BONE_MAP.get(boneId);
  const pos  = worldPose.get(boneId);
  if (!bone || !pos) return null;

  if (bone.len > 0 && !bone.isHead && Math.hypot(x - pos.ex, y - pos.ey) <= HANDLE_HIT_RADIUS) {
    return 'length';
  }

  if (previewMode === 'sprite' && binding && texture) {
    const frame  = bindingToSpriteFrame(pos.sx, pos.sy, pos.wa, binding, texture.width, texture.height);
    const handle = rotationHandlePos(frame);
    if (Math.hypot(x - handle.x, y - handle.y) <= HANDLE_HIT_RADIUS) return 'rotate';
  }

  return null;
}

export interface SpriteHitOptions {
  /** Per-slot alpha mask lookup. A sprite that has one is hit only where its pixels are
   *  actually painted; one that doesn't (mask still decoding, or undecodable) falls back
   *  to its plain quad, i.e. the pre-alpha behaviour. */
  getAlphaMask?: (boneId: string) => AlphaMask | undefined;
  /** The currently selected bone. When the click lands on it, it keeps the selection even
   *  if a higher-zOrder sprite also covers that point — picking a part from the bone list
   *  and then clicking it on canvas must not hand the selection to whatever is in front. */
  preferBone?: string | null;
}

/** Nearest sprite (front-to-back by zOrder) whose *painted pixels* contain a stage point —
 *  Skin-mode's "click the image directly" hit-test. The quad is only the first pass: the
 *  spine's texture rectangle swallows both shoulders, so a quad-only test made every part
 *  under it unclickable however the bone list was used. Doesn't depend on controller state —
 *  free function so it's testable without wiring up canvas listeners. `getTexture` is typed
 *  structurally (not PIXI.Texture) to keep this module PIXI-free. */
export function findSpriteAt(
  x: number,
  y: number,
  worldPose: WorldPositions,
  bindings: ReadonlyMap<string, SpriteBinding>,
  getTexture: (boneId: string) => { width: number; height: number } | undefined,
  opts: SpriteHitOptions = {},
): string | null {
  const candidates = [...bindings.entries()]
    .filter(([boneId]) => getTexture(boneId))
    .sort((a, b) => b[1].zOrder - a[1].zOrder);   // highest zOrder (frontmost) first

  let frontmost: string | null = null;

  for (const [boneId, binding] of candidates) {
    const pose    = worldPose.get(boneId);
    const texture = getTexture(boneId);
    if (!pose || !texture) continue;
    const frame = bindingToSpriteFrame(pose.sx, pose.sy, pose.wa, binding, texture.width, texture.height);
    if (!pointInQuad(x, y, spriteCorners(frame))) continue;

    const mask = opts.getAlphaMask?.(boneId);
    if (mask) {
      const local = worldToLocalPixel(frame, x, y);
      if (!local) continue;
      if (alphaAt(mask, frame.texW, frame.texH, local.x, local.y) < MIN_HIT_ALPHA) continue;
    }

    if (boneId === opts.preferBone) return boneId;   // sticky selection beats zOrder
    if (frontmost === null) frontmost = boneId;
  }

  return frontmost;
}
