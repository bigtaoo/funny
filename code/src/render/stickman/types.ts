// Shared types for the skeletal animation runtime.
// Matches the animator's core/types.ts — keep in sync.

// ── Bone ──────────────────────────────────────────────────────────────────────

export interface BoneDef {
  id:      string;
  parent:  string | null;
  len:     number;
  rwa:     number;    // rest world angle (degrees)
  rla:     number;    // rest local angle = rwa - parent.rwa
  outerW?: number;
  innerW?: number;
  isHead?: boolean;
  label:   string;
}

export interface WorldPose {
  sx: number; sy: number;  // pivot (start)
  ex: number; ey: number;  // tip   (end)
  wa: number;              // world angle (degrees)
}

export type WorldPositions = ReadonlyMap<string, WorldPose>;

// ── Easing & keyframes ────────────────────────────────────────────────────────

export type EasingType = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'step';

export interface BoneKeyframe {
  rotation?:   number;    // delta degrees, default 0
  scaleX?:     number;    // default 1
  scaleY?:     number;    // default 1
  translateX?: number;    // px, default 0
  translateY?: number;    // px, default 0
  alpha?:      number;    // 0-1, default 1
  easing?:     EasingType;
}

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

// ── Sprite binding ────────────────────────────────────────────────────────────

export interface SpriteBinding {
  anchorX:  number;   // 0-1
  anchorY:  number;   // 0-1
  flipX:    boolean;
  zOrder:   number;
  rotation: number;   // degrees, additive
  scaleX:   number;   // multiplicative
  scaleY:   number;
  offsetX:  number;   // world-space pixel offset
  offsetY:  number;
}
