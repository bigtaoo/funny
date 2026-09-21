// Regression coverage for the 2026-08-11 ConsentDialog body-text overflow.
//
// Before: the body text had `wordWrap: true` but no `breakWords: true`. PIXI's wordWrap
// tokenizes on whitespace (see @pixi/text TextMetrics.wordWrap/tokenize); Chinese punctuation
// (。，；) isn't whitespace, so the whole zh `consent.body` string — no spaces at all — is ONE
// token. When that token is wider than `wordWrapWidth`, `canBreakWords()` returns
// `style.breakWords` (false by default) and PIXI emits it as a single unbroken line instead of
// splitting it — the card's body text overflowed both edges of the screen (reported live, see
// the ConsentDialog.ts fix commit). Every other CJK wordWrap call site in the codebase already
// pairs `wordWrap: true` with `breakWords: true` (DailyScene/ChatScene/LevelPrepScene/mail.ts/
// sketchUi.ts) — ConsentDialog was the one exception.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// The adapter's canvas 2D context provides a real (if simplified) `measureText`, so PIXI's own
// TextMetrics.wordWrap/tokenize/canBreakWords logic executes for real here — this is not just a
// style-flag check, the actual wrapped line widths are asserted.
// Run: npm run test:ui

import { describe, it, expect, afterAll } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ConsentDialog } from '../../src/ui/dialogs/ConsentDialog';
import { monospaceWidth } from '../../src/render/pixiText';
import { initI18n, setLocale, t } from '../../src/i18n';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
// zh is the locale that actually reproduces the bug: its consent.body is one long
// punctuation-only run with zero whitespace, so it tokenizes as a single PIXI wordWrap token.
initI18n('zh', memStore, ['zh', 'en', 'de']);

/** The body Text node — the only one in ConsentDialog with wordWrap enabled. */
function findWrappedText(root: PIXI.Container): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (found) return;
      if (ch instanceof PIXI.Text && ch.style.wordWrap) { found = ch; return; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return found;
}

describe('ConsentDialog body text wraps instead of overflowing (2026-08-11)', () => {
  it('the zh consent bodies have no whitespace (the precondition that makes this bug CJK-specific)', () => {
    // If this ever stops being true (translators add spaces), the bug this test guards against
    // can no longer reproduce via these strings — worth knowing rather than the test going quietly stale.
    // Both modes are listed: 'choice' got its own longer body when the two-button card shipped
    // (2026-09-21), and a new string is exactly how this regression would come back.
    expect(t('consent.body')).not.toMatch(/\s/);
    expect(t('consent.bodyChoice')).not.toMatch(/\s/);
  });

  it('sets breakWords so a single-token CJK run can still be split at a character boundary', () => {
    const dlg = new ConsentDialog(1280, 800, { onAccept: () => {}, onDecline: () => {} });
    const body = findWrappedText(dlg.container);
    expect(body).not.toBeNull();
    expect(body!.style.breakWords).toBe(true);
    dlg.destroy();
  });

  it('wraps onto multiple lines and never emits a line wider than wordWrapWidth (landscape 1280x800)', () => {
    const dlg = new ConsentDialog(1280, 800, { onAccept: () => {}, onDecline: () => {} });
    const body = findWrappedText(dlg.container)!;
    const metrics = PIXI.TextMetrics.measureText(body.text, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });

  it('wraps onto multiple lines on a narrow portrait viewport too (375x812)', () => {
    const dlg = new ConsentDialog(375, 812, { onAccept: () => {}, onDecline: () => {} });
    const body = findWrappedText(dlg.container)!;
    const metrics = PIXI.TextMetrics.measureText(body.text, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });

  // The 'choice' card swaps in a LONGER body and adds a second button under the first. Both of
  // those eat the same vertical budget, so it gets the same treatment on both viewports.
  for (const [w, h] of [[1280, 800], [375, 812]] as const) {
    it(`'choice' mode wraps its longer body within the card too (${w}x${h})`, () => {
      const dlg = new ConsentDialog(w, h, { onAccept: () => {}, onDecline: () => {} }, 'choice');
      const body = findWrappedText(dlg.container)!;
      const metrics = PIXI.TextMetrics.measureText(body.text, body.style as PIXI.TextStyle);
      expect(metrics.lines.length).toBeGreaterThan(1);
      for (const lw of metrics.lineWidths) expect(lw).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
      dlg.destroy();
    });
  }

  // The card grows to fit its content, but the SCREEN does not — a second button pushing the block
  // past the viewport still draws, just off both edges (the card is centred, so the title goes
  // first). Before the two-pass rescale in ConsentDialog.build, short landscape overflowed by 56px
  // in de and 19px in en. Asserted against the accept-only card rather than against 0: the
  // full-screen paper backdrop's hand-drawn stroke always bleeds ~1px, so the honest question is
  // whether the second button makes the footprint any worse, not whether it is pixel-exact.
  for (const [label, w, h] of [['landscape', 1280, 800], ['portrait', 375, 812], ['short landscape', 812, 375]] as const) {
    it(`'choice' mode fits the same viewport the accept-only card does (${label} ${w}x${h})`, () => {
      const one = new ConsentDialog(w, h, { onAccept: () => {}, onDecline: () => {} });
      const base = one.container.getBounds();
      one.destroy();

      const two = new ConsentDialog(w, h, { onAccept: () => {}, onDecline: () => {} }, 'choice');
      const got = two.container.getBounds();
      two.destroy();

      expect(got.y).toBeGreaterThanOrEqual(base.y);
      expect(got.y + got.height).toBeLessThanOrEqual(base.y + base.height);
    });
  }
});

// ── The title has to fit the card too (2026-09-21) ───────────────────────────────────────────
//
// Same failure as the body above, one node over: the title was drawn at a flat `unit * 0.07` with
// no width bound at all, so de's "Datenschutz & Datennutzung" came out 858 design px inside an
// 821px card on a desktop landscape window and spilled past both hand-drawn edges. zh and en fit
// at that size, which is why it took a German screenshot to find, and both modes were affected
// identically — the size never depended on the mode.
//
// Widths here are `Math.max(node.width, monospaceWidth(...))`, the same bound the dialog fits
// against, because the harness's `measureText` reports `chars * 7` whatever the font size: a bare
// `node.width` is a third of the truth here and pins the assertion to "it fits" no matter what the
// dialog does. See monospaceWidth's header, and UI_DESIGN_LOG_2026-09.md §56.3.

/**
 * The title Text node: the first node WITHOUT wordWrap, which the build order makes unambiguous
 * (card → title → body → the two links → the buttons; only the body wraps).
 */
function findTitleText(root: PIXI.Container): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (found) return;
      if (ch instanceof PIXI.Text && !ch.style.wordWrap) { found = ch; return; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return found;
}

/**
 * The card's geometry for a viewport, mirroring ConsentDialog.build(). `inner` is the text column
 * both the title and the body are laid out in (the body's `wordWrapWidth`); `cardW` is the card's
 * own outer width, i.e. the edges the title visibly crossed.
 */
function cardGeometry(w: number, h: number): { cardW: number; inner: number } {
  const landscape = w > h;
  const cardHmin = landscape
    ? Math.round(h * 0.8)
    : Math.round(Math.min(h * 0.72, w * 0.9 * 1.15));
  const cardW = landscape
    ? Math.round(Math.min(cardHmin * 0.95, w * 0.7))
    : Math.round(w * 0.9);
  return { cardW, inner: cardW * 0.84 };
}

/** What the node will really be, in a browser as well as here. */
function shownWidth(node: PIXI.Text): number {
  return Math.max(node.width, monospaceWidth(node.text, node.style.fontSize as number));
}

describe('ConsentDialog title fits the card (2026-09-21)', () => {
  afterAll(() => { setLocale('zh'); });

  for (const locale of ['zh', 'en', 'de'] as const) {
    for (const [w, h, label] of [
      [2276, 1080, 'desktop landscape (the design rect a 1920x911 window maps to)'],
      [1620, 1080, 'narrower landscape window'],
      [1080, 2337, 'portrait phone'],
      [2337, 1080, 'phone on its side'],
    ] as const) {
      for (const mode of ['accept-only', 'choice'] as const) {
        it(`[${locale}] ${label} ${w}x${h}, ${mode}: the title stays inside the card`, () => {
          setLocale(locale);
          const dlg = new ConsentDialog(w, h, { onAccept: () => {}, onDecline: () => {} }, mode);
          const title = findTitleText(dlg.container);
          expect(title).not.toBeNull();

          // Not truncated to fit: the size steps down the shared scale, and no locale comes near
          // the legibility floor. A consent gate headed "Datenschutz & Datennut…" is its own bug.
          expect(title!.text).toBe(t('consent.title'));

          const { cardW, inner } = cardGeometry(w, h);
          // The bug: wider than the card, spilling past both hand-drawn edges (it is centred).
          expect(shownWidth(title!)).toBeLessThanOrEqual(cardW);
          // The fix: inside the text column the body already wraps at, so the two share a measure.
          expect(shownWidth(title!)).toBeLessThanOrEqual(inner);
          dlg.destroy();
        });
      }
    }
  }
});
