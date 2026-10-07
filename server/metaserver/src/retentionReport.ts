// Consent-free server retention report (GET /internal/retention → admin /admin/analytics/retention → ops
// "Server retention" table). Built only from data the game server keeps to run the game — account signup
// time, the save's tutorial flag / cleared levels, and the activity windows activityDays.ts records — so it
// works for players who never consented to client analytics (legitimate interest, GDPR Art 6(1)(f)).
//
// Exclusions (same rules as the recorder, see eligibleAccountFilter): players who objected
// (`flags.gdprConsent === false`), soft-deleted / purged accounts, and botsvc's bot accounts (deviceId
// `bot-…`). They are neither shown nor counted, not even in `signups`.
//
// Caveat: accounts created before activityDays.ts shipped have no activeDays at all, so cohorts from
// before that date (and the first ~30 days after it, for the later D-columns) under-report retention.
// The signup / tutorial / cleared columns are unaffected.
import type { Collections } from '@nw/shared';
import { DAY_MS, eligibleAccountFilter } from './activityDays.js';

export const RETENTION_DAYS_DEFAULT = 30;
export const RETENTION_DAYS_MAX = 90;
/** The D-columns of the report. Each must be < ACTIVITY_WINDOW_DAYS (activityDays.ts). */
export const RETENTION_OFFSETS = [1, 3, 7, 14, 30] as const;
/** Chapter-1 levels whose clear rate the report shows (save.progress.cleared ids). */
export const RETENTION_LEVELS = ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'] as const;

type RetentionKey = `d${(typeof RETENTION_OFFSETS)[number]}`;
type LevelId = (typeof RETENTION_LEVELS)[number];

export interface RetentionCohort {
  /** Signup day, UTC `YYYY-MM-DD` of accounts.createdAt. */
  date: string;
  signups: number;
  tutorialDone: number;
  cleared: Record<LevelId, number>;
  /** dK = accounts active in their K-th 24h window after signup; null while that window is still open for some account of the cohort. */
  retained: Record<RetentionKey, number | null>;
}

interface GroupRow {
  _id: number; // UTC day index (createdAt / DAY_MS, floored)
  signups: number;
  tutorialDone: number;
  [k: string]: number;
}

/** Clamp the `?days=` query parameter: default 30, 1..90. */
export function clampRetentionDays(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return RETENTION_DAYS_DEFAULT;
  return Math.min(n, RETENTION_DAYS_MAX);
}

/**
 * Whether dK is final for the cohort that signed up on UTC day `dayIndex`. Window K of an account spans
 * [createdAt + K days, createdAt + K+1 days); the cohort's last signup can be just before the day ends, so
 * every member's window K has closed only once `dayStart + (K + 2) days` has passed.
 */
export function retentionWindowClosed(dayIndex: number, k: number, now: number): boolean {
  return (dayIndex + k + 2) * DAY_MS <= now;
}

const countIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });

/**
 * Signup cohorts for the last `days` UTC days (today included, newest first; days without signups are
 * returned with zeros). One aggregation bounded by the createdAt index; the save lookup projects only the
 * two fields it needs.
 */
export async function retentionReport(
  cols: Pick<Collections, 'accounts' | 'saves'>,
  now: number,
  days: number,
): Promise<RetentionCohort[]> {
  const today = Math.floor(now / DAY_MS);
  const firstDay = today - days + 1;
  const group: Record<string, unknown> = {
    _id: { $floor: { $divide: ['$createdAt', DAY_MS] } },
    signups: { $sum: 1 },
    tutorialDone: countIf({ $eq: ['$tutorialDone', true] }),
  };
  for (const lv of RETENTION_LEVELS) group[lv] = countIf({ $in: [lv, '$cleared'] });
  for (const k of RETENTION_OFFSETS) group[`d${k}`] = countIf({ $in: [k, '$activeDays'] });

  const rows = await cols.accounts
    .aggregate<GroupRow>([
      { $match: { createdAt: { $gte: firstDay * DAY_MS, $lt: (today + 1) * DAY_MS }, ...eligibleAccountFilter() } },
      {
        $lookup: {
          from: cols.saves.collectionName,
          localField: '_id',
          foreignField: '_id',
          as: 's',
          pipeline: [{ $project: { _id: 0, t: '$save.flags.tutorial_done', c: '$save.progress.cleared' } }],
        },
      },
      {
        $project: {
          createdAt: 1,
          activeDays: { $ifNull: ['$activeDays', []] },
          tutorialDone: { $first: '$s.t' },
          cleared: { $ifNull: [{ $first: '$s.c' }, []] },
        },
      },
      { $group: group },
    ])
    .toArray();

  const byDay = new Map(rows.map((r) => [r._id, r]));
  const out: RetentionCohort[] = [];
  for (let day = today; day >= firstDay; day--) {
    const r = byDay.get(day);
    const cleared = {} as Record<LevelId, number>;
    for (const lv of RETENTION_LEVELS) cleared[lv] = r?.[lv] ?? 0;
    const retained = {} as Record<RetentionKey, number | null>;
    for (const k of RETENTION_OFFSETS) {
      retained[`d${k}`] = retentionWindowClosed(day, k, now) ? (r?.[`d${k}`] ?? 0) : null;
    }
    out.push({
      date: new Date(day * DAY_MS).toISOString().slice(0, 10),
      signups: r?.signups ?? 0,
      tutorialDone: r?.tutorialDone ?? 0,
      cleared,
      retained,
    });
  }
  return out;
}
