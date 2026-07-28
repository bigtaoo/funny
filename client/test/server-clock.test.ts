// serverClock unit tests (P1-1, comm-audit-2026-07-27). Uses vi.useFakeTimers so Date.now() is
// deterministic — sampleServerNow()'s offset math must hold across arbitrary fake-clock values.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sampleServerNow, serverNow, hasServerClockSample, resetServerClock } from '../src/net/serverClock';

describe('serverClock', () => {
  beforeEach(() => {
    resetServerClock();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('before any sample, serverNow() falls back to the raw local clock', () => {
    vi.setSystemTime(1_700_000_000_000);
    expect(hasServerClockSample()).toBe(false);
    expect(serverNow()).toBe(1_700_000_000_000);
  });

  it('a sample where server is ahead of local shifts serverNow() forward', () => {
    vi.setSystemTime(1_700_000_000_000);
    sampleServerNow(1_700_000_005_000); // server is 5s ahead
    expect(hasServerClockSample()).toBe(true);
    expect(serverNow()).toBe(1_700_000_005_000);

    vi.setSystemTime(1_700_000_010_000); // 10s of local wall-clock time passes
    expect(serverNow()).toBe(1_700_000_015_000); // offset (+5s) still applied
  });

  it('a sample where server is behind local shifts serverNow() backward', () => {
    vi.setSystemTime(1_700_000_000_000);
    sampleServerNow(1_699_999_997_000); // server is 3s behind
    expect(serverNow()).toBe(1_699_999_997_000);

    vi.setSystemTime(1_700_000_020_000);
    expect(serverNow()).toBe(1_700_000_017_000); // offset (-3s) still applied
  });

  it('a later sample replaces the earlier offset (re-calibration)', () => {
    vi.setSystemTime(1_700_000_000_000);
    sampleServerNow(1_700_000_005_000); // +5s
    sampleServerNow(1_700_000_002_000); // re-sample at the same local instant: now +2s
    expect(serverNow()).toBe(1_700_000_002_000);
  });
});
