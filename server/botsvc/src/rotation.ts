// When bots are online and when they play PvE (BOTSVC_DESIGN §3.1, §3.5). Pure: the scheduler and
// BotSession feed in the clock and a random source.
//
// Until 2026-09-26 the fleet never rotated: the scheduler logged in the first `targetOnline` accounts
// of the pool and kept them on forever, so bot-0001..0100 were online around the clock and the other
// 900 never were. The players these bots stand in for are European, so the online count now follows
// a European evening-peaked day, and every session ends after 20–60 minutes.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Share of `targetOnline` wanted online by local hour in Europe/Berlin (index = hour), linearly
 * interpolated between hours. `targetOnline` is the evening PEAK, not the daily mean — the mean of
 * this table is about 0.55. Low at night, a lunchtime bump, and the peak from 19:00 to 22:00.
 */
export const EUROPE_DAY_CURVE: readonly number[] = [
  0.45, 0.3, 0.2, 0.15, 0.12, 0.12, 0.18, 0.3, 0.4, 0.45, 0.5, 0.55,
  0.6, 0.6, 0.55, 0.55, 0.6, 0.7, 0.85, 0.95, 1.0, 1.0, 0.85, 0.65,
];

const berlinClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

/** Local Europe/Berlin time of day in fractional hours (DST handled by the tz database). */
export function berlinHour(now: number): number {
  let h = 0;
  let m = 0;
  for (const p of berlinClock.formatToParts(new Date(now))) {
    if (p.type === 'hour') h = Number(p.value);
    else if (p.type === 'minute') m = Number(p.value);
  }
  return h + m / 60;
}

/** EUROPE_DAY_CURVE at `now`, in (0, 1]. */
export function onlineShare(now: number): number {
  const h = berlinHour(now);
  const i = Math.floor(h) % 24;
  const f = h - Math.floor(h);
  return EUROPE_DAY_CURVE[i]! * (1 - f) + EUROPE_DAY_CURVE[(i + 1) % 24]! * f;
}

/** Online target at `now`: the peak scaled by the curve, never below one bot while the peak is set. */
export function diurnalTarget(peak: number, now: number): number {
  if (peak <= 0) return 0;
  return Math.max(1, Math.round(peak * onlineShare(now)));
}

export const SESSION_MIN_MS = 20 * 60_000;
export const SESSION_MAX_MS = 60 * 60_000;

/** How long one login lasts, uniform in [SESSION_MIN_MS, SESSION_MAX_MS). */
export function sessionLength(random: () => number): number {
  return SESSION_MIN_MS + Math.floor(random() * (SESSION_MAX_MS - SESSION_MIN_MS));
}

/** PvE runs per bot per UTC day: one of these, uniformly. */
export const PVE_RUNS_PER_DAY = [1, 2, 3] as const;
/** The European evening, in UTC hours [start, end): this share of all runs lands inside it. */
export const PVE_PEAK_START_UTC_H = 17;
export const PVE_PEAK_END_UTC_H = 22;
export const PVE_PEAK_SHARE = 0.5;

export function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/**
 * A bot's PvE start times for the UTC day beginning at `dayStart`, ascending. Each run lands in the
 * evening window with PVE_PEAK_SHARE, otherwise uniformly over the other 19 hours — so the evening
 * gets half the runs in a quarter of the day, about three times the rate of the rest.
 */
export function planPveDay(dayStart: number, random: () => number): number[] {
  const runs = PVE_RUNS_PER_DAY[Math.floor(random() * PVE_RUNS_PER_DAY.length)]!;
  const peakMs = (PVE_PEAK_END_UTC_H - PVE_PEAK_START_UTC_H) * HOUR_MS;
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const offset =
      random() < PVE_PEAK_SHARE
        ? PVE_PEAK_START_UTC_H * HOUR_MS + random() * peakMs
        : // The off-peak hours run from the window's end, round midnight, to its start.
          (PVE_PEAK_END_UTC_H * HOUR_MS + random() * (DAY_MS - peakMs)) % DAY_MS;
    times.push(dayStart + Math.floor(offset));
  }
  return times.sort((a, b) => a - b);
}
