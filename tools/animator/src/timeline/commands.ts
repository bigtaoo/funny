import type { Command } from '../core/CommandManager';
import type { AnimationController } from '../animation/AnimationController';
import type { BoneKeyframe, EasingType } from '../core/types';

// Undo/redo commands for the timeline's keyframe operations. Split out of TimelineView.ts on
// 2026-08-26 when that file crossed the repo's 500-line convention: these three classes are pure
// AnimationController calls with zero canvas/DOM/`this` dependency on the view, which makes them
// the "independent function module" the file-length gate asks you to extract first — and it is why
// test/TimelineView.test.ts can drive MoveKeyframeCommand against a real AnimationController.

/**
 * Undo entry for a keyframe drag. The drag itself already moved the keyframe live via
 * `animCtrl.moveKeyframe`, so this is handed to `CommandManager.pushExecuted` (never
 * `execute`) at the end of the drag — see TimelineView.endKfDrag.
 *
 * Paired with a real AnimationController this class IS the fix, so test/TimelineView.test.ts
 * asserts the undo/redo round-trip directly — that is what pins "not applied twice".
 */
export class MoveKeyframeCommand implements Command {
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

export class SetEasingCommand implements Command {
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
