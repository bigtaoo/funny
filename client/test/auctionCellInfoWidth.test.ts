// The auction cell's info column is 167 design px wide, and three of the lines in it MUST fit that
// on ONE line in EVERY locale (src/scenes/AuctionScene/listCell.ts).
//
// Why one line and not "it wraps, so what": the cell is 200 design px tall and its bottom-right
// corner belongs to the row action — a Buy/Bid button in Market, an outcome word ("Outbid",
// "Leading") in My Bids. The info column grows top-down from the cell's top edge and the countdown
// is its LAST line, so every line above it that wraps pushes the countdown one line further down,
// and the cell has no slack: `AUC_CELL_H` was raised 180 -> 200 in §50.13 because the countdown was
// already ending 10 px inside the button's band. The 20 px that bought back is one line, and one
// line is exactly what German spent on 2026-09-15: `auction.myBid` read "Mein Gebot: 706500" — 18
// characters in a 15-character column — and on every outbid row of the sweep the countdown landed
// on "Überboten" (10 findings, frac 0.74-0.85; §55.2). English is at 15 of 15 on the same line, so
// there is no slack left to spend on any of these three strings in any language.
//
// This gate exists because the only other thing that can see the defect is the layout sweep's
// GERMAN row, which is one of ten viewports in a 25-minute run and had never been run when those
// two stops were added. `npm test` can see it in milliseconds, because it is a property of the
// translations and of geometry — no PIXI, no browser, no backend.
//
// ## Where the width per character comes from
//
// The UI font is monospace everywhere (render/sketchUi.ts), and at a portrait phone every one of
// these tokens renders at the legibility floor rather than at its own size (render/fontScale.ts:
// `FS.tiny`/`FS.small`/`FS.body` all lift to `fontFloorDesignPx(390/1080)` = 20 design px). So one
// number covers all three lines. That number was MEASURED off the 2026-09-15 sweep rather than
// assumed: the report's countdown labels are 13 and 14 characters at 53.806 and 57.778 CSS px, a
// difference of 3.972 CSS px at that viewport's 0.3611 design scale — 11.0 design px per
// character, i.e. 0.55 em, which two other labels in the same report agree with to the pixel.
//
// A full-width (CJK) glyph is one advance in each cell of a monospace face: two half-widths.
// Run: npm test

import { describe, it, expect } from 'vitest';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';
import { aucGrid, aucInfoColumnW } from '../src/scenes/AuctionScene/types';
import { fontFloorDesignPx } from '../src/render/fontScale';

const DICTS: Record<string, Record<string, string>> = { zh, en, de };

/**
 * The tightest shape this column is ever asked to hold: a portrait phone, where the design box is
 * a fixed 1080 wide and the tab nav is a BOTTOM bar, so the grid gets the whole width and fits
 * three columns into it (§18 — landscape spends `sidebarNavW` on a left rail instead, and its
 * design box is ~2337 wide, so its cells are never the narrow ones).
 */
const PORTRAIT_DESIGN_W = 1080;
const COLUMN_W = aucInfoColumnW(aucGrid(PORTRAIT_DESIGN_W).cellW);

/** Design scale of the narrowest phone the sweep walks — `fontFloorDesignPx`'s input. */
const PHONE_SCALE = 390 / PORTRAIT_DESIGN_W;
/** Half-width advance in design px: 0.55 em at the floor these lines all lift to. See header. */
const ADVANCE = fontFloorDesignPx(PHONE_SCALE) * 0.55;

/** CJK (and other full-width) code points take two advances in a monospace cell. */
function isFullWidth(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf)
    || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6);
}

function widthOf(s: string): number {
  let w = 0;
  for (const ch of s) w += isFullWidth(ch) ? ADVANCE * 2 : ADVANCE;
  return w;
}

function fill(dict: Record<string, string>, key: string, params: Record<string, string>): string {
  let s = dict[key] ?? '';
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  return s;
}

/**
 * The widest coin figure a listing carries. Seven digits, per the sweep's own seed
 * (test/browser/lib/seedFixtures.ts `buildAuctions`: "prices up into seven digits (the widest a
 * coin figure gets)"), and the widest one it renders is a buyout at 4x a seven-digit price.
 */
const WIDEST_PRICE = '9999999';

describe('auction cell — the info column holds its one-line rows in every locale', () => {
  it('is the 167-px three-column portrait column the cell actually draws into', () => {
    // Guards the premise rather than the translations: if the grid ever fits a different number of
    // columns into a portrait phone, every budget below moves and this file has to be re-derived.
    expect(aucGrid(PORTRAIT_DESIGN_W).cols).toBe(3);
    expect(COLUMN_W).toBeCloseTo(167.33, 1);
    // 15 characters, which is the number listCell.ts's comments quote.
    expect(Math.floor(COLUMN_W / ADVANCE)).toBe(15);
  });

  for (const [locale, dict] of Object.entries(DICTS)) {
    // `${t('auction.myBid')}: ${mine.myBid}` — the client builds this one by concatenation, so the
    // colon and space are part of the budget even though they are not in the dictionary.
    it(`${locale}: "my bid" fits on one line at the widest price`, () => {
      const line = `${dict['auction.myBid']}: ${WIDEST_PRICE}`;
      expect(widthOf(line)).toBeLessThanOrEqual(COLUMN_W);
    });

    it(`${locale}: "buyout" fits on one line at the widest price`, () => {
      const line = fill(dict, 'auction.buyoutAt', { price: WIDEST_PRICE });
      expect(widthOf(line)).toBeLessThanOrEqual(COLUMN_W);
    });
  }

  // The countdown is held to the same column, at the shape the auction house actually produces:
  // listings run a fixed 72h (`AUCTION_DURATION_SEC`) and the sweep's seed tops out at 21 hours, so
  // what is ever drawn is a single-digit day count with two-digit h/m/s.
  //
  // NOT parameterised over the locales above, deliberately: at `d >= 1` the Chinese format
  // ('{d}天{h}时{m}分{s}秒' — four full-width unit glyphs) measures 187 design px against this
  // 167-px column and would wrap, which is the same defect §55.2 fixed in German. It has never been
  // seen because the sweep's seed never lists anything more than a day out, and shortening it is a
  // copy decision this round did not take — recorded in §55.4, not silently absorbed here.
  for (const locale of ['en', 'de']) {
    it(`${locale}: the countdown fits on one line at the longest duration a listing has`, () => {
      const line = fill(DICTS[locale]!, 'auction.timeLeft', { d: '2', h: '23', m: '59', s: '59' });
      expect(widthOf(line)).toBeLessThanOrEqual(COLUMN_W);
    });
  }
});
