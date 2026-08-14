// Colour helpers + the editor's fixed preview palette (src/model/color.ts) — fully pure, no
// PIXI/DOM dependency.
import { describe, it, expect } from 'vitest';
import { toHex, toHexString, PALETTE } from '../src/model/color';

describe('toHex', () => {
  it('passes a finite number through unchanged (coerced to unsigned 32-bit)', () => {
    expect(toHex(0x4a90d9)).toBe(0x4a90d9);
  });
  it('parses a "#RRGGBB" string', () => {
    expect(toHex('#d94a4a')).toBe(0xd94a4a);
  });
  it('parses a "0xRRGGBB" string, case-insensitively', () => {
    expect(toHex('0X5FB85F')).toBe(0x5fb85f);
  });
  it('parses a bare hex digit string with no prefix', () => {
    expect(toHex('222222')).toBe(0x222222);
  });
  it('trims surrounding whitespace', () => {
    expect(toHex('  e08a2e  ')).toBe(0xe08a2e);
  });
  it('falls back on undefined input', () => {
    expect(toHex(undefined)).toBe(0x222222);
    expect(toHex(undefined, 0xff0000)).toBe(0xff0000);
  });
  it('falls back on a non-finite number (NaN/Infinity)', () => {
    expect(toHex(NaN)).toBe(0x222222);
    expect(toHex(Infinity)).toBe(0x222222);
  });
  it('falls back on an unparseable string', () => {
    expect(toHex('not-a-color')).toBe(0x222222);
  });
});

describe('toHexString', () => {
  it('formats as a lowercase, zero-padded "0xRRGGBB"', () => {
    expect(toHexString(0x4a90d9)).toBe('0x4a90d9');
    expect(toHexString(0x0000ff)).toBe('0x0000ff');
  });
  it('coerces to unsigned 32-bit before formatting (negative input never produces a bare minus)', () => {
    expect(toHexString(-1)).not.toContain('-');
  });
});

describe('toHex / toHexString round trip', () => {
  it('every PALETTE swatch (except the -1 "use default" sentinel) survives a hex round trip', () => {
    for (const swatch of PALETTE) {
      if (swatch.color === -1) continue;
      const hexStr = toHexString(swatch.color);
      expect(toHex(hexStr)).toBe(swatch.color);
    }
  });
});

describe('PALETTE', () => {
  it('has unique keys', () => {
    const keys = PALETTE.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('the "default" swatch is the -1 sentinel (use the effect\'s own defaultColor)', () => {
    expect(PALETTE.find((s) => s.key === 'default')?.color).toBe(-1);
  });
});
