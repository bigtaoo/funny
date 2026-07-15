// Regression guard for the SLG train-queue timer: it used to print raw seconds
// (e.g. "2488s left"), unreadable for anything past a minute. Pins the
// mm:ss / h:mm:ss formatting so it can't silently regress back to raw seconds.

import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/scenes/worldmap/formatDuration';

describe('formatDuration', () => {
  it('formats sub-minute durations as 0:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(59)).toBe('0:59');
  });

  it('formats sub-hour durations as m:ss / mm:ss', () => {
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(2488)).toBe('41:28');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats hour-plus durations as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7325)).toBe('2:02:05');
  });

  it('floors fractional seconds instead of rounding', () => {
    expect(formatDuration(2488.9)).toBe('41:28');
  });

  it('clamps negative input to zero instead of producing a negative string', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});
