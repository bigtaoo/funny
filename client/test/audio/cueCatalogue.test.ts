// The catalogue is data, so what it needs guarding are the INVARIANTS the mix decisions rest on
// (AUDIO_DESIGN.md §4) — not that the numbers are what they are today. Every case below fails on
// a real regression and stays green on a deliberate re-tune.
//
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { CUE_CATALOGUE, ALL_CUES, cuesWithSamples } from '../../src/audio/cueCatalogue';
import { CUE_ASSETS, variantUrls, variantCount, allSfxUrls } from '../../src/audio/cueAssets';
import type { AudioCue } from '../../src/audio/types';

const UI_CUES = ALL_CUES.filter((c) => c.startsWith('sfx.ui.'));
const RESULT_CUES = ALL_CUES.filter((c) => c.startsWith('sfx.result.'));
const BATTLE_CUES = ALL_CUES.filter((c) => !c.startsWith('sfx.ui.') && !c.startsWith('sfx.result.'));

describe('cue catalogue', () => {
  it('covers every cue exactly once, with nothing empty', () => {
    // ALL_CUES is derived from the Record, so this guards the derivation (and catches a cue
    // accidentally declared twice, which TS allows for a string-literal key in some shapes).
    expect(ALL_CUES.length).toBe(new Set(ALL_CUES).size);
    expect(ALL_CUES.length).toBeGreaterThanOrEqual(17);
    for (const cue of ALL_CUES) expect(CUE_CATALOGUE[cue]).toBeDefined();
  });

  it('every gain and priority is in a usable range', () => {
    for (const cue of ALL_CUES) {
      const def = CUE_CATALOGUE[cue];
      // A gain of 0 is a cue that silently does nothing — indistinguishable from broken audio,
      // and the way to disable a cue is to stop firing it, not to zero its gain.
      expect(def.gain, cue).toBeGreaterThan(0);
      // Above ~1.5 a single voice starts clipping the bus once the settings volume is at 1.0.
      expect(def.gain, cue).toBeLessThanOrEqual(1.5);
      expect(Number.isFinite(def.priority), cue).toBe(true);
      expect(def.priority, cue).toBeGreaterThan(0);
    }
  });

  it('UI cues outrank every battle cue (a silent press reads as a missed input)', () => {
    // AUDIO_DESIGN.md §4: the cue the player caused by pressing a button must not be the one the
    // voice cap drops. This is the invariant that made daydayup's UI pass survive its mutation
    // run — dropping the UI priority to a combat-level number broke nothing else observable.
    const worstUi = Math.min(...UI_CUES.map((c) => CUE_CATALOGUE[c].priority));
    const bestBattle = Math.max(...BATTLE_CUES.map((c) => CUE_CATALOGUE[c].priority));
    expect(UI_CUES.length).toBeGreaterThanOrEqual(7);
    expect(worstUi).toBeGreaterThan(bestBattle);
  });

  it('result stingers outrank everything — one per match, nothing may steal them', () => {
    const worstResult = Math.min(...RESULT_CUES.map((c) => CUE_CATALOGUE[c].priority));
    const others = ALL_CUES.filter((c) => !RESULT_CUES.includes(c));
    // Three since 2026-08-31: a draw got its own stinger (AUDIO_DESIGN.md §7 step 6). The count is
    // pinned rather than derived so that adding a fourth "outcome" is a deliberate edit here — this
    // is the one priority tier that must stay unstealable, so it should not grow by accident.
    expect(RESULT_CUES).toHaveLength(3);
    for (const cue of others) {
      expect(CUE_CATALOGUE[cue].priority, cue).toBeLessThan(worstResult);
    }
  });

  it('the most-emitted battle cue is the cheapest to drop', () => {
    // sfx.unit.attack fires once per unit per attack; at the cap it is the one that should lose.
    const attack = CUE_CATALOGUE['sfx.unit.attack'];
    for (const cue of BATTLE_CUES.filter((c) => c !== 'sfx.unit.attack' && c !== 'sfx.ink.tick')) {
      expect(CUE_CATALOGUE[cue].priority, cue).toBeGreaterThan(attack.priority);
    }
    // …and it must not also be the loudest thing in the mix.
    expect(attack.gain).toBeLessThan(CUE_CATALOGUE['sfx.base.hit'].gain);
  });

  it('a refused action is at least as prominent as a successful one', () => {
    // AUDIO_DESIGN.md's own reason for having sfx.card.invalid / sfx.ui.error at all: reporting
    // "that did nothing" must not be quieter than reporting "that worked", or the two are
    // indistinguishable from a dropped input.
    expect(CUE_CATALOGUE['sfx.card.invalid'].priority).toBeGreaterThanOrEqual(
      CUE_CATALOGUE['sfx.card.play'].priority,
    );
    expect(CUE_CATALOGUE['sfx.ui.error'].priority).toBeGreaterThanOrEqual(
      CUE_CATALOGUE['sfx.ui.tap'].priority,
    );
  });
});

describe('cue assets', () => {
  it('declares no url for a cue outside the union', () => {
    // Partial<Record<AudioCue, …>> makes a bad key a compile error; this catches a key added
    // through a cast, and keeps the runtime honest for anything built from Object.keys.
    for (const key of Object.keys(CUE_ASSETS)) {
      expect(ALL_CUES, key).toContain(key as AudioCue);
    }
  });

  it('variantUrls / variantCount agree, and are empty for an unshipped cue', () => {
    for (const cue of ALL_CUES) {
      expect(variantCount(cue), cue).toBe(variantUrls(cue).length);
    }
    // Today: no audio assets exist yet (see cueAssets.ts) — so the whole set is synth-only and
    // the loader has nothing to load. This assertion is the honest record of that state; when
    // the first files land it fails and gets updated to the real count, which is exactly the
    // moment someone should be re-reading this file.
    expect(allSfxUrls()).toEqual([]);
    expect(cuesWithSamples()).toEqual([]);
  });

  it('every declared url is unique (two cues sharing a file is a copy-paste slip)', () => {
    const urls = allSfxUrls();
    expect(urls.length).toBe(new Set(urls).size);
  });
});
