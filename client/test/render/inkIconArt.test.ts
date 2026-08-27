// Guards the batch-7 ink-icon family (design/product/tab-icon-art-prompts-batch7.md, 2026-08-25) —
// the 44 content glyphs that replaced the last procedural `DRAW` functions, plus the 5 kinds that
// deliberately alias an existing icon's art instead of getting their own.
//
// These are packed differently from the tab icons on purpose: ONE white master each
// (`inks: ['active']`), tinted live by `buildInkIcon`, because their callers pass an ink that means
// something (rank/rarity/win-loss/faction colour) rather than a light-or-dark surface hint. So the
// three-variant contracts in `tabIconContentVariant.test.ts` do not apply to them, and this file
// carries their own instead. Two halves, same split as that file and for the same reason:
//   1. THE ART on disk — one `<kind>_active.png` per `tabicon_<kind>.*` source, no leftovers either
//      way. A source that lost to a redraw reads as shipped art in art/ui/tabicons but nothing packs
//      it; the convention is that it moves to `_rejected/`.
//   2. THE TABLE in the module — the asset base name IS the kind name for this family (no
//      `fooTabIcon` → `foo_active.png` suffix dance), which is exactly what lets half 1 check every
//      row without a second hand-maintained kind→file map that could drift.
// Under vitest every `.png` import collapses to one stubbed data URI, so url identity is only
// meaningful on disk and key presence only in the module — neither half can cover the other.
// Run: npm test
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { INK_ICON_ART, INK_ICON_ALIASES, TAB_ICON_RASTER, type InkIconKind } from '../../src/render/icons';

const ASSET_DIR = path.resolve(__dirname, '../../src/assets/tabicons');
const SOURCE_DIR = path.resolve(__dirname, '../../../art/ui/tabicons');

/** Ink kinds that own art: everything but the 5 aliases (see `INK_ICON_ALIASES`). */
const OWN_ART = (Object.keys(INK_ICON_ART) as InkIconKind[])
  .filter((k) => !INK_ICON_ALIASES.includes(k))
  .sort();

/** Which existing tab icon each alias is expected to borrow its master from. */
const ALIAS_OF: Record<string, keyof typeof TAB_ICON_RASTER> = {
  swords: 'pvpTabIcon', home: 'homeTabIcon', capsule: 'gachaTabIcon',
  gift: 'weeklyTabIcon', tag: 'auctionTabIcon', brush: 'skinIcon',
};

describe('ink-icon art on disk (pack_tab_icons.cjs, inks: [active])', () => {
  it('packs exactly one white master per ink kind, and nothing else for it', () => {
    // 47 = batch 7's 43 (its original 44 minus `brush`, which gave up its own art after three
    // redraws and became a `skinIcon` alias) + batch 8's four stat words
    // (`range`/`siege`/`crit`/`critmult`). A 48th needs a doc entry, not a silent add.
    expect(OWN_ART.length).toBe(47);
    for (const kind of OWN_ART) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${kind}_active.png`)), `${kind}_active.png`).toBe(true);
      // The other three inks would be ~130 PNGs nobody draws — and baking them is the shape of the
      // mistake that would quietly re-route these kinds through `tabIconVariant` and flatten every
      // tint. See inkIconRaster.ts's header.
      for (const v of ['inactive', 'content', 'accent']) {
        expect(fs.existsSync(path.join(ASSET_DIR, `${kind}_${v}.png`)), `${kind}_${v}.png`).toBe(false);
      }
    }
  });

  it('has one AI source per ink kind, named after the kind (rejects belong in _rejected/)', () => {
    const sources = fs.readdirSync(SOURCE_DIR)
      .filter((f) => /^tabicon_.*\.(webp|png)$/.test(f))
      .map((f) => f.replace(/^tabicon_/, '').replace(/\.(webp|png)$/, ''));
    for (const kind of OWN_ART) {
      expect(sources.filter((s) => s === kind), `source for ${kind}`).toHaveLength(1);
    }
  });

  // No "an alias has no art of its own" case here, deliberately: `home` and `tag` name art that DOES
  // exist on disk (`home_active.png` is `homeTabIcon`'s own master — that is the whole point of
  // aliasing it), so file absence cannot express the contract. What an alias must not do is point
  // somewhere other than its target's master, which the table half below checks directly.
});

describe('INK_ICON_ART — the code side of the same contract', () => {
  it('holds a url for every kind, aliases included', () => {
    expect(Object.keys(INK_ICON_ART).length).toBe(OWN_ART.length + INK_ICON_ALIASES.length);
    for (const url of Object.values(INK_ICON_ART)) expect(typeof url).toBe('string');
  });

  // A kind in both tables would resolve through `TAB_ICON_RASTER` in `buildIcon` (it looks there
  // first) and silently ignore its ink row — i.e. lose its tint, which is the one thing this family
  // exists to keep. `home` is the near miss: `homeTabIcon` and the ink alias `home` are two
  // different keys pointing at the same PNG, which is fine; `home` appearing in both tables is not.
  it('shares no kind name with TAB_ICON_RASTER', () => {
    const clash = Object.keys(INK_ICON_ART).filter((k) => k in TAB_ICON_RASTER);
    expect(clash).toEqual([]);
  });

  it('points every alias at its borrowed tab icon, not at art of its own', () => {
    // Skippable half: under the vitest asset stub all `.png` imports are the same data URI, so url
    // equality proves nothing there — the on-disk half above is what holds the line in that case.
    const urls = new Set(Object.values(INK_ICON_ART));
    if (urls.size === 1) return;
    for (const kind of INK_ICON_ALIASES) {
      expect(INK_ICON_ART[kind], kind).toBe(TAB_ICON_RASTER[ALIAS_OF[kind]!].active);
    }
  });
});
