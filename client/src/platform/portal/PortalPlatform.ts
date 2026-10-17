import type { Locale } from '../../i18n';
import type { IapKind } from '../iap';
import { WebPlatform } from '../web/WebPlatform';

/**
 * Self-test web-portal builds — itch.io and Newgrounds (design/game/WEB_PORTALS.md).
 *
 * The same guest shape as the CrazyGames build, minus any portal SDK: no login screen (a device
 * account is created silently), a non-blocking Terms/Privacy notice instead of an entry gate, free PvE
 * entries, and no commerce at all. Which portal it is travels in the TARGET global, not here, so
 * both portals share this class and every analytics/server counter still sees them apart.
 */
export class PortalPlatform extends WebPlatform {
  // English first: i18n falls back to the first entry, and both portals' audiences are English-first.
  override readonly supportedLocales: readonly Locale[] = ['en', 'de', 'zh'];
  readonly silentAccountOnly = true;
  readonly entryNoticeOnly = true;
  readonly freePveStamina = true;

  /** No recharge on a portal: every shop entry point is gated on a non-null kind. */
  override iapKind(): IapKind | null {
    return null;
  }
}
