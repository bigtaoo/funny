// Shared constants for the app orchestration core (createAppCore + its nav modules).
// Extracted so the domain nav modules under app/nav/ can share the same storage keys
// and logger without importing createAppCore (which would be circular).
import { netLog } from '../net/log';

export const log = netLog('app');

/** flags key — set after the first-launch intro has been seen. */
export const SEEN_INTRO_FLAG = 'seen_intro';
/** Set after the tutorial is completed or skipped; prevents auto-entry afterwards. Clearing it via "replay tutorial" in settings allows re-entry (ONBOARDING_DESIGN §3.4). */
export const TUTORIAL_DONE_FLAG = 'tutorial_done';
/** flags key — set after the player accepts the GDPR / privacy consent (C5-c, L1-1). Mirrors server `flags.gdprConsent`. */
export const GDPR_CONSENT_FLAG = 'gdprConsent';
/**
 * flags key — the neutral age gate's recorded answer (AgeGateDialog): true = declared at least
 * {@link MIN_AGE_YEARS}, false = declared younger, and absent = never asked. That third state is
 * why the gate reads `save.flags` directly instead of `SaveManager.getFlag`, which returns
 * `flags[key] === true` and so cannot tell "never asked" from "declared younger".
 */
export const AGE_DECLARED_FLAG = 'ageOk';
/** The age the game is rated for and declares: `privacy-policy §9` self-rates 13+ (COPPA / GDPR-K). */
export const MIN_AGE_YEARS = 13;
/** Last seen ladder season number — used to detect season transitions and show the settlement popup (SE-6). */
export const LAST_SEEN_SEASON_KEY = 'nw_last_seen_season';
/** Persisted JWT for a real (non-anonymous) account, so logins survive restarts. */
export const TOKEN_KEY = 'nw_token';
/** Persisted display name shown in the lobby profile chip / settings screen. */
export const PLAYER_NAME_KEY = 'nw_player_name';
/** Persisted 9-digit public id (player-facing identifier; accountId stays internal). */
export const PLAYER_PUBLIC_ID_KEY = 'nw_player_public_id';
/** Persisted avatar token ('0'-'7'); absent = letter-initial fallback. */
export const PLAYER_AVATAR_KEY = 'nw_player_avatar';
/** Coin cost to change the display name. Mirrors server RENAME_COST; server authoritative. */
export const RENAME_COST = 500;
/** Persisted '1'/'0' flag: the player still holds their one-time free rename (name is a system default). Server-authoritative, refreshed from GET /save. */
export const FREE_RENAME_KEY = 'nw_free_rename';
/** Fallback season number used when worldsvc is unreachable (dev/offline). */
export const FALLBACK_SEASON = 1;

/** Platform name (the TARGET global injected at build time), evaluated at bootstrap. Mirrors analytics.getPlatformName. */
export function clientPlatformName(): 'web' | 'wechat' | 'crazygames' {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  if (t === 'wechat') return 'wechat';
  if (t === 'crazygames') return 'crazygames';
  return 'web';
}
