/**
 * The client's platform name — the TARGET global injected at build time, narrowed to the values the
 * server allow-lists (`X-NW-Platform`, analytics `platform`, signup cohort). One source for every
 * reader so a new build target cannot be reported as 'web' by one of them and as itself by another.
 *
 * `itch` / `newgrounds` are the self-test web-portal builds (design/game/WEB_PORTALS.md); they mirror
 * server/shared/src/webPortals.ts.
 */
export const WEB_PORTAL_TARGETS = ['itch', 'newgrounds'] as const;
export type WebPortalTarget = (typeof WEB_PORTAL_TARGETS)[number];
export type ClientPlatformName = 'web' | 'wechat' | 'crazygames' | WebPortalTarget;

/** Builds that run as a guest-only game on a third-party portal's domain (CrazyGames and the self-test portals). */
export function isPortalBuild(name: ClientPlatformName = clientPlatformName()): boolean {
  return name === 'crazygames' || (WEB_PORTAL_TARGETS as readonly string[]).includes(name);
}

export function clientPlatformName(): ClientPlatformName {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  if (t === 'wechat' || t === 'crazygames') return t;
  if ((WEB_PORTAL_TARGETS as readonly string[]).includes(t)) return t as WebPortalTarget;
  return 'web';
}
