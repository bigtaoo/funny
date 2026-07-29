// Client-side X-Chat-Region resolution (CONTENT_MODERATION_DESIGN.md O-CM5).
//
// The server picks a chat-filter word list by ChatRegion ('global'|'cn'|'de'|'en'), read from the
// optional X-Chat-Region request header (defaults to 'global' when absent). The client has no
// account-level region field to send (AccountDoc.region is server-only, lazily inferred from
// Accept-Language at auth time) — the current i18n locale is the same proxy signal the server itself
// falls back to (server/shared/src/chatFilter.ts regionFromLocale), so we mirror that mapping here
// rather than depend on @nw/shared (a server-only package not built for the browser bundle).
import { getLocale, type Locale } from '../i18n';

export type ChatRegion = 'global' | 'cn' | 'de' | 'en';

const LOCALE_TO_REGION: Record<Locale, ChatRegion> = { zh: 'cn', de: 'de', en: 'en' };

/** Best-effort chat-filter region for the current player, derived from their active UI locale. */
export function currentChatRegion(): ChatRegion {
  return LOCALE_TO_REGION[getLocale()];
}
