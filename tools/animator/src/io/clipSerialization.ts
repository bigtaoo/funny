// IOController's clip<->JSON conversion, extracted as form① free functions (claudedocs/
// client-modules.md "单文件 500 行收敛") — pure functions of their arguments, no IOController
// instance state involved at all.
import type { AnimationClip, BoneKeyframe, Keyframe } from '../core/types';

export interface SerializedBoneKeyframe {
  rotation?:   number;
  scaleX?:     number;
  scaleY?:     number;
  translateX?: number;
  translateY?: number;
  alpha?:      number;
  easing?:     string;
}

export interface SerializedKeyframe {
  time:  number;
  bones: Record<string, SerializedBoneKeyframe>;
}

export interface SerializedClip {
  duration:  number;
  loop:      boolean;
  keyframes: SerializedKeyframe[];
}

export function serializeClip(clip: AnimationClip): SerializedClip {
  return {
    duration:  clip.duration,
    loop:      clip.loop,
    keyframes: clip.keyframes.map(kf => serializeKeyframe(kf)),
  };
}

export function serializeKeyframe(kf: Keyframe): SerializedKeyframe {
  const bones: Record<string, SerializedBoneKeyframe> = {};
  kf.bones.forEach((bkf, id) => { bones[id] = { ...bkf }; });
  return { time: kf.time, bones };
}

export function deserializeClip(s: SerializedClip): AnimationClip {
  return {
    duration:  s.duration,
    loop:      s.loop,
    keyframes: s.keyframes.map(kf => deserializeKeyframe(kf)),
  };
}

export function deserializeKeyframe(s: SerializedKeyframe): Keyframe {
  const bones = new Map<string, BoneKeyframe>();
  for (const [id, bkf] of Object.entries(s.bones)) {
    bones.set(id, bkf as BoneKeyframe);
  }
  return { time: s.time, bones };
}
