// Constraints on the equipped-title short label (`title.*.short`), the one string that gets
// stamped into name tags, leaderboard rows, the result screen and the profile popup.
//
// TITLE_DESIGN §6 budgets it at ≤4 characters and §6's checklist carried an unimplemented
// "truncate in the UI" item for months, during which en/de copy drifted to 5-9 characters
// (`Conqueror`, `Rangliste`). Closed 2026-08-16 by shortening the copy instead of slicing at
// runtime — a chosen `Rang` reads better than a hard cut, but only if something keeps the next
// translator inside the budget. That is this file.
//
// The budget is stated in characters because that is what a translator can check, and here it is
// also literally a width budget: sketchUi's txt() renders monospace, so width is exactly
// proportional to character count. leaderboardRowGeometry.test.ts consumes that fact when it
// asserts the row's column clearances.
import { describe, it, expect } from 'vitest';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

const LOCALES = Object.entries({ zh, en, de }) as Array<[string, Record<string, string>]>;
const shortKeys = (d: Record<string, string>): string[] =>
  Object.keys(d).filter((k) => k.startsWith('title.') && k.endsWith('.short'));

describe('title short labels', () => {
  it('the scan found the short labels at all', () => {
    // Canary: every assertion below is a filter-then-assert-empty, which passes vacuously if the
    // key naming ever changes and the filter stops matching.
    expect(shortKeys(zh).length).toBeGreaterThanOrEqual(7);
  });

  for (const [locale, dict] of LOCALES) {
    it(`${locale}: every short label is within the ≤4-character budget`, () => {
      const over = shortKeys(dict)
        .map((k) => [k, [...dict[k]!].length] as const)
        .filter(([, n]) => n > 4)
        .map(([k, n]) => `${k} (${n}: "${dict[k]}")`);
      expect(over).toEqual([]);
    });

    it(`${locale}: no short label is blank`, () => {
      // A blank one renders as an empty 「」 bracket pair with nothing inside — worse than a long
      // label, because the row still spends the space and the player learns nothing.
      expect(shortKeys(dict).filter((k) => dict[k]!.trim() === '')).toEqual([]);
    });

    it(`${locale}: short labels are distinct — two titles must not read identically`, () => {
      // The short label is the *only* thing distinguishing one equipped title from another in a
      // name tag; duplicates make two different achievements indistinguishable in chat and on the
      // ladder. This is the constraint that killed a `Top1`/`Top3` pair for champion/top3 (one
      // character apart, and one of them abbreviating a word the other spelled literally) in
      // favour of `Chmp`/`Top3`.
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const k of shortKeys(dict)) {
        const v = dict[k]!;
        const prev = seen.get(v);
        if (prev) clashes.push(`"${v}" used by both ${prev} and ${k}`);
        else seen.set(v, k);
      }
      expect(clashes).toEqual([]);
    });
  }

  it('every title with a full name also has a short label, and vice versa', () => {
    // Both halves are read from the same TitleDef, so a title that ships only one of them renders
    // the raw key on whichever surface wants the other.
    const unpaired: string[] = [];
    for (const [locale, dict] of LOCALES) {
      const stems = (suffix: string): Set<string> =>
        new Set(
          Object.keys(dict)
            .filter((k) => k.startsWith('title.') && k.endsWith(suffix))
            .map((k) => k.slice('title.'.length, -suffix.length)),
        );
      const fulls = stems('.full');
      const shorts = stems('.short');
      for (const s of fulls) if (!shorts.has(s)) unpaired.push(`${locale}: title.${s}.full has no .short`);
      for (const s of shorts) if (!fulls.has(s)) unpaired.push(`${locale}: title.${s}.short has no .full`);
    }
    expect(unpaired).toEqual([]);
  });
});
