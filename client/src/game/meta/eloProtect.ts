// ELO-loss protection: how many protected ranked games the player has left today (lobby hint).
// Read-only mirror of server/shared/src/ladder.ts (NEWBIE_PROTECT_GAMES / DAILY_PROTECT_GAMES /
// protectedGamesLeft, SEASON_DESIGN_IMPL_SPEC.md §15.5) — duplicated rather than imported because the
// client's '@nw/shared' alias is scoped to the browser-safe SLG slice (see webpack.config.js), same as
// pickPracticeDifficulty in app/nav/lobby.ts. Keep the numbers in sync with ladder.ts. The server
// decides every settlement; this only drives the "N games today without ELO loss" line.
import type { SaveData } from './SaveData';
import { makeDayKey } from './retention';

/** Mirrors ladder.ts NEWBIE_PROTECT_GAMES: an account's first N settled ranked games. */
export const NEWBIE_PROTECT_GAMES = 3;
/** Mirrors ladder.ts DAILY_PROTECT_GAMES: the first N settled ranked games of each server-UTC day. */
export const DAILY_PROTECT_GAMES = 3;

/**
 * New-player slots left + daily slots left on the server-UTC day of `nowMs` (pass the server-corrected
 * clock). A stored `dailyProtect` from an older day reads as nothing used — the server resets it lazily.
 */
export function protectedGamesLeftToday(
  pvp: Pick<SaveData['pvp'], 'wins' | 'losses' | 'dailyProtect'>,
  nowMs: number,
): number {
  const settled = Math.max(0, (pvp.wins ?? 0) + (pvp.losses ?? 0));
  const newbieLeft = Math.max(0, NEWBIE_PROTECT_GAMES - settled);
  const d = pvp.dailyProtect;
  const used = d && d.dayKey === makeDayKey(nowMs) ? Math.max(0, d.used) : 0;
  return newbieLeft + Math.max(0, DAILY_PROTECT_GAMES - used);
}
