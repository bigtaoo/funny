// BOTSVC_DESIGN §3.1/§3.5: the online curve, session length and the PvE day plan.
import { describe, it, expect } from 'vitest';
import {
  EUROPE_DAY_CURVE,
  PVE_PEAK_END_UTC_H,
  PVE_PEAK_SHARE,
  PVE_PEAK_START_UTC_H,
  SESSION_MAX_MS,
  SESSION_MIN_MS,
  berlinHour,
  diurnalTarget,
  onlineShare,
  planPveDay,
  sessionLength,
  utcDayStart,
} from '../src/rotation';

const HOUR = 3_600_000;
/** Deterministic uniform source for the distribution cases (LCG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('the European day', () => {
  it('Berlin local time, summer and winter (DST from the tz database)', () => {
    expect(berlinHour(Date.UTC(2026, 6, 1, 18, 0))).toBe(20); // CEST, UTC+2
    expect(berlinHour(Date.UTC(2026, 0, 15, 18, 30))).toBe(19.5); // CET, UTC+1
  });

  it('peaks at 1 in the evening, lowest before dawn, mean about 0.55', () => {
    expect(EUROPE_DAY_CURVE).toHaveLength(24);
    expect(Math.max(...EUROPE_DAY_CURVE)).toBe(1);
    expect(EUROPE_DAY_CURVE[20]).toBe(1);
    expect(EUROPE_DAY_CURVE.indexOf(Math.min(...EUROPE_DAY_CURVE))).toBe(4);
    for (const v of EUROPE_DAY_CURVE) expect(v).toBeGreaterThan(0);
    const mean = EUROPE_DAY_CURVE.reduce((a, b) => a + b, 0) / 24;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(0.6);
  });

  it('interpolates between hours, including across midnight', () => {
    expect(onlineShare(Date.UTC(2026, 6, 1, 17, 30))).toBeCloseTo((EUROPE_DAY_CURVE[19]! + EUROPE_DAY_CURVE[20]!) / 2);
    expect(onlineShare(Date.UTC(2026, 6, 1, 21, 30))).toBeCloseTo((EUROPE_DAY_CURVE[23]! + EUROPE_DAY_CURVE[0]!) / 2);
  });

  it('targetOnline is the peak: full at 20:00 Berlin, a fraction at 04:00, at least one bot', () => {
    expect(diurnalTarget(100, Date.UTC(2026, 6, 1, 18))).toBe(100);
    expect(diurnalTarget(100, Date.UTC(2026, 6, 1, 2))).toBe(12);
    expect(diurnalTarget(1, Date.UTC(2026, 6, 1, 2))).toBe(1);
    expect(diurnalTarget(0, Date.UTC(2026, 6, 1, 18))).toBe(0);
  });
});

describe('sessionLength', () => {
  it('20 to 60 minutes', () => {
    expect(sessionLength(() => 0)).toBe(SESSION_MIN_MS);
    expect(sessionLength(() => 0.999999)).toBeLessThan(SESSION_MAX_MS);
    expect(SESSION_MIN_MS).toBe(20 * 60_000);
    expect(SESSION_MAX_MS).toBe(60 * 60_000);
  });
});

describe('planPveDay', () => {
  const day = utcDayStart(Date.UTC(2026, 8, 26, 9, 41));

  it('utcDayStart is UTC midnight', () => {
    expect(day).toBe(Date.UTC(2026, 8, 26));
  });

  it('one, two or three runs, by the first draw', () => {
    expect(planPveDay(day, () => 0)).toHaveLength(1);
    expect(planPveDay(day, () => 0.4)).toHaveLength(2);
    expect(planPveDay(day, () => 0.9)).toHaveLength(3);
  });

  it('the evening window is 17:00–22:00 UTC; off-peak wraps round midnight', () => {
    // Draws: count, then per run (peak?, where).
    const seq = (xs: number[]) => { let i = 0; return () => xs[i++]!; };
    expect(planPveDay(day, seq([0, 0, 0]))).toEqual([day + PVE_PEAK_START_UTC_H * HOUR]);
    expect(planPveDay(day, seq([0, 0, 0.999999]))[0]).toBeLessThan(day + PVE_PEAK_END_UTC_H * HOUR);
    expect(planPveDay(day, seq([0, PVE_PEAK_SHARE, 0]))).toEqual([day + PVE_PEAK_END_UTC_H * HOUR]);
    const late = planPveDay(day, seq([0, PVE_PEAK_SHARE, 0.999999]))[0]!;
    expect(late).toBeLessThan(day + PVE_PEAK_START_UTC_H * HOUR);
    expect(late).toBeGreaterThan(day + PVE_PEAK_START_UTC_H * HOUR - 60_000);
  });

  it('over many days: two runs on average, half of them in the evening, all inside the day, ascending', () => {
    const random = lcg(42);
    let runs = 0;
    let peak = 0;
    const days = 4000;
    for (let d = 0; d < days; d++) {
      const start = day + d * 24 * HOUR;
      const times = planPveDay(start, random);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      for (const t of times) {
        expect(t).toBeGreaterThanOrEqual(start);
        expect(t).toBeLessThan(start + 24 * HOUR);
        const h = (t - start) / HOUR;
        if (h >= PVE_PEAK_START_UTC_H && h < PVE_PEAK_END_UTC_H) peak++;
      }
      runs += times.length;
    }
    expect(runs / days).toBeGreaterThan(1.95);
    expect(runs / days).toBeLessThan(2.05);
    expect(peak / runs).toBeGreaterThan(0.48);
    expect(peak / runs).toBeLessThan(0.52);
  });
});
