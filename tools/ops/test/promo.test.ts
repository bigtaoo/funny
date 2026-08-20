// promo.ts's pure helpers (B-PROMO mint page). Everything here exists to keep the operator's reading of a
// code identical to what a player's redeem attempt actually does in commercial's PromoService — the page
// cannot call that code, so these tests are what pins the two together. pagePromo() builds DOM, untested,
// same split as feedback.test.ts / gachaPools.test.ts.
import { describe, it, expect } from 'vitest';
import { normalizePromoCode, promoStatus, redemptionText, validatePromoDraft, type PromoDraft } from '../src/pages/promo';
import type { PromoCodeView } from '../src/types';

const NOW = 1_700_000_000_000;
const draft = (over: Partial<PromoDraft> = {}): PromoDraft => ({ code: 'WELCOME', coins: 100, ...over });
const code = (over: Partial<PromoCodeView> = {}): PromoCodeView => ({
  code: 'WELCOME', coins: 100, redeemed: 0, createdBy: 'root', createdAt: 1, ...over,
});

describe('normalizePromoCode', () => {
  it('trims and uppercases, matching commercial `args.code.trim().toUpperCase()`', () => {
    expect(normalizePromoCode('  welcome2026 ')).toBe('WELCOME2026');
  });

  it('leaves an already-normalized code untouched (so the form preview stays quiet)', () => {
    expect(normalizePromoCode('WELCOME2026')).toBe('WELCOME2026');
  });

  it('collapses a whitespace-only entry to empty, which validation then rejects', () => {
    expect(normalizePromoCode('   ')).toBe('');
  });
});

describe('validatePromoDraft', () => {
  it('accepts a minimal draft (code + coins, no expiry, no limit)', () => {
    expect(validatePromoDraft(draft(), NOW)).toBeNull();
  });

  it('accepts a fully specified draft', () => {
    expect(validatePromoDraft(draft({ expiresAt: NOW + 86400_000, totalLimit: 500, note: 'launch' }), NOW)).toBeNull();
  });

  // A code is only "required" after normalization — the server would reject a whitespace-only code too,
  // but with commercial's opaque 'BAD_REQUEST'.
  it('rejects a blank or whitespace-only code', () => {
    expect(validatePromoDraft(draft({ code: '' }), NOW)).toMatch(/code is required/i);
    expect(validatePromoDraft(draft({ code: '  ' }), NOW)).toMatch(/code is required/i);
  });

  it('rejects zero, negative, and non-numeric coins', () => {
    expect(validatePromoDraft(draft({ coins: 0 }), NOW)).toMatch(/positive/i);
    expect(validatePromoDraft(draft({ coins: -5 }), NOW)).toMatch(/positive/i);
    expect(validatePromoDraft(draft({ coins: Number.NaN }), NOW)).toMatch(/positive/i);
  });

  // commercial floors rather than rejects (`Math.floor(args.coins)`), so 100.5 would land silently as 100.
  it('rejects fractional coins instead of letting commercial floor them silently', () => {
    expect(validatePromoDraft(draft({ coins: 100.5 }), NOW)).toMatch(/whole number/i);
  });

  it('rejects an expiry at or before now — the code would be dead on arrival', () => {
    expect(validatePromoDraft(draft({ expiresAt: NOW - 1 }), NOW)).toMatch(/in the past/i);
    expect(validatePromoDraft(draft({ expiresAt: NOW }), NOW)).toMatch(/in the past/i);
  });

  it('rejects an unparseable expiry (localInputToMs returns NaN on a cleared datetime field)', () => {
    expect(validatePromoDraft(draft({ expiresAt: Number.NaN }), NOW)).toMatch(/valid date/i);
  });

  it('rejects a non-positive or fractional total limit', () => {
    expect(validatePromoDraft(draft({ totalLimit: 0 }), NOW)).toMatch(/positive/i);
    expect(validatePromoDraft(draft({ totalLimit: -1 }), NOW)).toMatch(/positive/i);
    expect(validatePromoDraft(draft({ totalLimit: 2.5 }), NOW)).toMatch(/whole number/i);
  });

  it('treats an omitted expiry/limit as "unlimited", not as an invalid value', () => {
    expect(validatePromoDraft({ code: 'X', coins: 1 }, NOW)).toBeNull();
  });
});

describe('promoStatus', () => {
  it('a fresh uncapped, never-expiring code is Active', () => {
    expect(promoStatus(code(), NOW)).toEqual({ label: 'Active', cls: 'ok' });
  });

  it('an expiry in the future keeps it Active; one in the past reads Expired', () => {
    expect(promoStatus(code({ expiresAt: NOW + 1 }), NOW)).toMatchObject({ label: 'Active' });
    expect(promoStatus(code({ expiresAt: NOW - 1 }), NOW)).toMatchObject({ label: 'Expired' });
  });

  // commercial's guard is `def.expiresAt < now()`, so an expiry exactly equal to now still redeems.
  it('an expiry exactly at now is still Active, matching commercial\'s strict `<` comparison', () => {
    expect(promoStatus(code({ expiresAt: NOW }), NOW)).toMatchObject({ label: 'Active' });
  });

  it('reads Exhausted once redeemed reaches the total limit, and stays Active below it', () => {
    expect(promoStatus(code({ totalLimit: 10, redeemed: 9 }), NOW)).toMatchObject({ label: 'Active' });
    expect(promoStatus(code({ totalLimit: 10, redeemed: 10 }), NOW)).toMatchObject({ label: 'Exhausted' });
  });

  // The `$inc redeemed` guard is best-effort ("at most 1 over-limit concurrently"), so redeemed can
  // legitimately exceed totalLimit — that must not read as Active.
  it('an over-redeemed code (concurrent redemption overshoot) still reads Exhausted', () => {
    expect(promoStatus(code({ totalLimit: 10, redeemed: 11 }), NOW)).toMatchObject({ label: 'Exhausted' });
  });

  it('no total limit means never Exhausted, however many redemptions landed', () => {
    expect(promoStatus(code({ redeemed: 9999 }), NOW)).toMatchObject({ label: 'Active' });
  });

  // Validation order matters: promoRedeem checks expiry BEFORE the total limit, so this is the error a
  // player would actually see. Labelling it "Exhausted" would send ops chasing the wrong cause.
  it('a code that is both expired and exhausted reads Expired, matching promoRedeem\'s check order', () => {
    expect(promoStatus(code({ expiresAt: NOW - 1, totalLimit: 5, redeemed: 5 }), NOW)).toMatchObject({ label: 'Expired' });
  });
});

describe('redemptionText', () => {
  it('shows the cap when there is one', () => {
    expect(redemptionText({ redeemed: 3, totalLimit: 100 })).toBe('3 / 100');
  });

  it('shows ∞ for an uncapped code rather than an empty or "undefined" denominator', () => {
    expect(redemptionText({ redeemed: 3 })).toBe('3 / ∞');
  });

  it('a limit of 0 is impossible via the form but must not be mistaken for uncapped', () => {
    expect(redemptionText({ redeemed: 0, totalLimit: 0 })).toBe('0 / 0');
  });
});
