// Skeleton (src/skeleton/Skeleton.ts) — the 11-bone rig definition and its two derived measures.
// ADR-070 Phase 4d: `computeFK` was already exercised indirectly (InteractionController.test.ts
// uses real rest-pose geometry, taoExport goes through computeNaturalHeight), but
// `computeDefaultShadowSize` had no coverage at all.
//
// Deliberately derives expectations from BONE_MAP / computeFK rather than hardcoding pixel
// numbers: the point of both helpers is that they stay consistent with the rig, and a test that
// restates the literals would have to be edited in lockstep with every rig tweak while never
// catching a real inconsistency. Where a literal IS pinned it is a documented contract (the
// 4px shadow floor, the 0.3 aspect ratio, `0` meaning "unknown height").
import { describe, it, expect } from 'vitest';
import { Skeleton } from '../src/skeleton/Skeleton';
import type { AnimationClip, ResolvedBoneTransform } from '../src/core/types';

const BONE_IDS = [
  'root', 'spine', 'head',
  'r_upper_arm', 'r_lower_arm', 'l_upper_arm', 'l_lower_arm',
  'r_upper_leg', 'r_lower_leg', 'l_upper_leg', 'l_lower_leg',
];

function clip(keyframes: Array<Record<string, number>>): AnimationClip {
  return {
    duration: 1,
    loop: true,
    keyframes: keyframes.map((rotations, i) => ({
      time: i * 0.25,
      bones: new Map(Object.entries(rotations).map(([id, rotation]) => [id, { rotation }])),
    })),
  };
}

describe('rig definition', () => {
  it('defines the documented 11 bones, with root unselectable and off the timeline', () => {
    expect([...Skeleton.BONE_MAP.keys()]).toEqual(BONE_IDS);
    expect(Skeleton.BONE_DEFS.map((b) => b.id)).toEqual(BONE_IDS);
    expect(Skeleton.SELECTABLE_BONES).not.toContain('root');
    expect(Skeleton.SELECTABLE_BONES).toHaveLength(10);
    expect(Skeleton.TIMELINE_BONES).not.toContain('root');
  });

  it('DRAW_ORDER covers every drawable bone exactly once', () => {
    const drawable = BONE_IDS.filter((id) => id !== 'root');
    expect([...Skeleton.DRAW_ORDER].sort()).toEqual([...drawable].sort());
  });

  // `rla` is the rest angle RELATIVE to the parent, derived at module init from the absolute
  // rest-pose angles the definitions are written in. Pin the derivation itself rather than the
  // 11 resulting numbers.
  it('derives each bone\'s parent-relative rest angle from the absolute ones', () => {
    for (const bone of Skeleton.BONE_DEFS) {
      const parentRwa = bone.parent ? Skeleton.BONE_MAP.get(bone.parent)!.rwa : 0;
      expect(bone.rla, `${bone.id}.rla`).toBe(bone.rwa - parentRwa);
    }
  });
});

describe('computeFK', () => {
  it('places root at the given origin with zero length', () => {
    const pose = Skeleton.computeFK(100, 250, new Map());
    expect(pose.get('root')).toEqual({ sx: 100, sy: 250, ex: 100, ey: 250, wa: 0 });
  });

  it('every bone starts where its parent ends', () => {
    const pose = Skeleton.computeFK(0, 0, new Map());
    for (const bone of Skeleton.BONE_DEFS) {
      if (!bone.parent) continue;
      const parent = pose.get(bone.parent)!;
      const self = pose.get(bone.id)!;
      expect([self.sx, self.sy], `${bone.id} start`).toEqual([parent.ex, parent.ey]);
    }
  });

  it('rest pose reproduces each bone\'s absolute rest angle', () => {
    const pose = Skeleton.computeFK(0, 0, new Map());
    for (const bone of Skeleton.BONE_DEFS) {
      expect(pose.get(bone.id)!.wa, `${bone.id}.wa`).toBeCloseTo(bone.rwa, 6);
    }
  });

  it('a rotation on a parent propagates down the chain', () => {
    const tf = new Map<string, ResolvedBoneTransform>([
      ['spine', { rotation: 30, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1 }],
    ]);
    const pose = Skeleton.computeFK(0, 0, tf);

    expect(pose.get('spine')!.wa).toBeCloseTo(Skeleton.BONE_MAP.get('spine')!.rwa + 30, 6);
    // head hangs off spine, so it inherits the same +30 even with no transform of its own
    expect(pose.get('head')!.wa).toBeCloseTo(Skeleton.BONE_MAP.get('head')!.rwa + 30, 6);
    // an arm off the root chain via spine gets it too
    expect(pose.get('r_upper_arm')!.wa).toBeCloseTo(Skeleton.BONE_MAP.get('r_upper_arm')!.rwa + 30, 6);
    // legs hang off root, untouched
    expect(pose.get('r_upper_leg')!.wa).toBeCloseTo(Skeleton.BONE_MAP.get('r_upper_leg')!.rwa, 6);
  });

  it('lengthScales scale a bone\'s length without moving its start or angle', () => {
    const rest = Skeleton.computeFK(0, 0, new Map());
    const scaled = Skeleton.computeFK(0, 0, new Map(), new Map([['spine', 2]]));
    const spine = Skeleton.BONE_MAP.get('spine')!;

    const restLen = Math.hypot(rest.get('spine')!.ex - rest.get('spine')!.sx, rest.get('spine')!.ey - rest.get('spine')!.sy);
    const scaledLen = Math.hypot(scaled.get('spine')!.ex - scaled.get('spine')!.sx, scaled.get('spine')!.ey - scaled.get('spine')!.sy);

    expect(restLen).toBeCloseTo(spine.len, 6);
    expect(scaledLen).toBeCloseTo(spine.len * 2, 6);
    expect(scaled.get('spine')!.wa).toBe(rest.get('spine')!.wa);
    // and a longer spine carries the head further out
    expect(scaled.get('head')!.sy).toBeCloseTo(scaled.get('spine')!.ey, 6);
  });

  it('bones with no scale entry keep their defined length', () => {
    const pose = Skeleton.computeFK(0, 0, new Map(), new Map([['spine', 3]]));
    const arm = Skeleton.BONE_MAP.get('l_upper_arm')!;
    const p = pose.get('l_upper_arm')!;

    expect(Math.hypot(p.ex - p.sx, p.ey - p.sy)).toBeCloseTo(arm.len, 6);
  });

  it('the character faces right: anatomical right is screen left', () => {
    const pose = Skeleton.computeFK(0, 0, new Map());
    // REQUIREMENTS' rest-pose convention, stated in this file's own header comment.
    expect(pose.get('r_upper_arm')!.ex).toBeLessThan(0);
    expect(pose.get('l_upper_arm')!.ex).toBeGreaterThan(0);
    expect(pose.get('head')!.ey).toBeLessThan(0);          // screen y grows downward
  });
});

describe('computeDefaultShadowSize', () => {
  it('derives half-width from the rest-pose foot span plus one leg width', () => {
    const rest = Skeleton.computeFK(0, 0, new Map());
    const span = Math.abs(rest.get('r_lower_leg')!.ex - rest.get('l_lower_leg')!.ex);
    const legOuterW = Skeleton.BONE_MAP.get('r_lower_leg')!.outerW!;

    expect(Skeleton.computeDefaultShadowSize().w).toBe(Math.ceil(span / 2 + legOuterW));
  });

  // The 0.3 ratio is what is actually testable here. The `Math.max(4, …)` floor around it is NOT:
  // the fixed 11-bone rig gives w ≈ 54, so `ceil(w * 0.3)` is ~16 and the floor never engages —
  // deleting it leaves every assertion in this file green (verified). Restating the whole
  // expression, floor included, would have looked like coverage of the floor while pinning
  // nothing, so it is stated as unreachable-for-this-rig instead. Same category as map-editor's
  // `clampPan` branches: the gate reads line coverage, and this line IS covered; what is absent is
  // an input that can distinguish the two versions, and the fixed rig cannot supply one.
  it('keeps the documented 0.3 aspect ratio (the 4px floor is unreachable for this rig)', () => {
    const { w, h } = Skeleton.computeDefaultShadowSize();

    expect(h).toBe(Math.ceil(w * 0.3));
    expect(Math.ceil(w * 0.3)).toBeGreaterThan(4);   // …which is why the floor never fires
  });

  it('is deterministic — it reads the rest pose, not any live editor state', () => {
    expect(Skeleton.computeDefaultShadowSize()).toEqual(Skeleton.computeDefaultShadowSize());
  });

  it('returns whole pixels, since it feeds an ellipse the renderer draws', () => {
    const { w, h } = Skeleton.computeDefaultShadowSize();
    expect(Number.isInteger(w)).toBe(true);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('computeNaturalHeight', () => {
  // Both copies of this method (here and client/src/render/stickman/skeleton.ts, which its own
  // comment asks to keep in sync) documented "returns 0 when there are no clips". They do not:
  // `scan(new Map())` runs unconditionally, so an empty clip list measures the rest pose. The
  // `: 0` fallback needs a rig with no vertical extent, which the fixed 11-bone definition cannot
  // produce. Writing this test is what surfaced it; both comments were corrected rather than the
  // code, since every caller wants the rest-pose height for a clipless rig — and pinning the
  // ACTUAL behaviour here is what keeps the corrected comment honest.
  it('measures the rest pose for an empty clip list — it does NOT return 0', () => {
    const rest = Skeleton.computeFK(0, 0, new Map());
    const ys = [...rest.values()].flatMap((p) => [p.sy, p.ey]);
    const expected = Math.max(...ys) - Math.min(...ys);

    expect(expected).toBeGreaterThan(0);
    expect(Skeleton.computeNaturalHeight([])).toBeCloseTo(expected, 6);
  });

  it('measures the rest pose when the only clip has no keyframes', () => {
    const rest = Skeleton.computeFK(0, 0, new Map());
    const ys = [...rest.values()].flatMap((p) => [p.sy, p.ey]);
    const expected = Math.max(...ys) - Math.min(...ys);

    expect(Skeleton.computeNaturalHeight([{ duration: 1, loop: true, keyframes: [] }])).toBeCloseTo(expected, 6);
  });

  it('is a union over the rest pose AND every keyframe, so a reach never shrinks it', () => {
    const restOnly = Skeleton.computeNaturalHeight([{ duration: 1, loop: true, keyframes: [] }]);

    // A crouch that keeps the figure entirely inside the rest-pose extent must not lower H_nat.
    const crouch = Skeleton.computeNaturalHeight([clip([{ r_upper_leg: 40, l_upper_leg: -40 }])]);
    expect(crouch).toBeGreaterThanOrEqual(restOnly - 1e-9);

    // A big upward stretch of the arms must raise it.
    const reach = Skeleton.computeNaturalHeight([clip([{ r_upper_arm: -90, l_upper_arm: -90 }])]);
    expect(reach).toBeGreaterThan(restOnly);
  });

  it('unions across multiple clips and multiple keyframes, not just the first', () => {
    const reach = clip([{ r_upper_arm: -90 }]);
    const rest = clip([{}]);

    const one = Skeleton.computeNaturalHeight([reach]);
    expect(Skeleton.computeNaturalHeight([rest, reach])).toBeCloseTo(one, 6);
    expect(Skeleton.computeNaturalHeight([{ ...rest, keyframes: [...rest.keyframes, ...reach.keyframes] }])).toBeCloseTo(one, 6);
  });

  it('treats a keyframe bone with no rotation field as rotation 0, not NaN', () => {
    const sparse: AnimationClip = {
      duration: 1, loop: true,
      keyframes: [{ time: 0, bones: new Map([['spine', { scaleX: 2 }]]) }],
    };

    const h = Skeleton.computeNaturalHeight([sparse]);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeCloseTo(Skeleton.computeNaturalHeight([{ duration: 1, loop: true, keyframes: [] }]), 6);
  });

  it('applies lengthScales, so a longer rig is a taller rig', () => {
    const normal = Skeleton.computeNaturalHeight([{ duration: 1, loop: true, keyframes: [] }]);
    const tall = Skeleton.computeNaturalHeight(
      [{ duration: 1, loop: true, keyframes: [] }],
      new Map([['spine', 2]]),
    );

    expect(tall).toBeGreaterThan(normal);
  });
});
