/** Bone definition (including computed rest local angle). */
export interface BoneDef {
  id: string;
  parent: string | null;
  len: number;
  /** Rest world angle in degrees (0 = right, positive = clockwise). */
  rwa: number;
  /** Rest local angle = rwa - parent.rwa (computed on init). */
  rla: number;
  outerW?: number;
  innerW?: number;
  isHead?: boolean;
  label: string;
}

/** World-space position and angle of a single bone. */
export interface WorldPose {
  sx: number; sy: number; // start (pivot)
  ex: number; ey: number; // end (tip)
  wa: number;             // world angle in degrees
}

/** Map of bone id → WorldPose, result of FK computation. */
export type WorldPositions = Record<string, WorldPose>;

/** Per-bone angle deltas (degrees) relative to rest pose. */
export type BoneDeltas = Record<string, number>;

/** A single keyframe in an animation clip. */
export interface Keyframe {
  time: number;
  bones: BoneDeltas;
}

/** A named animation clip. */
export interface AnimationClip {
  duration: number;
  loop: boolean;
  keyframes: Keyframe[];
}

/** The full animation store (name → clip). */
export type AnimationStore = Record<string, AnimationClip>;
