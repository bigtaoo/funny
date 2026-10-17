/**
 * Web game portals the guest build ships to for self-testing (design/game/WEB_PORTALS.md). Each value is
 * both the client's webpack TARGET and the `X-NW-Platform` / analytics `platform` it reports, so the
 * channels are counted apart everywhere the platform is an allow-listed dimension.
 */
export const WEB_PORTAL_PLATFORMS = ['itch', 'newgrounds'] as const;
export type WebPortalPlatform = (typeof WEB_PORTAL_PLATFORMS)[number];

export function isWebPortalPlatform(p: unknown): p is WebPortalPlatform {
  return (WEB_PORTAL_PLATFORMS as readonly unknown[]).includes(p);
}
