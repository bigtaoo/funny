// L1 spot-check trigger pure function (PVE_INTEGRITY §8.6 step 3): always triggers on first clear or blueprint mismatch; otherwise triggers randomly at a configured sample rate.
import { describe, it, expect } from 'vitest';
import { shouldSpotCheck, PVE_VERIFY_SAMPLE_RATE } from '@nw/shared';

describe('shouldSpotCheck', () => {
  it('first clear always triggers (ignores random)', () => {
    expect(shouldSpotCheck({ isFirstClear: true, blueprintMismatch: false, rand: 0.99 })).toBe(true);
  });

  it('blueprint mismatch always triggers (opening power discrepancy → mandatory check)', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: true, rand: 0.99 })).toBe(true);
  });

  it('repeated clear: triggers only when random < sample rate', () => {
    const base = { isFirstClear: false, blueprintMismatch: false };
    expect(shouldSpotCheck({ ...base, rand: PVE_VERIFY_SAMPLE_RATE - 0.001 })).toBe(true);
    expect(shouldSpotCheck({ ...base, rand: PVE_VERIFY_SAMPLE_RATE + 0.001 })).toBe(false);
  });

  it('custom sample rate overrides the default', () => {
    const base = { isFirstClear: false, blueprintMismatch: false };
    expect(shouldSpotCheck({ ...base, rand: 0.5, sampleRate: 1 })).toBe(true);
    expect(shouldSpotCheck({ ...base, rand: 0.5, sampleRate: 0 })).toBe(false);
  });
});
