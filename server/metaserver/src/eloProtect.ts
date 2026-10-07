// ELO-loss protection eligibility (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07).
// The two slot pools (new-player: first NEWBIE_PROTECT_GAMES settled ranked games, counted off the
// lifetime pvp.wins + pvp.losses; daily: first DAILY_PROTECT_GAMES of each server-UTC day, counted in
// pvp.dailyProtect) and the delta/streak rule live in @nw/shared ladder.ts; this module only answers
// "may this account be protected at all" — botsvc's persistent bot accounts never are.
import type { Collections, SaveData } from '@nw/shared';
import { createLogger, makeDayKey, nextProtectSlot } from '@nw/shared';
import { BOT_DEVICE_ID_PATTERN } from './activityDays.js';

const log = createLogger('meta:elo-protect');

/** Settled ranked games so far (lifetime; ranked settlement is the only writer of wins/losses). */
export function settledRankedGames(pvp: Pick<SaveData['pvp'], 'wins' | 'losses'> | undefined): number {
  return (pvp?.wins ?? 0) + (pvp?.losses ?? 0);
}

/**
 * The server-UTC day a settlement belongs to — the same day key the daily tasks reset on
 * (retention.ts makeDayKey). Computed once per settlement so the eligibility pre-check and the
 * in-CAS slot decision can't straddle midnight differently.
 */
export function protectDayKey(nowMs: number): string {
  return makeDayKey(nowMs);
}

/**
 * Whether `accountId` may receive ELO-loss protection on `dayKey`. Short-circuits without a read when
 * the save already shows both pools used up for that day (the common case for a veteran's 4th+ game of
 * the day; both counters only grow within a day), so those cost nothing. Otherwise one projected
 * accounts read: botsvc accounts log in with deviceId `bot-NNNN` (BOT_DEVICE_ID_PATTERN) and are
 * excluded. A failed read fails *open* — wrongly protecting a bot for a few games is the cheaper
 * mistake than charging a real player inside their protected games.
 */
export async function eloProtectEligible(
  cols: Pick<Collections, 'accounts'>,
  accountId: string,
  pvp: Pick<SaveData['pvp'], 'wins' | 'losses' | 'dailyProtect'> | undefined,
  dayKey: string,
): Promise<boolean> {
  if (pvp && !nextProtectSlot(settledRankedGames(pvp), pvp.dailyProtect, dayKey)) return false;
  try {
    const acct = await cols.accounts.findOne({ _id: accountId }, { projection: { deviceId: 1 } });
    return !(acct?.deviceId && BOT_DEVICE_ID_PATTERN.test(acct.deviceId));
  } catch (e) {
    log.warn('bot check failed; assuming human', { accountId, err: (e as Error).message });
    return true;
  }
}
