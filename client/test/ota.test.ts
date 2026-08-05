// Regression coverage for platform/ota.ts's isNewer() — previously zero tests despite being pure,
// easily-testable logic that gates every OTA bundle rollout decision (both the manifest-vs-running
// comparison and the minNativeVersion gate reuse this same function).
import { describe, it, expect } from 'vitest';
import { isNewer } from '../src/platform/ota';

describe('isNewer', () => {
  it('returns true when a is strictly newer than b (major/minor/patch)', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('1.3.0', '1.2.9')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns false when a equals b', () => {
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when a is older than b', () => {
    expect(isNewer('1.2.3', '1.2.4')).toBe(false);
    expect(isNewer('1.2.3', '2.0.0')).toBe(false);
  });

  it('treats a missing trailing segment as 0 (different segment counts)', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false); // equal once the missing segment is treated as 0
    expect(isNewer('1.2.1', '1.2')).toBe(true);
    expect(isNewer('2', '1.9.9')).toBe(true);
  });

  it('treats a non-numeric segment as 0', () => {
    expect(isNewer('1.x.0', '1.0.1')).toBe(false); // 'x' → 0, so 1.0.0 vs 1.0.1
    expect(isNewer('1.x.5', '1.0.1')).toBe(true); // 1.0.5 vs 1.0.1
  });

  it('compares left-to-right and stops at the first differing segment', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(true); // major wins even though minor/patch are lower
    expect(isNewer('1.0.99', '1.1.0')).toBe(false); // minor wins even though patch is higher
  });
});
