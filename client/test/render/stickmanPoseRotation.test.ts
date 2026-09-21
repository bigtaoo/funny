/**
 * stickmanPoseRotation.test.ts — regression guard for the double-counted keyframe rotation
 * (2026-09-21): `applyPose` used to compute a bone sprite's rotation as
 * `bone_wa + kf.rotation + binding.rotation`, but `Skeleton.computeFK` has already folded
 * `kf.rotation` into `bone_wa`. Every authored delta therefore reached the SPRITE at twice its
 * value while the bone chain underneath kept the authored one, so the art slid off its own
 * skeleton in proportion to how far the clip rotated that bone — invisible enough at the ±30°
 * of the humanoid clips, catastrophic at the runner's +93° spine (a quadruped's body drawn
 * bolt upright with the head detached beside it).
 *
 * The invariant these tests pin is the one that makes the animator's preview and the game agree:
 *   sprite.rotation - binding.rotation === the bone's FK world angle
 * i.e. the keyframe delta is counted exactly once, inside the world angle.
 *
 * Run with: npm test.
 */

import { describe, it, expect, vi } from 'vitest';

// Minimal PIXI stub — applyPose only ever reads/writes plain sprite fields here (no 'shadow'
// sprite in these fixtures, so getShadowTexture is never called).
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    destroy(): void { /* no-op */ }
    position = { x: 0, y: 0, set(): void {} };
    scale     = { x: 1, y: 1, set(): void {} };
    visible   = true;
    alpha     = 1;
    rotation  = 0;
  }
  return {
    Container: FakeContainer,
    Sprite:    class extends FakeContainer { anchor = { set(): void {} }; texture: unknown = null; },
    Graphics:  class extends FakeContainer { clear(): this { return this; } },
    Texture:   class { static from(): unknown { return {}; } },
    Rectangle: class {},
    BaseTexture: class {},
    Ticker: class { static shared = { add(): void {}, remove(): void {} }; },
    settings: { ADAPTER: {} },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
  };
});

import * as PIXI from 'pixi.js-legacy';
import { applyPose, type PoseHost } from '../../src/render/stickman/pose';
import { Skeleton } from '../../src/render/stickman/skeleton';
import type { TaoAsset } from '../../src/render/stickman/runtimeTypes';
import type { AnimationClip, SpriteBinding } from '../../src/render/stickman/types';

const DEG = Math.PI / 180;

function binding(rotation: number): SpriteBinding {
  return { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation, scaleX: 1, scaleY: 1 };
}

function makeSprite(): PIXI.Sprite {
  return new PIXI.Sprite() as unknown as PIXI.Sprite;
}

/** One keyframe holding the given per-bone rotation deltas, as a non-looping clip. */
function clipWith(bones: Record<string, number>): AnimationClip {
  return {
    duration: 1,
    loop: false,
    keyframes: [{ time: 0, bones: new Map(Object.entries(bones).map(([id, r]) => [id, { rotation: r }])) }],
  };
}

function host(bones: Record<string, number>, bindings: Record<string, number>): {
  h: PoseHost; sprites: Map<string, PIXI.Sprite>;
} {
  const sprites = new Map<string, PIXI.Sprite>();
  for (const id of Object.keys(bindings)) sprites.set(id, makeSprite());
  const asset = {
    clips:            new Map<string, AnimationClip>(),
    textures:         new Map(),
    bindings:         new Map(Object.entries(bindings).map(([id, r]) => [id, binding(r)])),
    boneLengthScales: new Map<string, number>(),
    attachmentPoints: new Map(),
    outlineTextures:  new Map(),
    outlineAnchors:   new Map(),
    naturalHeight:    100,
  } as unknown as TaoAsset;
  return {
    sprites,
    h: {
      asset,
      sprites,
      outlineSprites:  new Map(),
      outlineFlashing: false,
      gearSprites:     [],
      currentClip:     clipWith(bones),
      time:            0,
    },
  };
}

/** The bone's world angle straight from FK, for the same keyframe. */
function worldAngle(boneId: string, bones: Record<string, number>): number {
  const transforms = new Map(Object.entries(bones).map(([id, rotation]) => [id, {
    rotation, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, alpha: 1,
  }]));
  return Skeleton.computeFK(0, 0, transforms).get(boneId)!.wa;
}

describe('applyPose — the keyframe rotation is counted exactly once', () => {
  it('a bone sprite sits at its own FK world angle plus the static binding offset', () => {
    // The runner's quadruped baseline: spine rotated +93° off its -90° rest, so the body lies flat.
    const bones = { spine: 93 };
    const { h, sprites } = host(bones, { spine: -2 });
    applyPose(h);

    const wa = worldAngle('spine', bones);
    expect(wa).toBeCloseTo(3, 10);                                    // -90 rest + 93 delta
    expect(sprites.get('spine')!.rotation).toBeCloseTo((wa - 2) * DEG, 10);
    // The bug drew it at wa + 93 - 2 = 94° — the body standing upright instead of lying flat.
    expect(sprites.get('spine')!.rotation).not.toBeCloseTo((wa + 93 - 2) * DEG, 4);
  });

  it('holds for a child bone, whose world angle already carries its parent\'s delta too', () => {
    const bones = { spine: 93, r_upper_arm: -140, l_upper_leg: 28 };
    const bindings: Record<string, number> = { spine: -2, r_upper_arm: 287, l_upper_leg: -78 };
    const { h, sprites } = host(bones, bindings);
    applyPose(h);

    for (const [id, rot] of Object.entries(bindings)) {
      expect(sprites.get(id)!.rotation).toBeCloseTo((worldAngle(id, bones) + rot) * DEG, 10);
    }
  });

  it('leaves an unkeyed bone at its rest angle plus the binding offset', () => {
    const { h, sprites } = host({}, { l_upper_arm: 10 });
    applyPose(h);
    // l_upper_arm's rest world angle is 0° (RAW_DEFS), so only the binding offset is left.
    expect(sprites.get('l_upper_arm')!.rotation).toBeCloseTo(10 * DEG, 10);
  });
});
