// Undo/redo commands for canvas-driven bone/sprite edits — split out of
// InteractionController.ts (2026-08-29) once that file crossed the 500-line convention,
// same rationale/precedent as src/timeline/commands.ts (2026-08-26): these are plain
// AnimationController/AppState calls with zero canvas/DOM/`this` dependency on the
// controller that creates them.
import type { AnimationController } from '../animation/AnimationController';
import type { AppState } from '../core/AppState';
import type { Command } from '../core/CommandManager';
import type { BoneKeyframe, SpriteBinding } from '../core/types';
import { Skeleton } from '../skeleton/Skeleton';

// ── Animate-mode keyframe commands ───────────────────────────────────────────────

export class RotateBoneCommand implements Command {
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

export class AddKeyframeCommand implements Command {
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
        alpha: t.alpha,
      }]));
    }
    this.animCtrl.addKeyframeAt(this.time, this.snapshot);
  }

  undo(): void {
    this.animCtrl.deleteKeyframeAt(this.time);
  }
}

export class DeleteKeyframeCommand implements Command {
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

// ── Skin-mode rig/binding commands ───────────────────────────────────────────────

/** Rig-property change (bone length scale) made via the skin-mode length handle
 *  (or the Bone Inspector's numeric input, which reuses this same command). */
export class SetLengthScaleCommand implements Command {
  readonly label: string;

  constructor(
    private readonly state: AppState,
    private readonly boneId: string,
    private readonly oldScale: number,
    private readonly newScale: number,
  ) {
    this.label = `Set ${Skeleton.BONE_MAP.get(boneId)?.label ?? boneId} Length`;
  }

  execute(): void { this.state.setLengthScale(this.boneId, this.newScale); }
  undo(): void    { this.state.setLengthScale(this.boneId, this.oldScale); }
}

/** SpriteBinding property change made via a skin-mode canvas handle (image rotation
 *  knob, image-body drag for anchor) — or the Bone Inspector's matching numeric
 *  input, which reuses this same command. Re-reads the binding fresh on
 *  execute/undo (rather than capturing it) so it never clobbers unrelated fields
 *  another edit changed in between. */
export class SetBindingPropCommand implements Command {
  readonly label: string;

  constructor(
    private readonly state: AppState,
    private readonly boneId: string,
    private readonly oldProps: Partial<SpriteBinding>,
    private readonly newProps: Partial<SpriteBinding>,
    label?: string,
  ) {
    this.label = label ?? `Update ${Skeleton.BONE_MAP.get(boneId)?.label ?? boneId} Image`;
  }

  execute(): void {
    const binding = this.state.getBinding(this.boneId);
    if (binding) this.state.setBinding(this.boneId, { ...binding, ...this.newProps });
  }

  undo(): void {
    const binding = this.state.getBinding(this.boneId);
    if (binding) this.state.setBinding(this.boneId, { ...binding, ...this.oldProps });
  }
}
