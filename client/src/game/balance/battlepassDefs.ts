// Battle pass definition table — client view over the server-authoritative table (ECONOMY_NUMBERS §13).
//
// This file used to be a hand-copied mirror of server/shared/src/battlepass.ts, with a header that
// asked the reader to "update the server-side battlepass.ts in sync with any changes here". It no
// longer is: `battlepass.ts` has zero imports, so it is browser-safe on its own and is aliased as
// `@nw/shared/battlepass` (webpack / tsconfig / every vitest config), exactly the treatment
// cards.ts and equipment.ts already had (ADR-087). The two copies were verified byte-identical
// (REWARD_ROWS, BATTLEPASS_DEFS, xpToLevel, xpToNextLevel) before this one was deleted, so nothing
// moved; what changed is that a number can no longer drift, because there is only one side.
//
// Nothing stays local. The claim/reset logic (claimBpReward / pendingBpRewards /
// makeFreshBattlePass) is deliberately NOT re-exported: the server owns those outcomes, and the
// client's own claim path goes through the API (see game/meta/battlepass.ts for the local view).

export type { BpReward, BpRewardKind, BpLevelDef } from '@nw/shared/battlepass';
export {
  /** Per-level reward table (30 levels, free + paid track). */
  BATTLEPASS_DEFS,
  /** Level cap. */
  BATTLEPASS_MAX_LEVEL,
  /** Coin price of the paid Pass. */
  BATTLEPASS_BUY_COST,
  /** XP per level (flat). */
  BP_XP_PER_LEVEL,
  /** Season XP awarded per ranked game (drives the "how to earn" hint). */
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  /** Cumulative XP → current level (1-based, capped). */
  xpToLevel,
  /** XP still needed to reach the next level (0 at cap). */
  xpToNextLevel,
} from '@nw/shared/battlepass';
