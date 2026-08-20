// InteractionController.ts's pure geometry/hit-test helpers — point-to-segment distance and
// nearest-bone-at-a-point (used to pick a bone on mousedown). Both were private class members
// with no actual dependency on controller/canvas/window state, so they're exported as free
// functions (behavior unchanged) rather than exercised through the class, whose constructor
// wires up real canvas/window listeners. `findBoneAt` is tested against the REAL rest-pose
// geometry from Skeleton.computeFK (itself pure, already used this way by computeDefaultShadowSize)
// rather than hand-rolled coordinates, so it doesn't hardcode bone-geometry constants that
// belong to Skeleton.ts.
import { describe, it, expect } from 'vitest';
import { pointToSegmentDist, findBoneAt, unwrapAngleStep, RotateBoneCommand } from '../src/interaction/InteractionController';
import { Skeleton } from '../src/skeleton/Skeleton';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';

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
