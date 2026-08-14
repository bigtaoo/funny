// InteractionController.ts's pure geometry/hit-test helpers — point-to-segment distance and
// nearest-bone-at-a-point (used to pick a bone on mousedown). Both were private class members
// with no actual dependency on controller/canvas/window state, so they're exported as free
// functions (behavior unchanged) rather than exercised through the class, whose constructor
// wires up real canvas/window listeners. `findBoneAt` is tested against the REAL rest-pose
// geometry from Skeleton.computeFK (itself pure, already used this way by computeDefaultShadowSize)
// rather than hand-rolled coordinates, so it doesn't hardcode bone-geometry constants that
// belong to Skeleton.ts.
import { describe, it, expect } from 'vitest';
import { pointToSegmentDist, findBoneAt } from '../src/interaction/InteractionController';
import { Skeleton } from '../src/skeleton/Skeleton';

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
