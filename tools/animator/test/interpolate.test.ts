// Pure interpolation functions (src/animation/interpolate.ts) — no DOM/PIXI, shared with the
// game-side runtime per the file's own header comment. Covers easing curves, single-bone lerp
// with identity-default fallback, and sampleClip's two-pass "nearest keyframe at/after t per
// bone" search (bones may appear in only a subset of keyframes — a legit sparse-delta rig format).
import { describe, it, expect } from 'vitest';
import type { AnimationClip, BoneKeyframe, Keyframe } from '../src/core/types';
import { applyEasing, interpolateBone, sampleClip } from '../src/animation/interpolate';

function kf(time: number, bones: Record<string, BoneKeyframe>): Keyframe {
  return { time, bones: new Map(Object.entries(bones)) };
}

describe('applyEasing', () => {
  it('linear (default, and explicit) passes t through unchanged', () => {
    expect(applyEasing(0.3)).toBeCloseTo(0.3);
    expect(applyEasing(0.3, 'linear')).toBeCloseTo(0.3);
  });
  it('ease-in is t*t (slow start)', () => {
    expect(applyEasing(0.5, 'ease-in')).toBeCloseTo(0.25);
  });
  it('ease-out is t*(2-t) (slow finish)', () => {
    expect(applyEasing(0.5, 'ease-out')).toBeCloseTo(0.75);
  });
  it('ease-in-out is symmetric around t=0.5, using the first-half formula below it and the second-half above', () => {
    expect(applyEasing(0.25, 'ease-in-out')).toBeCloseTo(2 * 0.25 * 0.25); // first half: 2t²
    expect(applyEasing(0.5, 'ease-in-out')).toBeCloseTo(0.5);
    expect(applyEasing(0.75, 'ease-in-out')).toBeCloseTo(1 - 2 * (1 - 0.75) * (1 - 0.75)); // second half mirror
  });
  it('step holds at 0 until t reaches exactly 1, then snaps to 1', () => {
    expect(applyEasing(0, 'step')).toBe(0);
    expect(applyEasing(0.999, 'step')).toBe(0);
    expect(applyEasing(1, 'step')).toBe(1);
  });
  it('every curve agrees at the endpoints t=0 and t=1', () => {
    for (const type of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(applyEasing(0, type)).toBeCloseTo(0);
      expect(applyEasing(1, type)).toBeCloseTo(1);
    }
  });
});

describe('interpolateBone', () => {
  it('lerps every field linearly by default', () => {
    const a: BoneKeyframe = { rotation: 0, scaleX: 1, translateX: 0, alpha: 1 };
    const b: BoneKeyframe = { rotation: 90, scaleX: 2, translateX: 10, alpha: 0 };
    expect(interpolateBone(a, b, 0.5)).toEqual({
      rotation: 45, scaleX: 1.5, scaleY: 1, translateX: 5, translateY: 0, alpha: 0.5,
    });
  });

  it('missing fields on either keyframe fall back to identity defaults (rotation/translate=0, scale/alpha=1)', () => {
    const result = interpolateBone({}, {}, 0.5);
    expect(result).toEqual({ rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
  });

  it('uses kf1.easing to warp the interpolation fraction (not kf2.easing)', () => {
    const a: BoneKeyframe = { rotation: 0, easing: 'ease-in' };
    const b: BoneKeyframe = { rotation: 100, easing: 'linear' }; // must be ignored
    expect(interpolateBone(a, b, 0.5).rotation).toBeCloseTo(25); // ease-in(0.5) = 0.25 → 0 + 100*0.25
  });

  it('f=0 returns kf1\'s resolved values exactly; f=1 returns kf2\'s', () => {
    const a: BoneKeyframe = { rotation: 5, alpha: 0.4 };
    const b: BoneKeyframe = { rotation: 15, alpha: 0.9 };
    expect(interpolateBone(a, b, 0)).toEqual({ rotation: 5, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 0.4 });
    expect(interpolateBone(a, b, 1)).toEqual({ rotation: 15, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 0.9 });
  });
});

describe('sampleClip', () => {
  it('returns an empty map for a clip with no keyframes', () => {
    const clip: AnimationClip = { duration: 1, loop: false, keyframes: [] };
    expect(sampleClip(clip, 0.5).size).toBe(0);
  });

  it('before the first keyframe touching a bone, holds that bone at its first-appearance value (no kf1 side)', () => {
    const clip: AnimationClip = { duration: 1, loop: false, keyframes: [kf(0.5, { spine: { rotation: 10 } })] };
    expect(sampleClip(clip, 0).get('spine')).toEqual({ rotation: 10, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
  });

  it('after the last keyframe touching a bone, holds that bone at its last value (no kf2 side)', () => {
    const clip: AnimationClip = { duration: 1, loop: false, keyframes: [kf(0.5, { spine: { rotation: 10 } })] };
    expect(sampleClip(clip, 5).get('spine')).toEqual({ rotation: 10, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
  });

  it('interpolates between the nearest surrounding keyframes for a bone', () => {
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [kf(0, { spine: { rotation: 0 } }), kf(1, { spine: { rotation: 100 } })],
    };
    expect(sampleClip(clip, 0.25).get('spine')!.rotation).toBeCloseTo(25);
  });

  it('sampling exactly at a keyframe\'s time yields that keyframe\'s own value (f=0 against the next one)', () => {
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [kf(0, { spine: { rotation: 0 } }), kf(0.5, { spine: { rotation: 50 } }), kf(1, { spine: { rotation: 100 } })],
    };
    expect(sampleClip(clip, 0.5).get('spine')!.rotation).toBe(50);
  });

  it('a bone present in only some keyframes is resolved independently of bones only present elsewhere', () => {
    // spine only appears at t=0; arm only appears at t=1. Sampling mid-way must not blend them together.
    const clip: AnimationClip = {
      duration: 1,
      loop: false,
      keyframes: [kf(0, { spine: { rotation: 20 } }), kf(1, { arm: { rotation: 40 } })],
    };
    const result = sampleClip(clip, 0.5);
    expect(result.get('spine')).toEqual({ rotation: 20, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
    expect(result.get('arm')).toEqual({ rotation: 40, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 });
  });

  it('per-bone "nearest keyframe at/after t" picks the closest one even when a farther keyframe also mentions that bone', () => {
    const clip: AnimationClip = {
      duration: 2,
      loop: false,
      keyframes: [
        kf(0, { spine: { rotation: 0 } }),
        kf(1, { spine: { rotation: 10 } }), // nearest-after for t=0.5
        kf(2, { spine: { rotation: 999 } }), // farther after — must NOT be picked as kf2
      ],
    };
    expect(sampleClip(clip, 0.5).get('spine')!.rotation).toBeCloseTo(5); // interpolated toward 10, not 999
  });

  it('per-bone "last keyframe at/before t" picks the closest preceding one even when an earlier keyframe also mentions that bone', () => {
    const clip: AnimationClip = {
      duration: 2,
      loop: false,
      keyframes: [
        kf(0, { spine: { rotation: -999 } }), // farther before — must NOT be picked as kf1
        kf(1, { spine: { rotation: 10 } }), // nearest-before for t=1.5
        kf(2, { spine: { rotation: 20 } }),
      ],
    };
    expect(sampleClip(clip, 1.5).get('spine')!.rotation).toBeCloseTo(15);
  });
});
