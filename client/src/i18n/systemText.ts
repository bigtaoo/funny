/**
 * systemText.ts — resolve a server-authored system string that is really an i18n key.
 *
 * System mail and system chat announcements are the one place where the *server* picks the i18n key
 * and the client only resolves it: worldsvc/metaserver write `slg.city.captured|level=3|x=12|y=34`,
 * and the language is chosen here, at render time. Player-authored text (friend/family/world chat,
 * mail between players) travels the same fields as plain prose, so this has to be a no-op for
 * anything that is not a known key — hence the `t()`-echoes-the-key fallback below.
 *
 * Wire format: `key` or `key|name=value|name2=value2`.
 * Params are strictly `name=value`; a pipe segment without an `=` is dropped, so the server must
 * never send positional params (see combatSiege/cityDamage.ts, which used to).
 */
import { t, type TranslationKey } from './index';

export function systemText(raw: string): string {
  const [key, ...paramParts] = raw.split('|');
  const k = key as TranslationKey;
  if (paramParts.length === 0) {
    const s = t(k);
    return s === key ? raw : s;
  }
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const s = t(k, params);
  return s === key ? raw : s; // key missing → t() returns the bare key; fall back to the raw string
}
