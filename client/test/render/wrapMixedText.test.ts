// wrapMixedText (client/src/render/pixiText.ts): line breaking for paragraphs that mix CJK with
// Latin words. Pixi's wordWrap only breaks at spaces, which left the Apple refund consent card's
// Chinese body as one line running through the card (2026-10-04, TestFlight build 18).
import { describe, it, expect } from 'vitest';
import { wrapMixedText, monospaceWidth } from '../../src/render/pixiText';

// 1 em per CJK cell, 0.54 em per Latin cell at 10 px: a 100 px line holds 10 汉字.
const measure = (s: string): number => monospaceWidth(s, 10);

describe('wrapMixedText', () => {
  it('breaks a CJK run at any character to fill each line', () => {
    expect(wrapMixedText('一二三四五六七八九十甲乙丙', 100, measure)).toBe('一二三四五六七八九十\n甲乙丙');
  });

  it('never splits a Latin word, and fills the line before it instead of flushing early', () => {
    const out = wrapMixedText('如果你以后向 Apple 申请退款，Apple 会向我们询问', 100, measure);
    for (const line of out.split('\n')) expect(measure(line)).toBeLessThanOrEqual(100);
    expect(out.match(/Apple/g)).toHaveLength(2);
    // The first line is full, not "如果你以后向 Apple" left half-empty by an early flush.
    expect(out.split('\n')[0]).toBe('如果你以后向 Apple');
    expect(measure(out.split('\n')[1])).toBeGreaterThan(70);
  });

  it('keeps closing punctuation off the start of a line', () => {
    // Ten cells fit exactly, so the full stop would open line two: it takes 十 down with it.
    const out = wrapMixedText('一二三四五六七八九十。甲乙', 100, measure);
    expect(out).toBe('一二三四五六七八九\n十。甲乙');
  });

  it('keeps explicit newlines and leaves short or Latin-only text alone', () => {
    expect(wrapMixedText('甲乙\n丙丁', 100, measure)).toBe('甲乙\n丙丁');
    expect(wrapMixedText('May we tell Apple?', 1000, measure)).toBe('May we tell Apple?');
  });

  it('wraps Latin prose at spaces and gives an over-long word its own line uncut', () => {
    expect(wrapMixedText('aaaa bbbb cccc', 30, measure)).toBe('aaaa\nbbbb\ncccc');
    expect(wrapMixedText('a supercalifragilistic b', 30, measure)).toBe('a\nsupercalifragilistic\nb');
  });
});
