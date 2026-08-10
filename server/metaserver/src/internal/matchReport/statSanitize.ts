// Split from matchReport.ts (2026-08-10, independent function module range 6, part 2/6).
import { createLogger, sanitizePvpReportedStats, type StatKey } from '@nw/shared';
import type { ReportBody } from './types.js';

const log = createLogger('meta:internal');

/**
 * S9-6: Fetch one side's reported in-match achievement counts and run them through L1 sanitization (§4.4).
 * Returns the sanitized statKey deltas; out-of-bounds/invalid → logs a warning and returns `{}` (rejects that side's kill/cast, pvp.wins proceed normally).
 */
export function statDeltaForSide(body: ReportBody, side: number): Partial<Record<StatKey, number>> {
  const reported = body.results.find((r) => r.side === side)?.stats;
  const clean = sanitizePvpReportedStats(reported);
  if (clean === null) {
    log.warn('PvP stat L1 reject (out-of-bounds reported stats)', { roomId: body.room_id, side });
    return {};
  }
  return clean;
}
