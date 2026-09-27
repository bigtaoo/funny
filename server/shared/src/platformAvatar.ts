// Platform-provided avatars (CRAZYGAMES_LAUNCH.md §4.1): a portal whose rules say the game must show
// the player's portal profile picture, not an in-game one. Today only CrazyGames writes one.
//
// Carried to every other player as an ordinary avatar id of the form `url:<https url>` — the same
// string field friends, family members, profile popups and the PvP opponent already receive — so no
// transport, contract or proto had to learn a second avatar field. Each client decides for itself
// whether it draws remote avatars (client/src/render/avatar.ts); one that does not falls back to the
// letter initial it already draws for an unknown id.
//
// Only URLs on an allowlisted host are ever written or served: the value reaches other players'
// clients, which load it as an image, so the server must never relay an arbitrary URL.

export const PLATFORM_AVATAR_PREFIX = 'url:';

/** Image hosts a platform avatar may live on. CrazyGames profile pictures are served from here
 *  (with `Access-Control-Allow-Origin: *`, which WebGL textures need). */
const ALLOWED_HOSTS: readonly string[] = ['images.crazygames.com'];

/** https + allowlisted host + no credentials/port tricks. */
export function isAllowedPlatformAvatarUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.port;
}

/**
 * The avatar id everyone else sees: the platform avatar when the account has one (it outranks the
 * in-game pick, which is the whole point of the portal rule), else the equipped in-game avatar.
 */
export function effectiveAvatarId(
  platformAvatarUrl: string | undefined,
  equippedAvatar: string | undefined,
): string | undefined {
  if (isAllowedPlatformAvatarUrl(platformAvatarUrl)) return PLATFORM_AVATAR_PREFIX + platformAvatarUrl;
  return equippedAvatar;
}
