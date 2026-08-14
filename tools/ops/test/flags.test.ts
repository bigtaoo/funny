// flags.ts's parseList — turns a comma/newline-separated textarea value into a trimmed,
// non-empty string array (used for feature-flag allow/deny lists & region/platform targeting).
// pageFlags() itself builds DOM and stays untested.
import { describe, it, expect } from 'vitest';
import { parseList } from '../src/pages/flags';

describe('parseList', () => {
  it('splits on commas', () => {
    expect(parseList('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('splits on newlines', () => {
    expect(parseList('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('splits on a mix of commas and newlines', () => {
    expect(parseList('a,b\nc, d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('trims whitespace around each entry', () => {
    expect(parseList('  a  , b ,c  ')).toEqual(['a', 'b', 'c']);
  });

  it('drops empty entries from blank lines / trailing separators', () => {
    expect(parseList('a,,b,\n\n,c,')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList('   \n  ,  ')).toEqual([]);
  });
});
