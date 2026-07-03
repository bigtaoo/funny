// Unit tests for chatFilter.ts: locale/Accept-Language → region mapping and region-aware masking
// (SOC2/SOC10). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  REGION_WORDLISTS,
  regionFromLocale,
  regionFromAcceptLanguage,
  censorChat,
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
