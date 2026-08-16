// Placeholder parity across zh/en/de (2026-08-15).
//
// Key parity is already compile-enforced — en.ts/de.ts are `Record<TranslationKey, string>`, so a
// missing or extra key fails `tsc`. What tsc cannot see is the *inside* of the string: `t()` only
// substitutes the `{name}` placeholders a translation actually contains (see i18n/index.ts), so a
// translation that drops one silently renders without the number/name it was supposed to carry —
// "Sold for {coins} coins" translated as "Verkauft" loses the amount, in one locale only, with no
// type error, no crash, and no failing test. Only a player switching to that locale would notice.
//
// This spec pins the invariant the type system can't: every key carries the same placeholder SET in
// all three locales. Order and repetition are deliberately not checked — word order legitimately
// differs between Chinese, English and German, and a placeholder may appear twice in one phrasing
// and once in another; what must not change is *which* params a phrasing consumes.
import { describe, it, expect } from 'vitest';
import { zh, type TranslationKey } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

/** Distinct `{param}` names in a translation, sorted — mirrors i18n/index.ts's substitution regex. */
function placeholders(s: string): string[] {
  return [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
}

describe('i18n placeholder parity (zh/en/de)', () => {
  it('every key consumes the same set of {params} in all three locales', () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(zh) as TranslationKey[]) {
      const want = placeholders(zh[key]);
      for (const [locale, dict] of [['en', en], ['de', de]] as const) {
        const got = placeholders(dict[key]);
        if (got.join(',') !== want.join(',')) {
          mismatches.push(`${key}: zh {${want.join(',')}} vs ${locale} {${got.join(',')}}`);
        }
      }
    }
    // One assertion over the whole dictionary so a failure lists every offending key at once.
    expect(mismatches).toEqual([]);
  });

  it('no translation contains a placeholder that zh never declared (typo guard, e.g. {coin} for {coins})', () => {
    const unknown: string[] = [];
    for (const key of Object.keys(zh) as TranslationKey[]) {
      const declared = new Set(placeholders(zh[key]));
      for (const [locale, dict] of [['en', en], ['de', de]] as const) {
        for (const p of placeholders(dict[key])) {
          // A param zh never uses is never passed by the call site either, so `t()` leaves the raw
          // "{p}" braces in the rendered string (i18n-core.test.ts pins that leave-untouched behavior).
          if (!declared.has(p)) unknown.push(`${key}: ${locale} uses {${p}}, zh does not`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
