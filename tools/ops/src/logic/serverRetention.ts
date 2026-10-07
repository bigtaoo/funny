// Pure layer of the analytics page's "Server retention (consent-free)" card (pages/serverRetention.ts).
//
// Different source from the D1–D7 cards above it on that page: those come from analyticsvc client events
// and therefore only see players who consented. This one is metaserver's own report over account / save
// data (signup time, tutorial flag, cleared levels, active 24h windows), which needs no consent; players
// who turned analytics off are excluded server-side. Every percentage is of the cohort's signups.
import type { ServerRetentionCohort } from '../types';
import { pct } from './shared';

/** Retention columns, in table order, with the key each one reads from `retained`. */
export const SERVER_RETENTION_OFFSETS = [1, 3, 7, 14, 30] as const;
/** Chapter-1 levels shown as clear-rate columns. */
export const SERVER_RETENTION_LEVELS = ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'] as const;
/** The `?days=` choices the card offers (server caps at 90). */
export const SERVER_RETENTION_DAY_CHOICES = [30, 60, 90] as const;

export interface ServerRetentionCell {
  /** Percentage of signups, or '—' when there is nothing to divide by / the cohort is too young for it. */
  text: string;
  /** Hover text: the raw count, or why the cell is empty. */
  title: string;
}

export interface ServerRetentionRow {
  date: string;
  signups: number;
  /** Tutorial %, then ch1_lv1..ch1_lv3 %, then D1, D3, D7, D14, D30 — header order. */
  cells: ServerRetentionCell[];
}

function share(count: number | null, signups: number): ServerRetentionCell {
  if (count === null) return { text: '—', title: 'not final yet (cohort too young)' };
  if (signups === 0) return { text: '—', title: 'no signups' };
  return { text: pct(count / signups), title: `${count} of ${signups}` };
}

/** Table rows, in the order the server sent them (newest cohort first). */
export function serverRetentionRows(cohorts: ServerRetentionCohort[]): ServerRetentionRow[] {
  return cohorts.map((c) => ({
    date: c.date,
    signups: c.signups,
    cells: [
      share(c.tutorialDone, c.signups),
      ...SERVER_RETENTION_LEVELS.map((lv) => share(c.cleared[lv], c.signups)),
      ...SERVER_RETENTION_OFFSETS.map((k) => share(c.retained[`d${k}`], c.signups)),
    ],
  }));
}

/** Column headers matching `ServerRetentionRow.cells`. */
export const SERVER_RETENTION_HEADERS: readonly string[] = [
  'Tutorial',
  ...SERVER_RETENTION_LEVELS,
  ...SERVER_RETENTION_OFFSETS.map((k) => `D${k}`),
];
