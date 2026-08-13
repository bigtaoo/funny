// TimelineView.ts's keyframe-colour classifier (REQUIREMENTS.md §2.6 legend: orange for
// translate, blue for scale, grey for rotation-only/empty; multiple colours when a keyframe
// touches more than one property group). The view class itself owns a canvas/DOM and stays
// untested — see vitest.config.ts's scope note.
import { describe, it, expect } from 'vitest';
import { getKfColors } from '../src/timeline/TimelineView';
import type { BoneKeyframe } from '../src/core/types';

describe('getKfColors', () => {
  it('returns grey for a completely empty keyframe', () => {
    expect(getKfColors({})).toEqual(['#89899a']);
  });

  it('returns grey for rotation-only changes (translate/scale untouched)', () => {
    const bkf: BoneKeyframe = { rotation: 45 };
    expect(getKfColors(bkf)).toEqual(['#89899a']);
  });

  it('returns orange for a nonzero translateX', () => {
    expect(getKfColors({ translateX: 5 })).toEqual(['#f9e2af']);
  });

  it('returns orange for a nonzero translateY', () => {
    expect(getKfColors({ translateY: -3 })).toEqual(['#f9e2af']);
  });

  it('treats translateX/Y of exactly 0 as "no translate" (falls through to grey)', () => {
    expect(getKfColors({ translateX: 0, translateY: 0 })).toEqual(['#89899a']);
  });

  it('returns blue for a scaleX != 1', () => {
    expect(getKfColors({ scaleX: 1.5 })).toEqual(['#89b4fa']);
  });

  it('returns blue for a scaleY != 1', () => {
    expect(getKfColors({ scaleY: 0.5 })).toEqual(['#89b4fa']);
  });

  it('treats scaleX/Y of exactly 1 as "no scale" (falls through to grey)', () => {
    expect(getKfColors({ scaleX: 1, scaleY: 1 })).toEqual(['#89899a']);
  });

  it('returns both colours, translate first, when translate and scale both changed', () => {
    const bkf: BoneKeyframe = { translateX: 5, scaleX: 1.5 };
    expect(getKfColors(bkf)).toEqual(['#f9e2af', '#89b4fa']);
  });

  it('order is always [translate, scale] regardless of which fields are set within each group', () => {
    const bkf: BoneKeyframe = { scaleY: 2, translateY: 10 };
    expect(getKfColors(bkf)).toEqual(['#f9e2af', '#89b4fa']);
  });
});
