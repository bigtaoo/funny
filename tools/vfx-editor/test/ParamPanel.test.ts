// ParamPanel.ts's pure param-track helpers (form detection, lossy const/two-point/keyframe
// conversion, keyframe sort). The panel class itself builds DOM (`document.createElement`) in
// its constructor/render and stays untested — see vitest.config.ts's scope note.
import { describe, it, expect } from 'vitest';
import { formOf, firstValue, lastValue, sortKfs } from '../src/ui/ParamPanel';
import type { ParamTrack, Keyframe } from '@vfx/types';

describe('formOf', () => {
  it('identifies a constant track', () => {
    expect(formOf(5)).toBe('const');
  });

  it('identifies a two-point (ramp) track', () => {
    expect(formOf({ from: 0, to: 1, ease: 'linear' })).toBe('ramp');
  });

  it('identifies a keyframe-array track', () => {
    const track: ParamTrack = [{ t: 0, v: 0 }, { t: 1, v: 1 }];
    expect(formOf(track)).toBe('keys');
  });

  it('identifies an empty keyframe array as "keys", not "ramp"', () => {
    expect(formOf([])).toBe('keys');
  });
});

describe('firstValue', () => {
  it('returns the number itself for a constant track', () => {
    expect(firstValue(7)).toBe(7);
  });

  it('returns "from" for a two-point track', () => {
    expect(firstValue({ from: 2, to: 9 })).toBe(2);
  });

  it('returns the first keyframe\'s value', () => {
    const track: Keyframe[] = [{ t: 0, v: 3 }, { t: 1, v: 8 }];
    expect(firstValue(track)).toBe(3);
  });

  it('returns 0 for an empty keyframe array (no first stop to read)', () => {
    expect(firstValue([])).toBe(0);
  });
});

describe('lastValue', () => {
  it('returns the number itself for a constant track', () => {
    expect(lastValue(7)).toBe(7);
  });

  it('returns "to" for a two-point track', () => {
    expect(lastValue({ from: 2, to: 9 })).toBe(9);
  });

  it('returns the last keyframe\'s value', () => {
    const track: Keyframe[] = [{ t: 0, v: 3 }, { t: 1, v: 8 }];
    expect(lastValue(track)).toBe(8);
  });

  it('returns 0 for an empty keyframe array (no last stop to read)', () => {
    expect(lastValue([])).toBe(0);
  });
});

describe('sortKfs', () => {
  it('sorts keyframes ascending by time', () => {
    const kfs: Keyframe[] = [{ t: 0.8, v: 1 }, { t: 0.1, v: 2 }, { t: 0.5, v: 3 }];
    expect(sortKfs(kfs).map((k) => k.t)).toEqual([0.1, 0.5, 0.8]);
  });

  it('does not mutate the input array', () => {
    const kfs: Keyframe[] = [{ t: 1, v: 1 }, { t: 0, v: 2 }];
    const original = [...kfs];
    sortKfs(kfs);
    expect(kfs).toEqual(original);
  });

  it('is stable / a no-op for an already-sorted list', () => {
    const kfs: Keyframe[] = [{ t: 0, v: 1 }, { t: 0.5, v: 2 }, { t: 1, v: 3 }];
    expect(sortKfs(kfs)).toEqual(kfs);
  });
});
