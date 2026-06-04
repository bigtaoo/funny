// ── Bone definitions ──────────────────────────────────────────────────────────

export interface BoneDef {
  id: string;
  parent: string | null;
  len: number;
  rwa: number;       // rest world angle (degrees)
  rla: number;       // rest local angle = rwa - parent.rwa
  outerW?: number;
  innerW?: number;
  isHead?: boolean;
  label: string;
}

export interface WorldPose {
  sx: number; sy: number;  // pivot (start)
  ex: number; ey: number;  // tip (end)
  wa: number;              // world angle (degrees)
}

export type WorldPositions = ReadonlyMap<string, WorldPose>;

// ── Easing ────────────────────────────────────────────────────────────────────

export type EasingType =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'step';

// ── Keyframes ─────────────────────────────────────────────────────────────────

/** All animatable properties for a single bone at a single keyframe. All optional;
 *  interpolation falls back to identity values when a field is absent. */
export interface BoneKeyframe {
  rotation?:   number;   // delta degrees, default 0
  scaleX?:     number;   // default 1
  scaleY?:     number;   // default 1
  translateX?: number;   // px, default 0
  translateY?: number;   // px, default 0
  alpha?:      number;   // 0–1, default 1; use 0 to hide the bone's sprite
  easing?:     EasingType;
}

/** Fully-resolved bone transform after interpolation (no optional fields). */
export interface ResolvedBoneTransform {
  rotation:   number;
  scaleX:     number;
  scaleY:     number;
  translateX: number;
  translateY: number;
  alpha:      number;
}

export interface Keyframe {
  time:  number;
  bones: Map<string, BoneKeyframe>;
}

export interface AnimationClip {
  duration:  number;
  loop:      boolean;
  keyframes: Keyframe[];
}

export type AnimationStore = Map<string, AnimationClip>;

// ── Sprite binding ────────────────────────────────────────────────────────────

/** Structural (non-animatable) config for how a bone's image is rendered.
 *  Each bone has exactly one image (1:1 mapping via ImageController).
 *  Initial orientation corrections go in the t=0 keyframe as rotation/translate. */
export interface SpriteBinding {
  anchorX: number;   // 0–1, default 0.5
  anchorY: number;   // 0–1, default 0.5
  flipX:   boolean;
  zOrder:  number;   // render layer: higher = in front; sort once on binding change
}

// ── Attachment Points ─────────────────────────────────────────────────────────

/** A non-animated attachment marker that follows a specific bone.
 *  Position = bone tip (ex, ey) + (offsetX, offsetY) in world space. */
export interface AttachmentPoint {
  id:         string;   // 'shadow' | 'hit'
  label:      string;
  parentBone: string;
  offsetX:    number;
  offsetY:    number;

  // Shadow-specific display size (only meaningful for id === 'shadow')
  shadowW?:   number;
  shadowH?:   number;
}
