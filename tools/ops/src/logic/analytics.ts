// Pure layer for the analytics page (ADR-070 Phase 4e). Everything here is arithmetic over the
// analyticsvc payloads: which sections have data at all, the pivots, the shares behind every bar.
// pages/analytics.ts is left with the tables those answers get poured into.
//
// The row shapes below mirror the inline return type of `Api.analyticsEvents` structurally rather
// than importing it — TypeScript is structural, so a widened local shape both documents what each
// function actually reads and keeps this module free of any dependency on the transport layer.
import { pct } from './shared';

// ── Which sections have anything to show ──
// The page fires 17 requests through Promise.allSettled and each section then asked the same three
// questions inline: did the request succeed, is analytics configured at all, and did this particular
// list come back non-empty. Written out ~15 times, that read as boilerplate rather than as policy.

/** True when analytics answered but reports itself unconfigured — the page says so once and stops. */
export function analyticsUnavailable(settled: PromiseSettledResult<{ available: boolean }>): boolean {
  return settled.status === 'fulfilled' && !settled.value.available;
}

/** The rows a list-shaped section should render: empty when the request failed, analytics is off, or the list is absent. */
export function sectionRows<V extends { available: boolean }, T>(
  settled: PromiseSettledResult<V>,
  pick: (v: V) => readonly T[] | undefined,
): T[] {
  if (settled.status !== 'fulfilled' || !settled.value.available) return [];
  return [...(pick(settled.value) ?? [])];
}

/** Same, for the three cohort sections whose payload is one object rather than a list. */
export function sectionValue<V extends { available: boolean }, T>(
  settled: PromiseSettledResult<V>,
  pick: (v: V) => T | undefined,
): T | undefined {
  if (settled.status !== 'fulfilled' || !settled.value.available) return undefined;
  return pick(settled.value);
}

// ── Bars ──

/** Width of a bar as a fraction of its track. Guards max=0, which every share table can hit on an empty day. */
export function barRatio(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

/** Bar width in CSS pixels — 120px at full scale, rounded so the style string stays short. */
export function barWidthPx(ratio: number): string {
  return (ratio * 120).toFixed(0);
}

// ── Distribution tables (locale / country / OS / browser / device type) ──

export interface ShareRow {
  label: string;
  value: number;
  share: number;
}

/**
 * A `label | count | share` table out of one of the five `*_dist` payloads.
 *
 * Those five sections were five verbatim copies of the same fifteen lines, differing only in the
 * column heading and which string field held the label — the kind of duplication that only becomes
 * visible once the arithmetic is pulled out of the markup. `key` names the label field.
 */
export function distribution<K extends string>(
  rows: readonly (Record<K, string> & { devices: number })[],
  key: K,
): ShareRow[] {
  const total = rows.reduce((s, r) => s + r.devices, 0);
  return rows.map((r) => ({ label: r[key], value: r.devices, share: barRatio(r.devices, total) }));
}

// ── Login-hour histogram ──

/** Hours as "07:00" with each bar scaled against the busiest hour (not the total — this is a shape, not a share). */
export function loginHourRows(rows: readonly { hour: number; count: number }[]): ShareRow[] {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return rows.map((r) => ({
    label: `${String(r.hour).padStart(2, '0')}:00`,
    value: r.count,
    share: barRatio(r.count, max),
  }));
}

// ── Cohort step funnels (onboarding / tutorial / scene) ──

export interface StepFunnelRow {
  label: string;
  count: number;
  /** Conversion from the PREVIOUS step, as analyticsvc computed it; absent on the first step. */
  stepRate?: number;
  /** Share of the whole cohort, computed here. */
  ofCohort: number;
}

/** Human-readable labels for onboarding funnel step keys (must match ONBOARDING_STEPS in analyticsvc). */
export const ONBOARDING_LABELS: Record<string, string> = {
  session_start: 'Opened the game',
  tutorial_start: 'Started tutorial',
  tutorial_complete: 'Finished tutorial',
  first_battle: 'Started first battle',
  first_clear: 'Cleared first level',
};

/** Human-readable labels for tutorial step-funnel keys (must match TUTORIAL_ORDERED_KEYS in analyticsvc). */
export const TUTORIAL_LABELS: Record<string, string> = {
  tutorial_start: 'Started tutorial',
  orientation_1: 'Orientation O1', orientation_2: 'Orientation O2', orientation_3: 'Orientation O3',
  orientation_4: 'Orientation O4', orientation_5: 'Orientation O5', orientation_6: 'Orientation O6',
  orientation_7: 'Orientation O7',
  beat_unit: 'Beat: deploy unit', beat_building: 'Beat: deploy building', beat_spell: 'Beat: cast spell',
  freeplay: 'Free play',
  tutorial_complete: 'Finished tutorial',
};

/** The scene funnel passes no label map on purpose — its step keys are already scene names. */
export function stepFunnelRows(
  funnel: readonly { step: string; count: number; conversion_rate?: number }[],
  cohortSize: number,
  labels?: Record<string, string>,
): StepFunnelRow[] {
  return funnel.map((s) => ({
    label: labels?.[s.step] ?? s.step,
    count: s.count,
    ...(s.conversion_rate !== undefined ? { stepRate: s.conversion_rate } : {}),
    ofCohort: cohortSize > 0 ? s.count / cohortSize : 0,
  }));
}

// ── Retention cohorts ──

export const RETENTION_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;
export type RetentionOffset = (typeof RETENTION_OFFSETS)[number];

export interface RetentionRow {
  date: string;
  cohort_size: number;
  d?: Partial<Record<RetentionOffset, number>>;
  d_rate?: Partial<Record<RetentionOffset, number>>;
}

/** Empty cohorts carry no information and would render as a row of dashes. */
export function retentionRows<T extends { cohort_size: number }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.cohort_size > 0);
}

/** One D{n} cell: the rate as text, with the returning-device count as the hover title. */
export function retentionCell(row: RetentionRow, n: RetentionOffset): { text: string; title: string } {
  const rate = row.d_rate?.[n];
  const count = row.d?.[n];
  return {
    text: rate !== undefined ? pct(rate) : '—',
    title: count !== undefined ? `${count} devices` : 'insufficient data',
  };
}

// ── Level funnel ──

/** The list arrives worst-completion-first; the caption promises 20, so the cap belongs with the promise. */
export const LEVEL_FUNNEL_LIMIT = 20;

export function levelFunnelRows<T>(rows: readonly T[]): T[] {
  return rows.slice(0, LEVEL_FUNNEL_LIMIT);
}

// ── Post-match badge distribution pivot ──

export interface BadgeRow {
  mode: string;
  result: string;
  badge: string;
  count: number;
}

export interface BadgePivot {
  /** Column order: the known results first (only those present), then anything unexpected, so a new result kind still shows up. */
  results: string[];
  /** Badge rows, most matches first. `counts` is aligned with `results`. */
  badges: { badge: string; counts: number[]; total: number; share: number }[];
  grandTotal: number;
}

const BADGE_RESULT_ORDER = ['win', 'loss', 'draw'];

/** Distinct modes present, sorted — one pivot table each. */
export function badgeModes(rows: readonly BadgeRow[]): string[] {
  return [...new Set(rows.map((r) => r.mode))].sort();
}

export function badgePivot(rows: readonly BadgeRow[], mode: string): BadgePivot {
  const modeRows = rows.filter((r) => r.mode === mode);
  const results = BADGE_RESULT_ORDER.filter((rr) => modeRows.some((r) => r.result === rr))
    .concat([...new Set(modeRows.map((r) => r.result))].filter((rr) => !BADGE_RESULT_ORDER.includes(rr)));
  const cell = new Map(modeRows.map((r) => [`${r.badge}:${r.result}`, r.count]));
  const badges = [...new Set(modeRows.map((r) => r.badge))]
    .map((badge) => {
      const counts = results.map((rr) => cell.get(`${badge}:${rr}`) ?? 0);
      return { badge, counts, total: counts.reduce((s, n) => s + n, 0) };
    })
    .sort((a, b) => b.total - a.total);
  const grandTotal = badges.reduce((s, b) => s + b.total, 0);
  return {
    results,
    badges: badges.map((b) => ({ ...b, share: barRatio(b.total, grandTotal) })),
    grandTotal,
  };
}

// ── Conversion funnel (per platform, latest day) ──

export const FUNNEL_STEPS = ['session_start', 'game_start', 'level_attempt', 'level_complete'];

export interface FunnelRow {
  date: string;
  platform: string;
  funnel_step: string;
  count: number;
  conversion_rate?: number;
}

/** Distinct platforms present, sorted — one funnel table each. */
export function funnelPlatforms(rows: readonly FunnelRow[]): string[] {
  return [...new Set(rows.map((r) => r.platform))].sort();
}

/**
 * The platform's most recent day, one entry per canonical step. A step missing from that day yields
 * an entry with no count, which the table prints as an em dash — the step list is fixed so the shape
 * of the funnel stays comparable across days even when a step recorded nothing.
 */
export function funnelPivot(
  rows: readonly FunnelRow[],
  platform: string,
): { latestDate: string; cells: { step: string; count?: number; rate?: number }[] } {
  const platRows = rows.filter((r) => r.platform === platform);
  const latestDate = platRows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const byStep = new Map(platRows.filter((r) => r.date === latestDate).map((r) => [r.funnel_step, r]));
  return {
    latestDate,
    cells: FUNNEL_STEPS.map((step) => {
      const row = byStep.get(step);
      return {
        step,
        ...(row ? { count: row.count } : {}),
        ...(row?.conversion_rate !== undefined ? { rate: row.conversion_rate } : {}),
      };
    }),
  };
}

// ── Event-count grid ──

/** date x event matrix, both axes sorted, missing combinations zero-filled. `grid[dateIdx][eventIdx]`. */
export function eventCountGrid(
  rows: readonly { date: string; event: string; count: number }[],
): { events: string[]; dates: string[]; grid: number[][] } {
  const events = [...new Set(rows.map((r) => r.event))].sort();
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const lookup = new Map(rows.map((r) => [`${r.date}:${r.event}`, r.count]));
  return {
    events,
    dates,
    grid: dates.map((date) => events.map((e) => lookup.get(`${date}:${e}`) ?? 0)),
  };
}

// ── Self-collected metrics overview ──

/** The 24h avg/peak/samples table. `avg` is pre-formatted because one decimal is the only sensible reading of a gauge average. */
export function metricRows(
  last24h: Record<string, { avg: number; peak: number; samples: number }>,
): { key: string; avg: string; peak: number; samples: number }[] {
  return Object.entries(last24h).map(([key, v]) => ({
    key,
    avg: v.avg.toFixed(1),
    peak: v.peak,
    samples: v.samples,
  }));
}
