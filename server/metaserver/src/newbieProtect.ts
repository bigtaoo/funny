// New-player ELO protection eligibility (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07).
// The window itself (first NEWBIE_PROTECT_GAMES settled ranked games, counted off the lifetime
// pvp.wins + pvp.losses) and the delta/streak rule live in @nw/shared ladder.ts; this module only
// answers "may this account be protected at all" — botsvc's persistent bot accounts never are.
import type { Collections, SaveData } from '@nw/shared';
import { NEWBIE_PROTECT_GAMES, createLogger } from '@nw/shared';
import { BOT_DEVICE_ID_PATTERN } from './activityDays.js';

const log = createLogger('meta:newbie-protect');

/** Settled ranked games so far (lifetime; ranked settlement is the only writer of wins/losses). */
export function settledRankedGames(pvp: Pick<SaveData['pvp'], 'wins' | 'losses'> | undefined): number {
  return (pvp?.wins ?? 0) + (pvp?.losses ?? 0);
}

/**
 * Whether `accountId` may receive new-player protection. Short-circuits without a read once the
 * save already shows the window used up (wins + losses only ever grow), so veterans cost nothing.
 * Otherwise one projected accounts read: botsvc accounts log in with deviceId `bot-NNNN`
 * (BOT_DEVICE_ID_PATTERN) and are excluded. A failed read fails *open* — the save already says
 * this is a brand-new account, and wrongly protecting a bot for ≤3 games is the cheaper mistake.
 */
export async function newbieProtectEligible(
  cols: Pick<Collections, 'accounts'>,
  accountId: string,
  pvp: Pick<SaveData['pvp'], 'wins' | 'losses'> | undefined,
): Promise<boolean> {
  if (pvp && settledRankedGames(pvp) >= NEWBIE_PROTECT_GAMES) return false;
  try {
    const acct = await cols.accounts.findOne({ _id: accountId }, { projection: { deviceId: 1 } });
    return !(acct?.deviceId && BOT_DEVICE_ID_PATTERN.test(acct.deviceId));
  } catch (e) {
    log.warn('bot check failed; assuming human', { accountId, err: (e as Error).message });
    return true;
  }
}
