// Regression guard for the SLG train-queue timer: it used to print raw seconds
// (e.g. "2488s left"), unreadable for anything past a minute. Pins the
// mm:ss / h:mm:ss formatting so it can't silently regress back to raw seconds.

import { describe, it, expect } from 'vitest';
import { formatDuration, dhmsFromMs } from '../src/scenes/worldmap/logic/formatDuration';

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

// `dhmsFromMs` was the uncovered half of this module (58.8% -> the lines below) until ADR-071 4b brought
// worldmap's pure layer into the gate. It is the breakdown the `{d}{h}{m}{s}` i18n templates consume for
// buffs that run for days — a shield or a training speed-up — where formatDuration's mm:ss would print
// "146282s"-grade gibberish.
describe('dhmsFromMs', () => {
  it('splits into non-overlapping day/hour/minute/second parts', () => {
    expect(dhmsFromMs(0)).toEqual({ d: 0, h: 0, m: 0, s: 0 });
    expect(dhmsFromMs(1_000)).toEqual({ d: 0, h: 0, m: 0, s: 1 });
    expect(dhmsFromMs(61_000)).toEqual({ d: 0, h: 0, m: 1, s: 1 });
    expect(dhmsFromMs(3_661_000)).toEqual({ d: 0, h: 1, m: 1, s: 1 });
    expect(dhmsFromMs(90_061_000)).toEqual({ d: 1, h: 1, m: 1, s: 1 });
  });

  it('recomposes exactly — no seconds are lost or double-counted', () => {
    // The property that makes the four parts safe to interpolate into a template independently.
    for (const ms of [0, 999, 1_000, 59_999, 86_399_999, 146_282_000, 7 * 86_400_000 + 12_345_678]) {
      const { d, h, m, s } = dhmsFromMs(ms);
      expect(d * 86_400 + h * 3_600 + m * 60 + s, `${ms}ms`).toBe(Math.floor(ms / 1000));
      expect(h, `${ms}ms hours`).toBeLessThan(24);
      expect(m, `${ms}ms minutes`).toBeLessThan(60);
      expect(s, `${ms}ms seconds`).toBeLessThan(60);
    }
  });

  it('floors sub-second remainders and clamps negatives to zero', () => {
    // A countdown crossing zero between the tick and the render is the normal case, not an edge case:
    // a negative here would render as "-1天-3时".
    expect(dhmsFromMs(1_999)).toEqual({ d: 0, h: 0, m: 0, s: 1 });
    expect(dhmsFromMs(-5_000)).toEqual({ d: 0, h: 0, m: 0, s: 0 });
    expect(dhmsFromMs(-1)).toEqual({ d: 0, h: 0, m: 0, s: 0 });
  });

  it('has no day cap — the buffs it formats can outrun a week', () => {
    expect(dhmsFromMs(30 * 86_400_000).d).toBe(30);
  });
});
