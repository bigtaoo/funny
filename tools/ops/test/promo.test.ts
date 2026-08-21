// src/logic/promo.ts — the B-PROMO mint page's helpers. Everything here exists to keep the operator's
// reading of a code identical to what a player's redeem attempt actually does in commercial's
// PromoService — the page cannot call that code, so these tests are what pins the two together.
// pagePromo() builds DOM and stays untested, same split as feedback.test.ts / gachaPools.test.ts.
import { describe, it, expect } from 'vitest';
import {
  createError, DEFAULT_EXPIRY_MS, normalizedPreview, normalizePromoCode, promoDraft, promoStatus,
  redemptionText, validatePromoDraft, type PromoDraft,
} from '../src/logic/promo';
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

describe('promoDraft', () => {
  const fields = { code: ' welcome ', coins: '250', expiryEnabled: false, expiry: '', totalLimit: '', note: '' };

  it('keeps the code as typed — normalization happens at submit, so the preview can show the diff', () => {
    expect(promoDraft(fields)).toEqual({ code: ' welcome ', coins: 250 });
  });

  it('omits an unticked expiry entirely rather than sending NaN', () => {
    expect(promoDraft({ ...fields, expiry: '2026-09-01T10:00' })).not.toHaveProperty('expiresAt');
  });

  it('includes the expiry once the checkbox is ticked', () => {
    const d = promoDraft({ ...fields, expiryEnabled: true, expiry: '2026-09-01T10:00' });
    expect(d.expiresAt).toBe(new Date('2026-09-01T10:00').getTime());
  });

  it('omits a blank total limit and a blank note', () => {
    const d = promoDraft({ ...fields, totalLimit: '  ', note: '   ' });
    expect(d).not.toHaveProperty('totalLimit');
    expect(d).not.toHaveProperty('note');
  });

  it('trims the note and parses the limit', () => {
    expect(promoDraft({ ...fields, totalLimit: '500', note: '  launch  ' }))
      .toMatchObject({ totalLimit: 500, note: 'launch' });
  });

  it('lets an unparseable coins field through as NaN, which validation then reports', () => {
    expect(validatePromoDraft(promoDraft({ ...fields, coins: 'many' }), NOW)).toMatch(/positive/i);
  });

  it('offers a 30-day default expiry', () => {
    expect(DEFAULT_EXPIRY_MS).toBe(30 * 86400_000);
  });
});

describe('normalizedPreview', () => {
  it('echoes the stored form when it differs from what was typed', () => {
    expect(normalizedPreview(' welcome ')).toBe('stored as WELCOME');
    expect(normalizedPreview('welcome')).toBe('stored as WELCOME');
  });

  it('stays quiet when the typed code IS the stored form — echoing it would be noise', () => {
    expect(normalizedPreview('WELCOME')).toBe('');
  });

  it('stays quiet for an empty field', () => {
    expect(normalizedPreview('')).toBe('');
    expect(normalizedPreview('   ')).toBe('');
  });
});

describe('createError', () => {
  it('translates commercial’s 409 into something an operator can act on', () => {
    const out = createError({ status: 409, code: 'BAD_REQUEST' }, 'WELCOME') as Error;
    expect(out.message).toBe('Code WELCOME already exists (codes are unique, case-insensitive).');
  });

  it('passes any other error through untouched', () => {
    const original = new Error('network down');
    expect(createError(original, 'WELCOME')).toBe(original);
  });

  it('passes a genuine 400 through — only the duplicate case is ambiguous', () => {
    const original = { status: 400, code: 'BAD_REQUEST', message: 'coins must be positive' };
    expect(createError(original, 'WELCOME')).toBe(original);
  });
});
