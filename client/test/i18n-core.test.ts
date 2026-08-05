// Regression coverage for i18n/index.ts itself (detectLocale/initI18n/setLocale/t/onLocaleChange).
// Previously zero coverage: i18n.test.ts / i18n-t.test.ts only exercise the translation
// dictionaries (equipment affix completeness / param interpolation), never this module's own
// locale-resolution, persistence, or listener logic.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectLocale,
  initI18n,
  getLocale,
  getSupportedLocales,
  setLocale,
  onLocaleChange,
  t,
} from '../src/i18n';
import type { IStorage } from '../src/platform/IPlatform';

function memStore(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('detectLocale', () => {
  it('maps platform language tags to a supported locale by prefix (case-insensitive)', () => {
    expect(detectLocale('zh-CN')).toBe('zh');
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale('de-DE')).toBe('de');
    expect(detectLocale('ZH-hans')).toBe('zh');
  });

  it('falls back to the first allowed locale for an unrecognized tag', () => {
    expect(detectLocale('fr-FR')).toBe('zh'); // ALL_LOCALES[0]
    expect(detectLocale(null)).toBe('zh');
    expect(detectLocale(undefined)).toBe('zh');
  });

  it('never returns a locale outside the allowed set, even if the tag matches it', () => {
    // Platform only offers 'zh' (e.g. WeChat build) — an 'en-US' tag must not leak through.
    expect(detectLocale('en-US', ['zh'])).toBe('zh');
    expect(detectLocale('de-DE', ['en', 'zh'])).toBe('en'); // unmatched allowed tag → first allowed
  });
});

describe('initI18n', () => {
  it('priority: a supported saved choice wins over the platform language', () => {
    const store = memStore();
    store.setItem('nw_locale', 'de');
    initI18n('en-US', store, ['zh', 'en', 'de']);
    expect(getLocale()).toBe('de');
  });

  it('falls back to the platform language when there is no saved choice', () => {
    initI18n('de-DE', memStore(), ['zh', 'en', 'de']);
    expect(getLocale()).toBe('de');
  });

  it('ignores a saved choice that is no longer in the supported set for this platform', () => {
    const store = memStore();
    store.setItem('nw_locale', 'en');
    initI18n('zh-CN', store, ['zh']); // WeChat-style build: only 'zh' offered
    expect(getLocale()).toBe('zh');
  });

  it('exposes the platform-provided supported set via getSupportedLocales()', () => {
    initI18n('en-US', memStore(), ['zh', 'en']);
    expect(getSupportedLocales()).toEqual(['zh', 'en']);
  });

  it('defaults to ALL_LOCALES when no supported list is given', () => {
    initI18n('en-US', memStore());
    expect(getSupportedLocales()).toEqual(['zh', 'en', 'de']);
  });
});

describe('setLocale', () => {
  beforeEach(() => {
    initI18n('zh-CN', memStore(), ['zh', 'en', 'de']);
  });

  it('switches the active locale and persists the choice', () => {
    const store = memStore();
    initI18n('zh-CN', store, ['zh', 'en', 'de']);
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(store.getItem('nw_locale')).toBe('en');
  });

  it('notifies subscribers exactly once per real switch', () => {
    const seen: string[] = [];
    const unsub = onLocaleChange((l) => seen.push(l));
    setLocale('en');
    setLocale('de');
    unsub();
    expect(seen).toEqual(['en', 'de']);
  });

  it('is a no-op (no persistence, no notification) when the locale is unsupported on this platform', () => {
    const store = memStore();
    initI18n('zh-CN', store, ['zh']); // only zh offered
    const seen: string[] = [];
    const unsub = onLocaleChange((l) => seen.push(l));
    setLocale('en');
    unsub();
    expect(getLocale()).toBe('zh');
    expect(store.getItem('nw_locale')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('is a no-op when switching to the already-current locale (no redundant notification)', () => {
    const seen: string[] = [];
    const unsub = onLocaleChange((l) => seen.push(l));
    setLocale('zh'); // already current after the beforeEach initI18n
    unsub();
    expect(seen).toEqual([]);
  });

  it('onLocaleChange returns an unsubscribe function that actually stops delivery', () => {
    const seen: string[] = [];
    const unsub = onLocaleChange((l) => seen.push(l));
    setLocale('en');
    unsub();
    setLocale('de');
    expect(seen).toEqual(['en']); // the 'de' switch was not delivered after unsubscribing
  });
});

describe('t()', () => {
  beforeEach(() => {
    initI18n('en-US', memStore(), ['zh', 'en', 'de']);
  });

  it('translates using the active locale', () => {
    expect(t('hud.upgradeCost', { cost: 30 })).toBe('↑ 30g');
  });

  it('falls back to the raw key itself for a key present in no dictionary, so a missing translation never crashes rendering', () => {
    // TranslationKey is derived from zh (locales/en.ts/de.ts type-check as Record<TranslationKey,
    // string>), so real dictionaries can never actually diverge in which keys they define — the
    // `DICTS.zh[key]` middle fallback is defensive, not reachable via real content. What *is*
    // reachable, and what this exercises, is the outer "the key exists nowhere" → return the raw
    // key path (e.g. a key removed from the dict but still referenced by stale code).
    const bogusKey = 'this.key.does.not.exist.anywhere' as unknown as Parameters<typeof t>[0];
    expect(t(bogusKey)).toBe(bogusKey);
  });

  it('does not rescan substituted text for further placeholders (2026-08-03 fix)', () => {
    // A player-controlled display name containing literal "{cost}" must not be treated as a
    // template placeholder and get re-substituted.
    expect(t('hud.upgradeCost', { cost: '{cost}' })).toBe('↑ {cost}g');
  });

  it('leaves an unmatched placeholder untouched when its param is not supplied', () => {
    expect(t('hud.upgradeCost', {})).toBe('↑ {cost}g');
  });

  it('returns the raw string unchanged when no params are given at all', () => {
    initI18n('en-US', memStore(), ['zh', 'en', 'de']);
    // A key with no placeholders — params omitted entirely takes the early-return path.
    expect(t('hud.upgradeCost')).toBe('↑ {cost}g');
  });
});
