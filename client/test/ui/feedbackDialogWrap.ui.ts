// Regression coverage for the 2026-08-30 FeedbackDialog body-text overflow (same class of bug as
// ConsentDialog's 2026-08-11 fix, see consentDialogWrap.ui.ts).
//
// Before: both wordWrap-enabled text nodes in this dialog — the intro `feedback.body` paragraph
// AND the input-echo label that mirrors what the player types — set `wordWrap: true` without
// `breakWords: true`. PIXI's wordWrap tokenizes on whitespace (see @pixi/text
// TextMetrics.wordWrap/tokenize); Chinese has no whitespace between characters, so a zh string (or
// a player typing a long run of Chinese with no spaces) is ONE token. When that token is wider
// than `wordWrapWidth`, `canBreakWords()` returns `style.breakWords` (false by default) and PIXI
// emits it as a single unbroken line instead of splitting it — text overflows both edges of the
// card. Every other CJK wordWrap call site in the codebase pairs `wordWrap: true` with
// `breakWords: true` (ConsentDialog/DailyScene/ChatScene/LevelPrepScene/mail.ts/sketchUi.ts) —
// FeedbackDialog was missing it on both of its wordWrap nodes.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// The adapter's canvas 2D context provides a real (if simplified — flat chars.length*7px)
// `measureText`, so PIXI's own TextMetrics.wordWrap/tokenize/canBreakWords logic executes for real
// here. That flat metric is too coarse to reproduce the exact overflow of the (short) production
// strings at every viewport size, so the wrap assertions below use a manufactured long CJK run
// against each node's real style object — not just a style-flag check, the actual wrapped line
// widths are asserted against that node's live wordWrapWidth/breakWords.
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { FeedbackDialog } from '../../src/ui/dialogs/FeedbackDialog';
import { initI18n, t } from '../../src/i18n';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
// zh is the locale that actually reproduces the bug: feedback.body and feedback.placeholder are
// long CJK runs with no whitespace, so they tokenize as a single PIXI wordWrap token each.
initI18n('zh', memStore, ['zh', 'en', 'de']);

const noop = { onSubmit: async () => {}, onClose: () => {}, openTextInput: createFakeTextInput().openTextInput };

/** Every wordWrap-enabled Text node in the dialog: the intro paragraph and the input-echo label. */
function findWrappedTexts(root: PIXI.Container): PIXI.Text[] {
  const found: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text && ch.style.wordWrap) found.push(ch);
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return found;
}

describe('FeedbackDialog text wraps instead of overflowing (2026-08-30)', () => {
  it('the zh feedback.body and feedback.placeholder strings have no whitespace (the precondition that makes this bug CJK-specific)', () => {
    // If this ever stops being true (translators add spaces), the bug this test guards against
    // can no longer reproduce via these strings — worth knowing rather than the test going quietly stale.
    expect(t('feedback.body')).not.toMatch(/\s/);
    expect(t('feedback.placeholder')).not.toMatch(/\s/);
  });

  it('finds exactly the two wordWrap nodes (intro body + input-echo label), both with breakWords set', () => {
    const dlg = new FeedbackDialog(1280, 800, noop);
    const texts = findWrappedTexts(dlg.container);
    expect(texts.length).toBe(2);
    for (const txt of texts) expect(txt.style.breakWords).toBe(true);
    dlg.destroy();
  });

  // The headless adapter's measureText is a flat `chars.length * 7px` stub (real glyph widths need
  // an actual browser canvas), so it doesn't reproduce the exact overflow of the short production
  // `feedback.body` string at every viewport size. What it CAN prove for real is the wrapping
  // mechanism on this node's actual (live) style object: an unbroken CJK run long enough to exceed
  // wordWrapWidth under that flat metric still splits across lines because breakWords is set — if
  // that flag ever regresses to false, `canBreakWords()` returns false and this collapses back to
  // one overflowing line, failing the assertion below.
  it('intro body style splits a long unbroken CJK run onto multiple lines (landscape 1280x800)', () => {
    const dlg = new FeedbackDialog(1280, 800, noop);
    const [body] = findWrappedTexts(dlg.container);
    const longRun = t('feedback.body').repeat(5); // no whitespace, well past wordWrapWidth
    const metrics = PIXI.TextMetrics.measureText(longRun, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });

  it('intro body style splits a long unbroken CJK run onto multiple lines on a narrow portrait viewport too (375x812)', () => {
    const dlg = new FeedbackDialog(375, 812, noop);
    const [body] = findWrappedTexts(dlg.container);
    const longRun = t('feedback.body').repeat(5);
    const metrics = PIXI.TextMetrics.measureText(longRun, body.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(body.style.wordWrapWidth as number);
    dlg.destroy();
  });

  it('a long unbroken CJK note typed into the input still wraps inside the field instead of overflowing it', () => {
    // The placeholder itself is too short to force a second line — this simulates what actually
    // triggers the input-echo label's copy of the bug: the player typing a long note with no
    // whitespace (feedback.placeholder is CJK-only, same as feedback.body — see the first test).
    const dlg = new FeedbackDialog(375, 812, noop);
    const longNote = t('feedback.placeholder').repeat(10); // ~80 CJK chars, no whitespace
    (dlg as unknown as { feedbackText: string }).feedbackText = longNote;
    (dlg as unknown as { refreshLabel(): void }).refreshLabel();
    const [, label] = findWrappedTexts(dlg.container);
    expect(label.text).toContain(longNote);
    const metrics = PIXI.TextMetrics.measureText(label.text, label.style as PIXI.TextStyle);
    expect(metrics.lines.length).toBeGreaterThan(1);
    for (const w of metrics.lineWidths) expect(w).toBeLessThanOrEqual(label.style.wordWrapWidth as number);
    dlg.destroy();
  });
});
