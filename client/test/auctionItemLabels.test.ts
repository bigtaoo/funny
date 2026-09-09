// Coverage for `client/src/scenes/AuctionScene/itemLabels.ts` — the name/glyph/level helpers every
// AuctionScene panel (list rows, bid modal title, create-listing picker) renders a listing through.
//
// 0% until now, and not because nobody exercised it: `test/ui/auctionScene.ui.ts`,
// `auctionMaterialNames.ui.ts` and `auctionPickerDedupe.ui.ts` all drive it — through the scene. That
// is cause ① from `claudedocs/client-testing.md` (the ui layer reports no coverage), and it is also
// why the wrong thing was being pinned: those suites assert what a *panel* ends up showing, so they
// go red for a dozen reasons that have nothing to do with these functions, and stay green for the one
// failure mode that actually shipped here — a name silently falling back to a raw id or to the wrong
// translation namespace. That bug is invisible in Chinese-only testing and reads as "the auction
// house says 废料 but the backpack says 旧纸片" only once someone compares two screens.
//
// One runtime dependency is stubbed, and which one is the interesting part. Every other import here
// is `import type` (IconKind, AuctionView, the instance shapes) or plain data (the def tables, i18n);
// the single module that drags in pixi.js-legacy is `render/levelStars`, and only because it also
// houses the PIXI icon-row builder that shares its numbers. Stubbing it with a function that echoes
// its ARGUMENTS turns the one composition assertion into something sharper than the real star row
// would: what can regress in `auctionLabelText` is not how a star looks, it is whether the level and
// the per-class cap handed over are the right two numbers.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/render/levelStars', () => ({
  levelStarsText: (level: number, max: number) => (level > 0 ? `<stars ${level}/${max}>` : ''),
}));

import {
  equipName, cardName, itemKind, saleModeKind, auctionLabel, auctionLabelText,
  auctionItemLevel, auctionItemMaxLevel,
} from '../src/scenes/AuctionScene/itemLabels';
import { setLocale, t } from '../src/i18n';
import { MAX_CARD_LEVEL } from '../src/game/meta/cardDefs';
import { SKIN_TARGET_UNIT, skinDisplayName } from '../src/game/meta/skinDefs';
import { EQUIP_MAX_LEVEL } from '../src/game/meta/equipmentDefs';
import type { AuctionView } from '../src/net/WorldApiClient';

/** Minimal listing; each test supplies only the fields its branch reads. */
function listing(over: Partial<AuctionView> = {}): AuctionView {
  return { id: 'a1', itemType: 'material', qty: 1, item: {}, ...over } as AuctionView;
}

describe('auction item labels', () => {
  beforeEach(() => { setLocale('zh'); });

  describe('names fall back to the raw id rather than printing a translation key', () => {
    // The fallback is the whole point of these two wrappers: a listing for an item this client build
    // does not know (a new def shipped server-first) must show *something* identifiable, not
    // "equip.foo.name" — and must not throw, because it renders inside a list row.
    it('returns the raw defId for an unknown equipment/card def', () => {
      expect(equipName('no_such_equip_def')).toBe('no_such_equip_def');
      expect(cardName('no_such_card_def')).toBe('no_such_card_def');
    });

    it('returns the translated name for a def that exists', () => {
      // Uses whatever the dictionary actually has, so this cannot rot into asserting a hard-coded string.
      const translated = t('equip.wp_pencil.name');
      expect(translated).not.toBe('equip.wp_pencil.name');
      expect(equipName('wp_pencil')).toBe(translated);
    });
  });

  describe('glyphs', () => {
    it('maps each item class to its own glyph', () => {
      expect(itemKind('equipment')).toBe('armor');
      expect(itemKind('card')).toBe('cards');
      expect(itemKind('skin')).toBe('brush');
    });

    it('falls back to the material glyph — and to scrap when the material is missing', () => {
      expect(itemKind('material', 'lead')).toBe('lead');
      expect(itemKind('material')).toBe('scrap');
      expect(itemKind(undefined)).toBe('scrap');
    });

    it('distinguishes the two sale modes', () => {
      expect(saleModeKind('auction')).toBe('hammer');
      expect(saleModeKind('fixed')).toBe('tag');
    });
  });

  describe('row label', () => {
    it('names an equipment/card listing after its instance', () => {
      const eq = listing({ itemType: 'equipment', item: { instance: { defId: 'wp_pencil', level: 3 } } });
      expect(auctionLabel(eq)).toBe(t('equip.wp_pencil.name'));
      const card = listing({ itemType: 'card', item: { instance: { defId: 'archer', level: 2 } } });
      expect(auctionLabel(card)).toBe(t('card.archer.name'));
    });

    it('falls back to the filter label when the instance snapshot is missing', () => {
      // A listing whose item snapshot did not come back (older server row, trimmed payload) still has
      // to render a row; the generic class name is the honest answer.
      expect(auctionLabel(listing({ itemType: 'equipment' }))).toBe(t('auction.filterEquipment'));
      expect(auctionLabel(listing({ itemType: 'card' }))).toBe(t('auction.filterCard'));
      expect(auctionLabel(listing({ itemType: 'skin' }))).toBe(t('auction.filterSkin'));
    });

    it('names a material listing from the SHARED `material.*` keys, with its quantity', () => {
      // The regression this pins by name: the auction house used to carry its own
      // `auction.scrap|lead|binding` synonyms, so one and the same stack read differently here and in
      // the backpack/shop/gacha. Asserting against `t('material.scrap')` means the two can no longer
      // drift apart without this going red.
      const mat = listing({ itemType: 'material', qty: 7, item: { material: 'scrap' } });
      expect(auctionLabel(mat)).toBe(`${t('material.scrap')} ×7`);
      expect(auctionLabel(mat)).not.toContain('auction.');
    });

    it('treats a material listing with no material as scrap', () => {
      expect(auctionLabel(listing({ itemType: 'material', qty: 2 }))).toBe(`${t('material.scrap')} ×2`);
    });

    it('names a skin listing through the shared skin-name table', () => {
      // Same rule as the material keys: the skin name has to come from the one table the wardrobe and
      // the gacha already read, not from an auction-local synonym.
      const skinId = Object.keys(SKIN_TARGET_UNIT)[0]!;
      expect(auctionLabel(listing({ itemType: 'skin', item: { skinId } }))).toBe(skinDisplayName(skinId));
    });
  });

  describe('level and its star row', () => {
    it('reads the level off the instance, and 0 when there is none', () => {
      expect(auctionItemLevel(listing({ itemType: 'equipment', item: { instance: { defId: 'wp_pencil', level: 4 } } }))).toBe(4);
      expect(auctionItemLevel(listing({ itemType: 'card', item: { instance: { defId: 'archer', level: 2 } } }))).toBe(2);
      expect(auctionItemLevel(listing({ itemType: 'equipment' }))).toBe(0);
      expect(auctionItemLevel(listing({ itemType: 'card' }))).toBe(0);
      expect(auctionItemLevel(listing({ itemType: 'material', item: { material: 'lead' } }))).toBe(0);
      expect(auctionItemLevel(listing({ itemType: 'skin', item: { skinId: 's1' } }))).toBe(0);
    });

    it('caps the star row at the item class\'s own maximum', () => {
      // ⚠ MAX_CARD_LEVEL and EQUIP_MAX_LEVEL are both 9 today, so collapsing the branch to one
      // constant changes NOTHING observable and this cannot catch it — verified by mutation, stated
      // rather than papered over. What it does hold is the SOURCE of each answer: the day the two
      // ceilings diverge (they live in different packages — @nw/shared/cards vs the client's own
      // equipmentDefs — and neither owner has a reason to consult the other) this goes red instead of
      // half the house silently drawing the wrong row length.
      expect(auctionItemMaxLevel(listing({ itemType: 'card' }))).toBe(MAX_CARD_LEVEL);
      expect(auctionItemMaxLevel(listing({ itemType: 'equipment' }))).toBe(EQUIP_MAX_LEVEL);
      expect(auctionItemMaxLevel(listing({ itemType: 'material' }))).toBe(EQUIP_MAX_LEVEL);
    });

    it('hands the star row the item\'s own level and its own class cap', () => {
      // The stub echoes both arguments, so this pins the wiring rather than the glyph: the level that
      // reaches the star row is the listing's own, and the cap is its class's. (The two caps are equal
      // today — see the note above — so it is the LEVEL that this can currently catch being wrong.)
      const eq = listing({ itemType: 'equipment', item: { instance: { defId: 'wp_pencil', level: 3 } } });
      expect(auctionLabelText(eq)).toBe(`${t('equip.wp_pencil.name')} <stars 3/${EQUIP_MAX_LEVEL}>`);
      const eq7 = listing({ itemType: 'equipment', item: { instance: { defId: 'wp_pencil', level: 7 } } });
      expect(auctionLabelText(eq7)).toContain('<stars 7/');
      const card = listing({ itemType: 'card', item: { instance: { defId: 'archer', level: 2 } } });
      expect(auctionLabelText(card)).toBe(`${t('card.archer.name')} <stars 2/${MAX_CARD_LEVEL}>`);
      // Not the old "+N"/"Lv.N" convention this replaced.
      expect(auctionLabelText(eq)).not.toMatch(/\+3|Lv\.?3/);
    });

    it('adds nothing at all for a level-less listing — no trailing space, no empty star row', () => {
      const mat = listing({ itemType: 'material', qty: 1, item: { material: 'lead' } });
      expect(auctionLabelText(mat)).toBe(auctionLabel(mat));
    });
  });

  it('follows the active locale rather than a snapshot taken at import time', () => {
    const mat = listing({ itemType: 'material', qty: 3, item: { material: 'scrap' } });
    const zh = auctionLabel(mat);
    setLocale('en');
    expect(auctionLabel(mat)).not.toBe(zh);
    expect(auctionLabel(mat)).toBe(`${t('material.scrap')} ×3`);
  });
});
