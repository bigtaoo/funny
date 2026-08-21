// Pure layer for the live monitor page (ADR-070 Phase 4e): which metrics exist, what the stat grid
// says, and the two intervals. pages/monitor.ts keeps the `<select>`, the grid, and the timer.
import type { LiveStats } from '../types';

/** Self-collected metrics → display labels (same order as the backend METRIC_KEYS). */
export const METRICS: readonly [string, string][] = [
  ['online', 'Online connections'],
  ['queue', 'Matchmaking queue'],
  ['rooms', 'Active rooms'],
  ['gameInstances', 'Game instances'],
  ['gameLoad', 'Game load'],
];

/** Falls back to the raw key so a metric the backend added but this list has not still renders. */
export function metricLabel(metric: string): string {
  return METRICS.find(([v]) => v === metric)?.[1] ?? metric;
}

/**
 * The stat grid, in METRICS order. `gameLoad` is the one optional field — an older stats backend
 * omits it, and 0 is the honest reading there (the note below says the numbers may be placeholders).
 */
export function liveCells(live: LiveStats): [string, number][] {
  const value: Record<string, number> = {
    online: live.online,
    queue: live.queue,
    rooms: live.rooms,
    gameInstances: live.gameInstances,
    gameLoad: live.gameLoad ?? 0,
  };
  // The `?? 0` is unreachable while METRICS and `value` share their keys — which they do, and which
  // liveCells's own test pins. It is there because `noUncheckedIndexedAccess` types the lookup as
  // possibly-undefined, and because a metric added to METRICS alone should render 0 rather than NaN.
  return METRICS.map(([key, label]) => [label, value[key] ?? 0]);
}

/** Empty when the stats backend is configured — this doubles as the page's error slot. */
export function availabilityNote(live: Pick<LiveStats, 'available'>): string {
  return live.available ? '' : 'Note: stats backend not configured, showing 0.';
}

/** Trend window: the last 6 hours, which is also what the caption promises. */
export const TREND_WINDOW_MS = 6 * 3600 * 1000;

export function trendFromMs(now: number): number {
  return now - TREND_WINDOW_MS;
}

export function trendCaption(label: string, samples: number): string {
  return `${label} trend (last 6h, ${samples} samples)`;
}

/** Auto-refresh interval for the checkbox-controlled poll. */
export const AUTO_REFRESH_MS = 10_000;
