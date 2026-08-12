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

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ConsentDialog } from '../../src/ui/dialogs/ConsentDialog';
import { initI18n, t } from '../../src/i18n';

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
  it('the zh consent.body string has no whitespace (the precondition that makes this bug CJK-specific)', () => {
    // If this ever stops being true (translators add spaces), the bug this test guards against
    // can no longer reproduce via this string — worth knowing rather than the test going quietly stale.
    expect(t('consent.body')).not.toMatch(/\s/);
  });

  it('sets breakWords so a single-token CJK run can still be split at a character boundary', () => {
    const dlg = new ConsentDialog(1280, 800, { onAccept: () => {} });
    const body = findWrappedText(dlg.container);
    expect(body).not.toBeNull();
    expect(body!.style.breakWords).toBe(true);
    dlg.destroy();
  });

  it('wraps onto multiple lines and never emits a line wider than wordWrapWidth (landscape 1280x800)', () => {
    const dlg = new ConsentDialog(1280, 800, { onAccept: () => {} });
    const body = findWrappedText(dlg.container)!;
    const metrics = PIXI.TextMetrics.measureText(body.text, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });

  it('wraps onto multiple lines on a narrow portrait viewport too (375x812)', () => {
    const dlg = new ConsentDialog(375, 812, { onAccept: () => {} });
    const body = findWrappedText(dlg.container)!;
    const metrics = PIXI.TextMetrics.measureText(body.text, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });
});
