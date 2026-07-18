// Paddle webhook helper unit tests: quantity clamping (D-COMMERCIAL, COMMERCIAL_DESIGN.md §10.6) +
// price→coins mapping. Route-level integration (signature check, full webhook handler) is not covered
// here — these are the pure functions the webhook handler composes coins from.
import { describe, it, expect, afterEach } from 'vitest';
import { clampPaddleQuantity, coinsForPriceId, MIN_PADDLE_QUANTITY, MAX_PADDLE_QUANTITY } from '../src/paddle.js';

describe('clampPaddleQuantity', () => {
  it('passes through values inside [1,5]', () => {
    expect(clampPaddleQuantity(1)).toBe(1);
    expect(clampPaddleQuantity(3)).toBe(3);
    expect(clampPaddleQuantity(5)).toBe(5);
  });

  it('missing/undefined quantity defaults to 1 (pre-quantity-support behavior)', () => {
    expect(clampPaddleQuantity(undefined)).toBe(1);
  });

  it('non-numeric input defaults to 1', () => {
    expect(clampPaddleQuantity('not-a-number')).toBe(1);
    expect(clampPaddleQuantity(null)).toBe(1);
    expect(clampPaddleQuantity(NaN)).toBe(1);
  });

  it('below MIN clamps up to MIN_PADDLE_QUANTITY', () => {
    expect(clampPaddleQuantity(0)).toBe(MIN_PADDLE_QUANTITY);
    expect(clampPaddleQuantity(-3)).toBe(MIN_PADDLE_QUANTITY);
  });

  it('above MAX clamps down to MAX_PADDLE_QUANTITY (e.g. a forged 999 payload)', () => {
    expect(clampPaddleQuantity(999)).toBe(MAX_PADDLE_QUANTITY);
    expect(clampPaddleQuantity(6)).toBe(MAX_PADDLE_QUANTITY);
  });

  it('rounds fractional quantities', () => {
    expect(clampPaddleQuantity(2.4)).toBe(2);
    expect(clampPaddleQuantity(2.6)).toBe(3);
  });

  it('numeric strings are coerced (Paddle payloads are JSON so this should not happen, but is safe)', () => {
    expect(clampPaddleQuantity('4')).toBe(4);
  });
});

describe('coinsForPriceId', () => {
  afterEach(() => {
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  it('resolves a mapped price id to its tier coins', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499,t999:pri_999';
    expect(coinsForPriceId('pri_499')).toBe(550);
    expect(coinsForPriceId('pri_999')).toBe(1150);
  });

  it('unmapped price id returns 0', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't499:pri_499';
    expect(coinsForPriceId('pri_unknown')).toBe(0);
  });

  it('unset env var returns 0 for any price id', () => {
    expect(coinsForPriceId('pri_499')).toBe(0);
  });
});

describe('quantity purchase: unitCoins * clampedQuantity matches the webhook handler math', () => {
  afterEach(() => {
    delete process.env.NW_PADDLE_PRICE_IDS;
  });

  it('buying 10 units of a $19.99 tier (over MAX) credits only MAX_PADDLE_QUANTITY worth of coins', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't1999:pri_1999';
    const unitCoins = coinsForPriceId('pri_1999');
    const clamped = clampPaddleQuantity(10);
    expect(unitCoins).toBe(2400);
    expect(clamped).toBe(5);
    expect(unitCoins * clamped).toBe(12000);
  });

  it('buying 3 units (within range) credits exactly 3x the unit coins', () => {
    process.env.NW_PADDLE_PRICE_IDS = 't1999:pri_1999';
    const unitCoins = coinsForPriceId('pri_1999');
    const clamped = clampPaddleQuantity(3);
    expect(unitCoins * clamped).toBe(7200);
  });
});
