// Unit tests for chatFilter.ts: locale/Accept-Language → region mapping and region-aware masking
// (SOC2/SOC10). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  REGION_WORDLISTS,
  regionFromLocale,
  regionFromAcceptLanguage,
  censorChat,
  normalizeForFilter,
  sanitizeWordlistOverrideDoc,
  WordlistCache,
} from '../src/chatFilter';

// ── region mapping ────────────────────────────────────────────────────────────────

describe('regionFromLocale', () => {
  it('maps known primary subtags', () => {
    expect(regionFromLocale('zh-CN')).toBe('cn');
    expect(regionFromLocale('de-DE')).toBe('de');
    expect(regionFromLocale('en-US')).toBe('en');
  });

  it('is case-insensitive and tolerates underscores', () => {
    expect(regionFromLocale('ZH_hans')).toBe('cn');
  });

  it('falls back to global for unknown or empty', () => {
    expect(regionFromLocale('fr-FR')).toBe('global');
    expect(regionFromLocale('')).toBe('global');
    expect(regionFromLocale(null)).toBe('global');
    expect(regionFromLocale(undefined)).toBe('global');
  });
});

describe('regionFromAcceptLanguage', () => {
  it('picks the highest q-value language', () => {
    expect(regionFromAcceptLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
  });

  it('respects explicit q ordering regardless of position', () => {
    expect(regionFromAcceptLanguage('en;q=0.3,zh;q=0.9')).toBe('cn');
  });

  it('ignores wildcards and blanks', () => {
    expect(regionFromAcceptLanguage('*')).toBe('global');
    expect(regionFromAcceptLanguage('')).toBe('global');
    expect(regionFromAcceptLanguage(null)).toBe('global');
  });

  it('defaults q to 1 when unspecified', () => {
    expect(regionFromAcceptLanguage('en,zh;q=0.5')).toBe('en');
  });
});

// ── censorChat ────────────────────────────────────────────────────────────────────

describe('censorChat', () => {
  it('passes through clean text unchanged with hit=false', () => {
    const res = censorChat('hello there friend');
    expect(res.hit).toBe(false);
    expect(res.text).toBe('hello there friend');
  });

  it('masks a global word and reports a hit', () => {
    const res = censorChat('what the fuck');
    expect(res.hit).toBe(true);
    expect(res.text).toBe('what the ****');
  });

  it('is case-insensitive but preserves surrounding text', () => {
    const res = censorChat('SHIT happens');
    expect(res.hit).toBe(true);
    expect(res.text).toBe('**** happens'); // 4 chars masked, same length
  });

  it('masks URLs (scam/phishing) via the global list', () => {
    const res = censorChat('visit http://evil.co now');
    expect(res.hit).toBe(true);
    expect(res.text.startsWith('visit *******')).toBe(true);
  });

  it('applies region overlay only for the matching region', () => {
    const cn = censorChat('买 外挂', 'cn');
    expect(cn.hit).toBe(true);
    expect(cn.text).toContain('**');
    // the same cn word is not in the default global list
    const glob = censorChat('买 外挂', 'global');
    expect(glob.hit).toBe(false);
  });

  it('masked output has the same length as the input (position-preserving)', () => {
    const input = 'shit and fuck';
    const res = censorChat(input);
    expect(res.text).toHaveLength(input.length);
  });

  it('handles multiple occurrences of the same word', () => {
    const res = censorChat('shit shit');
    expect(res.text).toBe('**** ****');
  });

  it('returns empty text unchanged', () => {
    expect(censorChat('')).toEqual({ text: '', hit: false });
  });

  it('every region word list is non-empty and lowercase', () => {
    for (const [, words] of Object.entries(REGION_WORDLISTS)) {
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) expect(w).toBe(w.toLowerCase());
    }
  });
});

// ── normalizeForFilter (CM1) ────────────────────────────────────────────────────────

describe('normalizeForFilter', () => {
  it('folds fullwidth Latin letters to halfwidth', () => {
    expect(normalizeForFilter('ｆｕｃｋ')).toBe('fuck');
  });

  it('drops zero-width characters', () => {
    const withZeroWidth = 'f​u‌c‍k﻿';
    expect(normalizeForFilter(withZeroWidth)).toBe('fuck');
  });

  it('strips common evasion separators but not plain spaces', () => {
    expect(normalizeForFilter('f.u.c.k')).toBe('fuck');
    expect(normalizeForFilter('f_u-c*k')).toBe('fuck');
    expect(normalizeForFilter('fu ck')).toBe('fu ck'); // spaces preserved — see file header rationale
  });

  it('folds common Latin leetspeak substitutions', () => {
    expect(normalizeForFilter('$h17')).toBe('shit');
  });
});

// ── censorChat: normalized-pass fallback (CM1/CM2) ─────────────────────────────────

describe('censorChat normalized-pass fallback', () => {
  it('catches symbol-inserted evasion and masks the whole message', () => {
    const res = censorChat('say f.u.c.k now');
    expect(res.hit).toBe(true);
    expect(res.text).toBe('*'.repeat('say f.u.c.k now'.length));
  });

  it('catches fullwidth evasion', () => {
    const res = censorChat('ｆｕｃｋ you');
    expect(res.hit).toBe(true);
  });

  it('catches leetspeak evasion', () => {
    const res = censorChat('you are an a55h0le', 'en');
    expect(res.hit).toBe(true);
  });

  it('raw-pass hits still use exact per-word masking (unaffected by the fallback)', () => {
    const res = censorChat('what the fuck');
    expect(res.text).toBe('what the ****');
  });
});

// ── WordlistCache (CM3: additive DB overlay on top of code defaults) ───────────────

describe('WordlistCache', () => {
  it('overlays fetched words on top of the code-default list, additively', async () => {
    const cache = new WordlistCache({
      fetchAll: async () => [{ _id: 'de', words: ['testverbot'], updatedAt: 1, updatedBy: 'admin1' }],
    });
    await cache.refresh();
    expect(cache.hasLoaded).toBe(true);
    const hitOverlay = censorChat('das ist testverbot', 'de', cache);
    expect(hitOverlay.hit).toBe(true);
    const stillHitsBuiltin = censorChat('scheisse', 'de', cache);
    expect(stillHitsBuiltin.hit).toBe(true); // built-in floor still active alongside the overlay
  });

  it('does not overlay other regions', async () => {
    const cache = new WordlistCache({
      fetchAll: async () => [{ _id: 'de', words: ['testverbot'], updatedAt: 1, updatedBy: 'admin1' }],
    });
    await cache.refresh();
    expect(censorChat('testverbot', 'en', cache).hit).toBe(false);
  });

  it('degrades gracefully on fetch failure, keeping the last good cache', async () => {
    let fail = false;
    const cache = new WordlistCache({
      fetchAll: async () => {
        if (fail) throw new Error('admin unreachable');
        return [{ _id: 'en', words: ['zzztestword'], updatedAt: 1, updatedBy: 'admin1' }];
      },
    });
    await cache.refresh();
    expect(censorChat('zzztestword', 'en', cache).hit).toBe(true);
    fail = true;
    await cache.refresh(); // throws internally, swallowed
    expect(censorChat('zzztestword', 'en', cache).hit).toBe(true); // stale cache retained
  });

  it('never fetched → empty overlay, built-in floor still enforced', () => {
    const cache = new WordlistCache({ fetchAll: async () => [] });
    expect(cache.hasLoaded).toBe(false);
    expect(censorChat('shit', 'global', cache).hit).toBe(true);
  });
});

describe('sanitizeWordlistOverrideDoc', () => {
  it('accepts a well-formed doc', () => {
    const doc = sanitizeWordlistOverrideDoc({ _id: 'cn', words: ['测试'], updatedAt: 123, updatedBy: 'ops1' });
    expect(doc).toEqual({ _id: 'cn', words: ['测试'], updatedAt: 123, updatedBy: 'ops1' });
  });

  it('rejects an unknown region id', () => {
    expect(sanitizeWordlistOverrideDoc({ _id: 'fr', words: ['x'] })).toBeNull();
  });

  it('drops non-string entries from words instead of throwing', () => {
    const doc = sanitizeWordlistOverrideDoc({ _id: 'en', words: ['ok', 42, null, 'also-ok'] });
    expect(doc?.words).toEqual(['ok', 'also-ok']);
  });

  it('rejects non-object input', () => {
    expect(sanitizeWordlistOverrideDoc(null)).toBeNull();
    expect(sanitizeWordlistOverrideDoc('nope')).toBeNull();
  });
});
