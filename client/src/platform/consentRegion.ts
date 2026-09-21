/**
 * consentRegion — the coarse "does this player get a real analytics choice?" test behind the
 * consent gate's two shapes (COMPLIANCE_GLOBAL §3.3 "按地区粗判", ANALYTICS_DESIGN §3.6c).
 *
 * Two different legal bases are bundled into one first-launch screen, and only one of them may be
 * a hard gate:
 *
 *  * **Terms + privacy policy** — contract necessity (GDPR Art 6(1)(b)). Declining means declining
 *    to play, everywhere. That is the single-button dialog.
 *  * **Analytics** — a non-essential purpose that can only rest on consent, and consent is not
 *    "freely given" when access is conditional on it (Art 7(4), Recital 43). Where that applies the
 *    player gets two buttons and *both* of them enter the game.
 *
 * Outside those jurisdictions the game asks for acceptance only. It deliberately does NOT show a
 * second button it would then ignore: a choice that is presented and discarded is worse than no
 * choice — it contradicts whatever the privacy policy and the store data-safety forms say.
 *
 * ## Why the timezone and not an IP lookup
 *
 * The obvious signal is the client IP, which only the server sees. But nothing on the boot path can
 * carry the answer in time: `GET /analytics/config` is fired and forgotten (`analytics.init()` is
 * `void`-called in createAppCore), the gates run immediately after, and analyticsvc sits behind
 * Caddy — no `CF-IPCountry`, so a country would mean shipping and updating a GeoIP database for one
 * boolean. The IANA timezone is free, synchronous, offline, and available before the first frame.
 * It is wrong for a traveller or a VPN, which is exactly the precision "粗判" promises; if this ever
 * needs to be right rather than close, the upgrade is a country on the config response plus a
 * short await here, not a different signal.
 *
 * ## Which way the errors point
 *
 * Every judgment call below is biased towards showing the choice. Showing it to someone who is not
 * covered costs one tap and some analytics volume; withholding it from someone who is covered is
 * the compliance failure this file exists to prevent. Hence `Europe/*` wholesale rather than an
 * EEA-member allowlist (Europe/Moscow and Europe/Istanbul get the choice, and that is fine), and
 * hence an unreadable timezone counting as covered.
 */
import { clientPlatformName } from '../app/appConstants';

/**
 * Non-`Europe/` zones whose countries are in the EEA, plus the one EU member filed under `Asia/`.
 * Cyprus is listed under both prefixes by the tz database depending on vintage — `Europe/Nicosia`
 * is the current name and is already covered by the prefix rule, `Asia/Nicosia` is the old alias
 * some runtimes still report.
 */
const EEA_OUTLIER_ZONES: ReadonlySet<string> = new Set([
  'Atlantic/Azores',     // Portugal
  'Atlantic/Madeira',    // Portugal
  'Atlantic/Canary',     // Spain
  'Atlantic/Faroe',      // Denmark
  'Atlantic/Reykjavik',  // Iceland (EEA)
  'Asia/Nicosia',        // Cyprus (legacy alias of Europe/Nicosia)
  'Asia/Famagusta',      // Cyprus
]);

/**
 * US zones, listed rather than matched by an `America/` prefix: that prefix also covers Canada and
 * all of Latin America, whose analytics would then be dropped for no legal reason. Includes the
 * legacy `US/*` aliases, which older runtimes (and a few Linux images) still resolve to.
 */
const US_ZONES: ReadonlySet<string> = new Set([
  'America/New_York', 'America/Detroit', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'America/Juneau',
  'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome',
  'America/Adak', 'America/Boise', 'America/Menominee',
  'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
  'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Vevay',
  'America/Indiana/Tell_City', 'America/Indiana/Knox',
  'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
  'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
  'America/North_Dakota/Beulah',
  'Pacific/Honolulu',
  'US/Eastern', 'US/Central', 'US/Mountain', 'US/Pacific', 'US/Alaska', 'US/Hawaii',
  'US/Arizona', 'US/East-Indiana', 'US/Indiana-Starke', 'US/Michigan', 'US/Aleutian',
]);

/** The player's IANA timezone, or '' when the runtime has no usable `Intl` (see `needsConsentChoice`). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * True when the consent gate must offer "accept all" *and* "essentials only", both of which enter
 * the game; false when it shows the accept-only dialog.
 *
 * The WeChat mini-game is excluded outright: it is a mainland-China channel, and the platform runs
 * its own mandatory privacy authorisation before ours, so a second choice screen there would be
 * both redundant and answering a question nobody asked.
 */
export function needsConsentChoice(): boolean {
  if (clientPlatformName() === 'wechat') return false;
  const tz = timeZone();
  if (tz === '') return true; // unreadable → assume covered (see header)
  if (tz.startsWith('Europe/')) return true;
  return EEA_OUTLIER_ZONES.has(tz) || US_ZONES.has(tz);
}
