/** Public types of ResultScene, split out to keep ResultScene.ts under the 500-line gate. */
import type { ProfileData, ProfileExtra } from '../../ui/dialogs/ProfilePopup';
import type { IconKind } from '../../render/icons';
import type { RewardLike } from '../../render/rewardIcon';
import type { EloProtectFields } from './builders';

/** Optional player identities for the result screen's tap-to-view profile popup. */
export interface ResultProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
}

/** Server-authoritative ELO result (ranked only, from match_over.elo). */
export interface EloResult extends EloProtectFields {
  delta: number;
  after: number;
  rankAfter: string;
}

/** The "come back tomorrow" check-in hook (RETENTION_LAUNCH_PLAN.md §3.3) — see AppViews.ts's doc. */
export interface ResultRetentionPreview {
  /** 1-based check-in calendar slot (server/shared/src/retention.ts CHECKIN_REWARDS index + 1). */
  day: number;
  reward: RewardLike;
}

export interface ResultSceneCallbacks {
  onPlayAgain(): void;
  /** Top-left back chip — always shown, always exits straight to the lobby regardless of what onPlayAgain does. */
  onBack(): void;
  /** When set, a "watch replay" button is shown (locally-recorded matches, S1-RP). */
  onWatchReplay?(): void;
  /** When set, a "share this match" button is shown (state-stream sharing, REPLAY_SHARE_DESIGN §4.3). */
  onShare?(): void;
  /** Override the "play again" button label (e.g. campaign uses 'Back to Map'). */
  playAgainLabel?: string;
  /**
   * An extra entry at the head of the secondary row — campaign's "back to map" once a defeat turns
   * the primary CTA into "retry".
   */
  secondaryAction?: { label: string; icon: IconKind; onTap(): void };
  /** Unified profile-popup extras (rank/ELO + family/sect) — see ProfilePopup's `fetchExtra`. Omitted offline/AI. */
  getProfileExtra?(publicId: string): Promise<ProfileExtra>;
  /**
   * Seconds before the primary button presses itself, a bar filling along its foot meanwhile
   * (ONBOARDING_DESIGN §13 — campaign's first clear of a level, where the primary is "next level").
   * Counts from when the result itself is on screen, never during the outro; any tap on the screen's
   * other controls cancels it.
   */
  autoContinueSec?: number;
  /**
   * The compact first-win screen (ONBOARDING_DESIGN §15.4) — a first clear of an early campaign level:
   * only the hero badge, no medallion row, and an "up next" teaser naming the level the primary CTA
   * leads to, so the screen reads as one step of a run rather than a stats page.
   */
  firstWin?: { nextName: string };
}
