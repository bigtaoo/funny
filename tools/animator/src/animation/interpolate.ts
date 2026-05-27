/**
 * Pure interpolation functions — no DOM, no PIXI, no side effects.
 * Shared between the editor and the game-side runtime.
 */
import type {
  EasingType,
  BoneKeyframe,
  ResolvedBoneTransform,
  AnimationClip,
} from '../core/types';

// ── Easing ────────────────────────────────────────────────────────────────────

/** Map a linear t (0–1) through an easing curve. */
export function applyEasing(t: number, type: EasingType = 'linear'): number {
  switch (type) {
    case 'ease-in':     return t * t;
    case 'ease-out':    return t * (2 - t);
    case 'ease-in-out': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'step':        return t < 1 ? 0 : 1;
    default:            return t;  // linear
  }
}

// ── Identity defaults ─────────────────────────────────────────────────────────

const DEFAULTS: Required<Omit<BoneKeyframe, 'easing' | 'frameId'>> = {
  rotation:   0,
  scaleX:     1,
  scaleY:     1,
  translateX: 0,
  translateY: 0,
  alpha:      1,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Single-bone interpolation ─────────────────────────────────────────────────

/**
 * Interpolate between two BoneKeyframes.
 * @param kf1   Keyframe at or before current time.
 * @param kf2   Next keyframe.
 * @param f     Raw linear factor between kf1 and kf2 (0–1).
 *              The easing from kf1.easing is applied internally.
 */
export function interpolateBone(
  kf1: BoneKeyframe,
  kf2: BoneKeyframe,
  f: number,
): ResolvedBoneTransform {
  const ef = applyEasing(f, kf1.easing ?? 'linear');

  // frameId: step behaviour — use kf2's frameId only when ef reaches 1
  const frameId =
    ef >= 1
      ? (kf2.frameId !== undefined ? kf2.frameId : (kf1.frameId ?? null))
      : (kf1.frameId !== undefined ? kf1.frameId : null);

  return {
    rotation:   lerp(kf1.rotation   ?? DEFAULTS.rotation,   kf2.rotation   ?? DEFAULTS.rotation,   ef),
    scaleX:     lerp(kf1.scaleX     ?? DEFAULTS.scaleX,     kf2.scaleX     ?? DEFAULTS.scaleX,     ef),
    scaleY:     lerp(kf1.scaleY     ?? DEFAULTS.scaleY,     kf2.scaleY     ?? DEFAULTS.scaleY,     ef),
    translateX: lerp(kf1.translateX ?? DEFAULTS.translateX, kf2.translateX ?? DEFAULTS.translateX, ef),
    translateY: lerp(kf1.translateY ?? DEFAULTS.translateY, kf2.translateY ?? DEFAULTS.translateY, ef),
    alpha:      lerp(kf1.alpha      ?? DEFAULTS.alpha,      kf2.alpha      ?? DEFAULTS.alpha,      ef),
    frameId,
  };
}

/** Collapse a single BoneKeyframe to a ResolvedBoneTransform (no interpolation). */
function resolveOne(kf: BoneKeyframe): ResolvedBoneTransform {
  return {
    rotation:   kf.rotation   ?? DEFAULTS.rotation,
    scaleX:     kf.scaleX     ?? DEFAULTS.scaleX,
    scaleY:     kf.scaleY     ?? DEFAULTS.scaleY,
    translateX: kf.translateX ?? DEFAULTS.translateX,
    translateY: kf.translateY ?? DEFAULTS.translateY,
    alpha:      kf.alpha      ?? DEFAULTS.alpha,
    frameId:    kf.frameId    !== undefined ? kf.frameId : null,
  };
}

// ── Clip sampling ─────────────────────────────────────────────────────────────

/** Sample an AnimationClip at time t, returning every bone's resolved transform. */
export function sampleClip(
  clip: AnimationClip,
  t: number,
): Map<string, ResolvedBoneTransform> {
  const result = new Map<string, ResolvedBoneTransform>();
  const kfs = clip.keyframes;
  if (kfs.length === 0) return result;

  // Collect all bone ids that appear in any keyframe
  const boneIds = new Set<string>();
  for (const kf of kfs) kf.bones.forEach((_, id) => boneIds.add(id));

  for (const boneId of boneIds) {
    // Find surrounding keyframes for this bone
    let kf1Idx = -1;
    let kf2Idx = -1;

    for (let i = 0; i < kfs.length; i++) {
      if (kfs[i].bones.has(boneId) && kfs[i].time <= t) kf1Idx = i;
    }
    for (let i = 0; i < kfs.length; i++) {
      if (kfs[i].bones.has(boneId) && kfs[i].time > t) { kf2Idx = i; break; }
    }

    if (kf1Idx < 0 && kf2Idx < 0) continue;

    if (kf1Idx < 0) {
      // t is before the first keyframe for this bone
      result.set(boneId, resolveOne(kfs[kf2Idx].bones.get(boneId)!));
      continue;
    }
    if (kf2Idx < 0) {
      // t is at or past the last keyframe for this bone
      result.set(boneId, resolveOne(kfs[kf1Idx].bones.get(boneId)!));
      continue;
    }

    const kf1 = kfs[kf1Idx];
    const kf2 = kfs[kf2Idx];
    const span = kf2.time - kf1.time;
    const f = span > 0 ? (t - kf1.time) / span : 0;
    result.set(boneId, interpolateBone(kf1.bones.get(boneId)!, kf2.bones.get(boneId)!, f));
  }

  return result;
}
