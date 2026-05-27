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
  | 'step';          // instant jump; useful for sprite-frame switches

// ── Keyframes ─────────────────────────────────────────────────────────────────

/** All animatable properties for a single bone at a single keyframe. All optional;
 *  interpolation falls back to identity values when a field is absent. */
export interface BoneKeyframe {
  rotation?:   number;        // delta degrees, default 0
  scaleX?:     number;        // default 1
  scaleY?:     number;        // default 1
  translateX?: number;        // px, default 0
  translateY?: number;        // px, default 0
  alpha?:      number;        // 0–1, default 1
  frameId?:    string | null; // sprite switch; null = hide; undefined = use binding default
  easing?:     EasingType;    // exit curve, default 'linear'
}

/** Fully-resolved bone transform after interpolation (no optional fields). */
export interface ResolvedBoneTransform {
  rotation:   number;
  scaleX:     number;
  scaleY:     number;
  translateX: number;
  translateY: number;
  alpha:      number;
  frameId:    string | null;  // null = hide the bone's sprite
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

/** Structural (non-animatable) config for how a sprite attaches to a bone.
 *  Initial orientation corrections go in the t=0 keyframe as rotation/translate. */
export interface SpriteBinding {
  frameId: string;    // default atlas frame id
  anchorX: number;    // 0–1, default 0.5
  anchorY: number;    // 0–1, default 0.5
  flipX:   boolean;
}

// ── Atlas ─────────────────────────────────────────────────────────────────────

export interface AtlasFrame {
  x: number; y: number;
  w: number; h: number;
  pivotX: number; pivotY: number;
}

export interface AtlasAsset {
  id:     string;                     // filename without extension
  frames: Map<string, AtlasFrame>;   // frameId → AtlasFrame
}
