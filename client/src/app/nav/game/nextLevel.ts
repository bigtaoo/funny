// What a won campaign level's result screen offers next (ONBOARDING_DESIGN §13). Split out of
// campaignRoster.ts (500-line rule) and kept pure so the branching is testable on its own.
import { CAMPAIGN_LEVEL_ORDER } from '../../../game';

/**
 * Seconds before "next level" presses itself on a level's FIRST clear. A replay of an old level
 * waits for the tap — that player came back for a reason and may want the map.
 */
export const NEXT_LEVEL_AUTO_SEC = 5;

/**
 * The level the result screen's primary button leads to after a win, or null for "back to map".
 *
 * Null when the win did not clear the level (no stars), when a chapter-end interlude has to play
 * first (it returns to the map by design), or after the last level. In the first CrazyGames week
 * about a quarter of all sessions ended on a win's result screen whose only primary was "back to
 * map" — the next fight was three taps away (map → level → start).
 */
export function nextLevelAfterWin(levelId: string, cleared: boolean, hasInterlude: boolean): string | null {
  if (!cleared || hasInterlude) return null;
  const i = CAMPAIGN_LEVEL_ORDER.indexOf(levelId);
  return i >= 0 ? (CAMPAIGN_LEVEL_ORDER[i + 1] ?? null) : null;
}

/**
 * Seconds the level-chain banner holds over a won battle before the next level starts by itself
 * (ONBOARDING_DESIGN §17.3). Short on purpose: the first-week CrazyGames sessions showed every
 * screen between two fights losing players, and a tap anywhere skips the wait anyway.
 */
export const CHAIN_AUTO_SEC = 1.5;

/**
 * First clears chain from banner to banner, except on every this-many-th campaign level (lv5, lv10,
 * …), which stops at the full result screen — stars, rewards, the way to the map (§17.3).
 */
export const CHAIN_RESULT_EVERY = 5;
