// `render/pixiText.ts`'s `monospaceWidth` — the string-derived lower bound that lets a layout
// BRANCH on width without the branch being decided by a test stub.
//
// Why this needs its own suite rather than riding on the scene that uses it: in `test/ui` the
// headless `measureText` is `chars * 7` px at every font size, so nothing there can tell a correct
// cell count from a wrong one — the very reason this helper exists (see
// `test/ui/settingsLegalLinks.ui.ts`, and `client-testing.md`). Here it is a pure function over a
// string, so the arithmetic itself is testable. What this layer CANNOT check is whether 0.6 em and
// 1 em are true of a real runtime; that is `test/browser/textMetrics.spec.ts`, against a measured
// advance from a real browser.
import { describe, it, expect } from 'vitest';
import { monospaceWidth, MONO_CELL } from '../src/render/pixiText';

describe('monospaceWidth', () => {
  it('counts Latin text as 0.6 em per character', () => {
    expect(monospaceWidth('abcd', 24)).toBeCloseTo(4 * MONO_CELL.latin * 24, 6);
    // Fixed pitch: the same count of any Latin characters is the same width. A proportional
    // fallback would break this, which is exactly what the browser spec measures for.
    expect(monospaceWidth('MMMM', 24)).toBe(monospaceWidth('iiii', 24));
  });

  it('counts CJK as a full em, so a Chinese label is not two-thirds of its real width', () => {
    expect(monospaceWidth('隐私政策', 24)).toBeCloseTo(4 * MONO_CELL.fullWidth * 24, 6);
    // The case the settings row actually hits: a bullet, a space and four CJK glyphs.
    expect(monospaceWidth('· 隐私政策', 24)).toBeCloseTo((2 * MONO_CELL.latin + 4) * 24, 6);
  });

  it('is linear in font size and zero for an empty string', () => {
    expect(monospaceWidth('Privacy Policy', 48)).toBe(2 * monospaceWidth('Privacy Policy', 24));
    expect(monospaceWidth('', 24)).toBe(0);
  });

  it.each([
    ['CJK ideograph', '汉'],
    ['kana', 'あ'],
    ['CJK punctuation', '、'],
    ['fullwidth Latin', 'Ａ'],
    ['Hangul', '한'],
  ])('treats %s as one full-width cell', (_what, ch) => {
    expect(monospaceWidth(ch, 24)).toBe(MONO_CELL.fullWidth * 24);
  });

  it.each([
    ['ASCII', 'A'],
    ['the bullet these links use', '·'],
    ['an umlaut, as German labels carry', 'ä'],
    ['an em dash', '—'],
  ])('treats %s as one Latin cell', (_what, ch) => {
    expect(monospaceWidth(ch, 24)).toBeCloseTo(MONO_CELL.latin * 24, 6);
  });

  // A surrogate pair is ONE character here (`for..of` iterates code points), and the CJK extensions
  // that live up there are still full-width — `text.length` would have counted 2 cells, and a BMP-
  // only class would have counted 2 *Latin* cells, i.e. 1.2 em for one glyph.
  it('counts an astral-plane ideograph as one full-width cell', () => {
    expect(monospaceWidth('𠀋', 24)).toBe(MONO_CELL.fullWidth * 24);
  });
});
