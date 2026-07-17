// Family / sect name display-width helpers (core.ts): a full-width (CJK/全角) character
// counts as 2, everything else as 1; names cap at ORG_NAME_WIDTH_MAX (12) → 6 汉字 or 12 letters.
import { describe, it, expect } from 'vitest';
import {
  orgNameWidth,
  truncateOrgName,
  ORG_NAME_WIDTH_MIN,
  ORG_NAME_WIDTH_MAX,
} from '../src/index';

describe('orgNameWidth', () => {
  it('counts ASCII/half-width as 1', () => {
    expect(orgNameWidth('')).toBe(0);
    expect(orgNameWidth('abc')).toBe(3);
    expect(orgNameWidth('Guild123')).toBe(8);
    expect(orgNameWidth(' -_.')).toBe(4);
  });

  it('counts CJK / full-width characters as 2', () => {
    expect(orgNameWidth('宗')).toBe(2);
    expect(orgNameWidth('宗门')).toBe(4);
    expect(orgNameWidth('墨水家族')).toBe(8); // 4 汉字 → 8
  });

  it('mixes half- and full-width', () => {
    expect(orgNameWidth('墨A')).toBe(3); // 汉字(2) + letter(1)
    expect(orgNameWidth('S1赛季')).toBe(6); // S,1 (2) + 赛,季 (4)
  });

  it('the max cap is exactly 6 汉字 or 12 letters', () => {
    expect(orgNameWidth('六个汉字上限')).toBe(ORG_NAME_WIDTH_MAX); // 6 汉字 = 12
    expect(orgNameWidth('abcdefghijkl')).toBe(ORG_NAME_WIDTH_MAX); // 12 letters = 12
    expect(orgNameWidth('七个汉字超限了')).toBeGreaterThan(ORG_NAME_WIDTH_MAX); // 7 汉字 = 14
  });

  it('min cap: a single 汉字 already reaches width 2 (= MIN)', () => {
    expect(orgNameWidth('家')).toBe(ORG_NAME_WIDTH_MIN);
    expect(orgNameWidth('a')).toBeLessThan(ORG_NAME_WIDTH_MIN);
  });
});

describe('truncateOrgName', () => {
  it('leaves within-cap names untouched', () => {
    expect(truncateOrgName('墨水家族')).toBe('墨水家族');
    expect(truncateOrgName('Short')).toBe('Short');
  });

  it('clips to at most the width cap, never splitting a character', () => {
    expect(truncateOrgName('七个汉字超限了')).toBe('七个汉字超限'); // first 6 汉字 = width 12
    expect(orgNameWidth(truncateOrgName('七个汉字超限了'))).toBe(ORG_NAME_WIDTH_MAX);
    expect(truncateOrgName('abcdefghijklmnop')).toBe('abcdefghijkl'); // first 12 letters
  });

  it('does not leave a dangling half-character when the boundary lands mid-汉字', () => {
    // 5 汉字 (width 10) + 3 letters (width 3) = 13 > 12; the 6th unit would split the 汉字 run
    // at width 11 (letters) — a full-width char needs 2, so it stops at width 12 = 5汉字 + 2 letters.
    const clipped = truncateOrgName('一二三四五abc');
    expect(orgNameWidth(clipped)).toBeLessThanOrEqual(ORG_NAME_WIDTH_MAX);
    expect(clipped).toBe('一二三四五ab');
  });
});
