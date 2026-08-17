// Coverage for the 2026-08-16 LeaderboardScene portrait column-collision fix (TITLE_DESIGN §6 note).
//
// The bug: the row sized its **type** off `rowH` (which tracks screen *height*) but placed its
// **columns** at fractions of `w` (screen *width*). Landscape is ~16:9 so it never showed; portrait
// is ~1:2, so height-driven type outgrew the width-driven grid and the title label was driven into
// the rank-tier column — with the default `Player1234` name and any equipped title, in every
// locale, on every portrait phone, and worse on taller ones.
//
// This is a pure-function test rather than a `.ui.ts` PIXI spec for the same reason
// titlesBadgeOverflow.test.ts is: the headless harness (test/harness/pixiHeadless.ts) stubs
// `measureText` as a flat `length * 7` that ignores font size entirely, so it cannot reproduce —
// or refute — a width collision at all. The Browser pane in this environment does not composite
// frames either (UI_DESIGN §23/§26–§32), so a screenshot was not available as a cross-check.
// Instead the advances below were measured in a real Chromium via canvas `measureText`, which is
// the same API PIXI's TextMetrics uses, and the layout constants come straight from the scene.
import { describe, it, expect } from 'vitest';
import { leaderboardRowGeom, fitNameAndTitle } from '../src/scenes/LeaderboardScene';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

// Measured in Chromium (Windows) at `100px monospace`: ASCII advance 0.5498em, fullwidth CJK and
// the 「」 brackets 1.0em. Text in this client is always monospace (sketchUi.txt), so width is
// exactly proportional to character count — which is also why the design's "short label ≤ 4 chars"
// budget is a width budget, not a style preference.
const ASCII_EM = 0.5498046875;
const textW = (s: string, fontSize: number): number =>
  [...s].reduce((acc, ch) => acc + (/[　-鿿＀-￯]/.test(ch) ? 1 : ASCII_EM), 0) * fontSize;

// listW is the row's own width: the scene draws rows into a container inset by pad = round(w*0.05).
const listW = (designW: number): number => designW - Math.round(designW * 0.05) * 2;
const rowH = (designH: number, landscape: boolean): number => Math.round(designH * (landscape ? 0.065 : 0.095));

// designWidth is fixed at 1080 in portrait and designHeight grows with the aspect ratio, so 1920 is
// the *most forgiving* portrait case and taller phones only tighten it.
const CASES = [
  { name: 'portrait 1080x1920 (9:16, most forgiving)', w: 1080, h: 1920, landscape: false },
  { name: 'portrait 1080x2160 (tall phone)', w: 1080, h: 2160, landscape: false },
  { name: 'landscape 1920x1080', w: 1920, h: 1080, landscape: true },
];

/** The widest short label shipped in any locale, plus the default auto-generated display name. */
const WORST_TITLE = Math.max(
  ...[zh, en, de].flatMap((d) =>
    Object.entries(d as Record<string, string>)
      .filter(([k]) => k.startsWith('title.') && k.endsWith('.short'))
      .map(([, v]) => [...`「${v}」`].reduce((a, c) => a + (/[　-鿿＀-￯]/.test(c) ? 1 : ASCII_EM), 0)),
  ),
);
const DEFAULT_NAME = 'Player1234'; // shape of accounts/profile.ts's auto-assigned name

describe('leaderboardRowGeom — the name+title block never reaches the tier column', () => {
  for (const c of CASES) {
    const w = listW(c.w);
    const h = rowH(c.h, c.landscape);
    const g = leaderboardRowGeom(w, h, !c.landscape);

    it(`${c.name}: default name + the widest shipped title fits`, () => {
      const nameW = textW(DEFAULT_NAME, g.nameFs);
      const titleW = WORST_TITLE * g.titleFs;
      if (g.twoLine) {
        // Separate lines: each only has to clear the boundary on its own.
        expect(g.nameX + nameW).toBeLessThan(g.contentRight);
        expect(g.nameX + titleW).toBeLessThan(g.contentRight);
      } else {
        const fit = fitNameAndTitle(nameW, titleW, g.contentRight - g.nameX, 4);
        expect(fit.nameScale).toBe(1); // the common case must not be scaled at all
        expect(fit.titleScale).toBe(1);
        expect(g.nameX + fit.titleX + titleW).toBeLessThan(g.contentRight);
      }
    });

    it(`${c.name}: tier and ELO columns do not collide either`, () => {
      const tierW = textW('Grandmaster', g.tierFs); // longest rank label across locales
      const eloW = textW('9999', g.eloFs);
      expect(g.tierCX + tierW / 2).toBeLessThan(g.eloRightX - eloW);
    });

    it(`${c.name}: an absurdly long name is clamped rather than allowed to overflow`, () => {
      const nameW = textW('W'.repeat(64), g.nameFs);
      const titleW = WORST_TITLE * g.titleFs;
      const avail = g.contentRight - g.nameX;
      if (g.twoLine) {
        expect(Math.min(1, avail / nameW) * nameW).toBeLessThanOrEqual(avail + 0.001);
      } else {
        const fit = fitNameAndTitle(nameW, titleW, avail, 4);
        expect(fit.nameScale).toBeLessThan(1);
        expect(fit.titleX + titleW * fit.titleScale).toBeLessThanOrEqual(avail + 0.001);
      }
    });
  }

  it('the pre-fix single-line portrait row really did collide (the bug this encodes)', () => {
    // Reconstructs the old geometry — one line, fonts off the full rowH, tier centred at 0.68w —
    // to keep the regression legible: if someone reverts to it, this is what they are reverting to.
    const w = listW(1080);
    const h = Math.round(1920 * 0.065); // old portrait rowH
    const nameFs = 60, titleFs = 42, tierFs = 42; // snapFont(round(h*0.48 / *0.3 / *0.38))
    const nameEnd = Math.round(w * 0.18) + textW(DEFAULT_NAME, nameFs);
    const tierLeft = w * 0.68 - textW('青铜', tierFs) / 2;
    expect(nameEnd + 4 + textW('「天梯」', titleFs)).toBeGreaterThan(tierLeft); // zh overlapped too
  });
});

describe('fitNameAndTitle', () => {
  it('leaves both untouched when they already fit', () => {
    expect(fitNameAndTitle(100, 50, 200, 4)).toEqual({ nameScale: 1, titleScale: 1, titleX: 104 });
  });

  it('shrinks the name first — it is the identifying field, but the title keeps a minority share', () => {
    const fit = fitNameAndTitle(400, 80, 200, 4); // 80 <= 45% of 200 (=90), so the title is untouched
    expect(fit.titleScale).toBe(1);
    expect(fit.nameScale).toBeCloseTo(116 / 400, 5); // gets the remaining 200 - 4 - 80
    expect(fit.titleX + 80).toBeLessThanOrEqual(200);
  });

  it('caps a title that is itself oversized instead of letting it eat the whole row', () => {
    const fit = fitNameAndTitle(200, 400, 200, 4);
    expect(fit.titleScale).toBeCloseTo(90 / 400, 5); // 45% of 200
    expect(fit.nameScale).toBeLessThan(1);
    expect(fit.titleX + 400 * fit.titleScale).toBeLessThanOrEqual(200.001);
  });

  it('handles a missing title (titleW = 0) without dividing by zero', () => {
    expect(fitNameAndTitle(500, 0, 200, 4).titleScale).toBe(1);
    expect(fitNameAndTitle(500, 0, 200, 4).nameScale).toBeCloseTo(196 / 500, 5);
  });
});

describe('title short labels stay inside the ≤4-character budget (TITLE_DESIGN §6)', () => {
  // Monospace ⇒ characters are width. zh runs 1em per glyph and en/de 0.55em, so 4 is the ceiling
  // for the widest of them; the budget is stated in characters because that is what a translator
  // can check. Enforced as copy rather than runtime truncation so "Rangliste" becomes a chosen
  // "Rang" instead of a hard slice.
  for (const [locale, dict] of Object.entries({ zh, en, de }) as Array<[string, Record<string, string>]>) {
    for (const key of Object.keys(dict).filter((k) => k.startsWith('title.') && k.endsWith('.short'))) {
      it(`${locale} ${key}`, () => {
        expect([...dict[key]!].length).toBeLessThanOrEqual(4);
      });
    }
  }
});
