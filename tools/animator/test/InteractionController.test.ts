// InteractionController.ts's pure geometry/hit-test helpers — point-to-segment distance and
// nearest-bone-at-a-point (used to pick a bone on mousedown). Both were private class members
// with no actual dependency on controller/canvas/window state, so they're exported as free
// functions (behavior unchanged) rather than exercised through the class, whose constructor
// wires up real canvas/window listeners. `findBoneAt` is tested against the REAL rest-pose
// geometry from Skeleton.computeFK (itself pure, already used this way by computeDefaultShadowSize)
// rather than hand-rolled coordinates, so it doesn't hardcode bone-geometry constants that
// belong to Skeleton.ts.
import { describe, it, expect } from 'vitest';
import { pointToSegmentDist, findBoneAt, findSpriteAt, unwrapAngleStep } from '../src/interaction/InteractionController';
import { RotateBoneCommand, SetLengthScaleCommand, SetBindingPropCommand } from '../src/interaction/commands';
import { Skeleton } from '../src/skeleton/Skeleton';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import type { SpriteBinding } from '../src/core/types';

const DEG = Math.PI / 180;

describe('unwrapAngleStep', () => {
  it('returns the plain difference for a small step with no wrap', () => {
    expect(unwrapAngleStep(10 * DEG, 30 * DEG)).toBeCloseTo(20 * DEG, 10);
    expect(unwrapAngleStep(30 * DEG, 10 * DEG)).toBeCloseTo(-20 * DEG, 10);
  });

  it('unwraps a step that crosses the +180°/-180° seam forward', () => {
    // 170° -> -170° is a 20° step forward across the seam, not a 340° step back.
    expect(unwrapAngleStep(170 * DEG, -170 * DEG)).toBeCloseTo(20 * DEG, 10);
  });

  it('unwraps a step that crosses the seam backward', () => {
    expect(unwrapAngleStep(-170 * DEG, 170 * DEG)).toBeCloseTo(-20 * DEG, 10);
  });

  it('accumulates a continuous multi-turn drag without snapping back at the seam', () => {
    // Simulate a drag sweeping steadily counter-clockwise past 180° twice, sampled
    // every 10°, the way onMouseMove would. Regression for the atan2-wrap bug: the
    // old "current - drag-start" math would jump by a full turn right at each seam
    // crossing instead of keeping the sweep continuous.
    let prev = 0;
    let accumDeg = 0;
    for (let deg = 10; deg <= 720; deg += 10) {
      const wrapped = ((deg + 180) % 360) - 180; // simulate atan2's (-180°,180°] range
      accumDeg += unwrapAngleStep(prev * DEG, wrapped * DEG) / DEG;
      prev = wrapped;
    }
    expect(accumDeg).toBeCloseTo(720, 5);
  });
});

// RotateBoneCommand is where a drag's accumulated `dragAccumDeg` (see unwrapAngleStep
// above) actually gets written into a keyframe on mouseUp. It has zero PIXI/DOM
// dependency — same real-instance approach as editorProject.test.ts — so it's exercised
// directly rather than only implicitly through IO round-trip tests.
function makeAnimCtrl() {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  return { animCtrl, state };
}

describe('RotateBoneCommand', () => {
  it('does nothing when there is no current clip selected', () => {
    const { animCtrl } = makeAnimCtrl();
    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 90, 0, false);
    expect(() => cmd.execute()).not.toThrow();
    expect(animCtrl.currentClip).toBeNull();
  });

  it('creates a keyframe at the given time when none exists yet, holding only the rotated bone', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 45, 0, /* hadKeyframe */ false);
    cmd.execute();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0);
    expect(kf).toBeDefined();
    expect(kf!.bones.get('spine')?.rotation).toBe(45);
  });

  it('patches only the target bone on an existing keyframe, leaving sibling bones untouched', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0, new Map([
      ['spine', { rotation: 10 }],
      ['head',  { rotation: -5 }],
    ]));

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 10, 400, 0, /* hadKeyframe */ true);
    cmd.execute();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0)!;
    expect(kf.bones.get('spine')?.rotation).toBe(400);
    expect(kf.bones.get('head')?.rotation).toBe(-5);
  });

  it('round-trips a large, unbounded rotation unchanged — no wrap/clamp on write', () => {
    // Regression guard for the drag-angle fix: a multi-turn drag can legitimately
    // accumulate past 360°, and that raw value must survive storage untouched.
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 22, 758.7, 0, false);
    cmd.execute();

    expect(animCtrl.currentClip!.keyframes[0].bones.get('spine')?.rotation).toBe(758.7);
  });

  it('undo removes the keyframe it created when there was none before', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 0, 45, 0, /* hadKeyframe */ false);
    cmd.execute();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(1);

    cmd.undo();
    expect(animCtrl.currentClip!.keyframes).toHaveLength(0);
  });

  it('undo restores the previous rotation on a keyframe that already existed', () => {
    const { animCtrl } = makeAnimCtrl();
    animCtrl.createClip('idle');
    animCtrl.selectClip('idle');
    animCtrl.addKeyframeAt(0, new Map([['spine', { rotation: 10 }]]));

    const cmd = new RotateBoneCommand(animCtrl, 'spine', 10, 400, 0, /* hadKeyframe */ true);
    cmd.execute();
    cmd.undo();

    const kf = animCtrl.currentClip!.keyframes.find(k => k.time === 0)!;
    expect(kf.bones.get('spine')?.rotation).toBe(10);
  });
});

describe('pointToSegmentDist', () => {
  it('is 0 for a point exactly on the segment', () => {
    expect(pointToSegmentDist(5, 0, 0, 0, 10, 0)).toBe(0);
  });

  it('measures perpendicular distance to the segment interior', () => {
    expect(pointToSegmentDist(5, 3, 0, 0, 10, 0)).toBe(3);
  });

  it('clamps to the nearer endpoint when the point projects before the segment start', () => {
    expect(pointToSegmentDist(-4, 0, 0, 0, 10, 0)).toBe(4);
  });

  it('clamps to the nearer endpoint when the point projects past the segment end', () => {
    expect(pointToSegmentDist(14, 0, 0, 0, 10, 0)).toBe(4);
  });

  it('degenerates to point-to-point distance for a zero-length segment', () => {
    expect(pointToSegmentDist(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('findBoneAt', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());

  it('hits "head" when clicking exactly on the head joint', () => {
    const head = restPose.get('head')!;
    expect(findBoneAt(head.ex, head.ey, restPose)).toBe('head');
  });

  it('hits the spine when clicking its exact midpoint', () => {
    const spine = restPose.get('spine')!;
    const mx = (spine.sx + spine.ex) / 2;
    const my = (spine.sy + spine.ey) / 2;
    expect(findBoneAt(mx, my, restPose)).toBe('spine');
  });

  it('returns null far away from every bone', () => {
    expect(findBoneAt(100000, 100000, restPose)).toBeNull();
  });

  it('never returns "root" (excluded from SELECTABLE_BONES, zero-length anyway)', () => {
    const root = restPose.get('root')!;
    expect(findBoneAt(root.sx, root.sy, restPose)).not.toBe('root');
  });
});

// findSpriteAt: skin mode's "click the image directly" hit-test. Uses the real rest-pose
// geometry (same rationale as findBoneAt above) with hand-built bindings/textures.
describe('findSpriteAt', () => {
  const restPose = Skeleton.computeFK(0, 0, new Map());

  const binding = (zOrder: number): SpriteBinding => ({
    anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder, rotation: 0, scaleX: 1, scaleY: 1,
  });

  it('hits a bone whose sprite quad (centered anchor) covers its pivot point', () => {
    const spine = restPose.get('spine')!;
    const bindings = new Map([['spine', binding(0)]]);
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(spine.sx, spine.sy, restPose, bindings, getTexture)).toBe('spine');
  });

  it('returns null when the point is nowhere near any bound sprite', () => {
    const bindings = new Map([['spine', binding(0)]]);
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(100000, 100000, restPose, bindings, getTexture)).toBeNull();
  });

  it('skips a bone with a binding but no loaded texture', () => {
    const spine = restPose.get('spine')!;
    const bindings = new Map([['spine', binding(0)]]);
    expect(findSpriteAt(spine.sx, spine.sy, restPose, bindings, () => undefined)).toBeNull();
  });

  it('prefers the frontmost (highest zOrder) sprite when quads overlap at the same pivot', () => {
    const spine = restPose.get('spine')!;
    // Two bindings both centered on spine's own pivot (fabricated overlap — real
    // rigs never share a pivot, but the hit-test only cares about quad geometry).
    const bindings = new Map<string, SpriteBinding>([
      ['spine', binding(0)],
      ['head',  { ...binding(5), anchorX: 0.5, anchorY: 0.5 }],
    ]);
    // Force head's quad onto spine's pivot by using head's own pose is wrong for a
    // real overlap test — instead assert ordering directly via a same-pivot pair.
    const samePivot = new Map(restPose);
    samePivot.set('head', { ...spine });
    const getTexture = () => ({ width: 40, height: 100 });
    expect(findSpriteAt(spine.sx, spine.sy, samePivot, bindings, getTexture)).toBe('head');
  });
});

describe('SetLengthScaleCommand', () => {
  it('execute sets the new scale, undo restores the old one', () => {
    const bus   = new EventBus<AppEvents>();
    const state = new AppState(bus);
    state.setLengthScale('spine', 1.5);

    const cmd = new SetLengthScaleCommand(state, 'spine', 1.5, 2.0);
    cmd.execute();
    expect(state.getLengthScale('spine')).toBe(2.0);

    cmd.undo();
    expect(state.getLengthScale('spine')).toBe(1.5);
  });
});

describe('SetBindingPropCommand', () => {
  function makeBoundState() {
    const bus = new EventBus<AppEvents>();
    const state = new AppState(bus);
    state.setBinding('spine', {
      anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1,
    });
    return state;
  }

  it('execute/undo round-trip a single prop without touching the rest of the binding', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(state, 'spine', { rotation: 0 }, { rotation: 30 });
    cmd.execute();
    expect(state.getBinding('spine')?.rotation).toBe(30);
    expect(state.getBinding('spine')?.anchorX).toBe(0.5);   // untouched

    cmd.undo();
    expect(state.getBinding('spine')?.rotation).toBe(0);
  });

  it('round-trips a multi-prop change (anchorX + anchorY together)', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(
      state, 'spine',
      { anchorX: 0.5, anchorY: 0.5 },
      { anchorX: 0.8, anchorY: 0.2 },
    );
    cmd.execute();
    expect(state.getBinding('spine')?.anchorX).toBe(0.8);
    expect(state.getBinding('spine')?.anchorY).toBe(0.2);

    cmd.undo();
    expect(state.getBinding('spine')?.anchorX).toBe(0.5);
    expect(state.getBinding('spine')?.anchorY).toBe(0.5);
  });

  it('is a no-op when the binding has since been removed', () => {
    const state = makeBoundState();
    state.removeBinding('spine');
    const cmd = new SetBindingPropCommand(state, 'spine', { rotation: 0 }, { rotation: 30 });
    expect(() => cmd.execute()).not.toThrow();
    expect(state.getBinding('spine')).toBeUndefined();
  });

  it('defaults its label to the bone label when none is given', () => {
    const state = makeBoundState();
    const cmd = new SetBindingPropCommand(state, 'spine', {}, {});
    expect(cmd.label).toContain('Spine');
  });
});
