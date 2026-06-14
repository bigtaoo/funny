import { zh, TranslationKey } from './locales/zh';
import { en } from './locales/en';
import { de } from './locales/de';
import type { IStorage } from '../platform/IPlatform';

export type { TranslationKey };
export type Locale = 'zh' | 'en' | 'de';

const DICTS: Record<Locale, Record<TranslationKey, string>> = { zh, en, de };
const STORAGE_KEY = 'nw_locale';

/** All locales the game has translations for. Platforms expose a subset. */
export const ALL_LOCALES: readonly Locale[] = ['zh', 'en', 'de'];

let current: Locale = 'zh';
/** Locales the current platform actually offers (defaults to everything). */
let supported: readonly Locale[] = ALL_LOCALES;
let storage: IStorage | null = null;
const listeners = new Set<(locale: Locale) => void>();

/**
 * Maps a raw platform language tag (e.g. "zh-CN", "en-US", "de-DE") to a
 * supported locale. Falls back to the first supported locale (never to an
 * unsupported one — e.g. a WeChat build that only ships Chinese).
 */
export function detectLocale(
  raw: string | null | undefined,
  allowed: readonly Locale[] = ALL_LOCALES,
): Locale {
  const tag = (raw ?? '').toLowerCase();
  const prefixes: Array<[string, Locale]> = [['zh', 'zh'], ['de', 'de'], ['en', 'en']];
  for (const [prefix, locale] of prefixes) {
    if (tag.startsWith(prefix) && allowed.includes(locale)) return locale;
  }
  return allowed[0] ?? 'en';
}

/**
 * Initialize i18n at boot, before any scene is built.
 * `supportedLocales` is the set the platform offers (e.g. WeChat → ['zh']).
 * Priority: player's saved choice (if still supported) > platform language > first supported.
 */
export function initI18n(
  platformLanguage: string,
  store?: IStorage,
  supportedLocales: readonly Locale[] = ALL_LOCALES,
): void {
  storage   = store ?? null;
  supported = supportedLocales.length > 0 ? supportedLocales : ALL_LOCALES;

  const saved = storage?.getItem(STORAGE_KEY) as Locale | null;
  current = saved && supported.includes(saved)
    ? saved
    : detectLocale(platformLanguage, supported);
}

export function getLocale(): Locale {
  return current;
}

/** Locales available for the player to switch between on this platform. */
export function getSupportedLocales(): readonly Locale[] {
  return supported;
}

/**
 * Switch language at runtime; persists the choice and notifies listeners.
 * Ignored if the locale isn't supported on this platform.
 */
export function setLocale(locale: Locale): void {
  if (locale === current || !supported.includes(locale)) return;
  current = locale;
  storage?.setItem(STORAGE_KEY, locale);
  listeners.forEach((fn) => fn(locale));
}

/**
 * Subscribe to locale changes (e.g. a scene re-rendering its texts).
 * Returns an unsubscribe function.
 */
export function onLocaleChange(fn: (locale: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate a key, with optional `{param}` interpolation:
 *   t('hud.upgradeCost', { cost: 30 }) → '↑ 30g'
 * Falls back to zh, then to the key itself, so a missing translation
 * never crashes rendering.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? DICTS.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
