// Integrity gates on the layout sweep's stop table (src/testing/layoutStops.ts).
//
// Both things checked here have already gone wrong once, silently, and neither is a failure the
// sweep itself can report — a broken stop does not fail the run, it audits the wrong picture or
// records itself unreachable, and the run still ends green.
//
//   1. Two stops sharing a report name overwrite each other's report slot and screenshot. That is
//      what happened to the social hub: three entry points all reported `screen: 'friends'`,
//      `friends.png` was whichever ran last, and two thirds of that scene went unaudited until
//      2026-09-11 (the STOPS comment above those three stops tells the story). The `as` field is
//      the fix; nothing was checking that new stops actually use it.
//   2. A `tap` hop is matched by its label's literal, parameter-free prefix — `raw.split('{')[0]`,
//      because the same table runs in three languages. A key whose value STARTS with a placeholder
//      truncates to the empty string, and `indexOf('')` is 0 on every label in the tree: the walk
//      would click whatever it reached last rather than fail. So the prefix has to be non-empty in
//      all three locales, not only in the one the author happened to read.
//
// Plain node, no PIXI and no browser: the table is data, and these are properties of the data.
// Run: npm test

import { describe, it, expect } from 'vitest';
import { STOPS, hopName } from '../src/testing/layoutStops';
import { zh, type TranslationKey } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

const DICTS: Record<string, Record<string, string>> = { zh, en, de };

/**
 * The literal prefix `tapLabel` can match on.
 *
 * Deliberately a copy of `test/browser/lib/walk.ts`'s `label()` rather than an import: that module
 * pulls Playwright in at load time (`./nwE2E` imports its `expect`), which this suite does not have
 * and should not grow a dependency on for two lines of string handling. If the runtime rule there
 * changes, this copy has to change with it — which is the point of pinning it.
 */
function prefix(dict: Record<string, string>, key: string): string {
  return (dict[key] ?? '').split('{')[0]!.trim();
}

describe('layoutStops STOPS table', () => {
  it('gives every stop its own report name', () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const stop of STOPS) {
      const name = stop.as ?? stop.screen;
      if (seen.has(name)) duplicated.push(name);
      seen.add(name);
    }
    expect(duplicated).toEqual([]);
  });

  it('gives every stop somewhere to go', () => {
    expect(STOPS.filter((s) => s.via.length === 0).map((s) => s.as ?? s.screen)).toEqual([]);
  });

  it('only taps labels with a non-empty literal prefix, in all three locales', () => {
    const broken: string[] = [];
    for (const stop of STOPS) {
      for (const hop of stop.via) {
        if (typeof hop !== 'object' || !('tap' in hop)) continue;
        const key: TranslationKey = hop.tap;
        for (const locale of Object.keys(DICTS)) {
          if (prefix(DICTS[locale]!, key) === '') {
            broken.push(`${stop.as ?? stop.screen}: ${hopName(hop)} has no prefix in ${locale}`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
