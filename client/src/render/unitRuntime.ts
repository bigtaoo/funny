// What UnitView needs from a battle unit's animated figure, whichever way it is drawn:
// a bone rig (stickman/StickmanRuntime) or a baked frame sheet (frames/FrameRuntime).
import type * as PIXI from 'pixi.js-legacy';
import type { GearGlyphSpec } from './stickman/runtimeTypes';

export interface UnitRuntimeOptions {
  /** Mirror horizontally (top-side / enemy units). */
  mirrorX?: boolean;
  /** On-screen height of the standing figure (unitSize.ts). */
  targetHeight?: number;
}

export interface UnitRuntime {
  readonly container: PIXI.Container;
  /** Rewind for reuse from a pool. */
  reset(options?: UnitRuntimeOptions): void;
  play(clip: string): void;
  /** Map a UnitState to its clip; replays a finished attack while the state holds. */
  syncState(unitState: string): void;
  /** Real attack cycle in seconds, so one attack clip plays per actual attack (0 = authored speed). */
  setAttackInterval(seconds: number): void;
  readonly currentDuration: number;
  update(dt: number): void;
  /** Hit-flash / spell-target contour; null clears it. */
  setOutlineFlash(color: number | null, alpha?: number): void;
  setGear(specs: GearGlyphSpec[]): void;
  getShadowGround(): { x: number; y: number; rx: number; ry: number } | null;
  getAttachmentOffset(id: string): { x: number; y: number } | null;
  destroy(): void;
}
