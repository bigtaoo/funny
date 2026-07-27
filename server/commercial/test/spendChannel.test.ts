// Pure unit coverage for spendChannel.ts (ADR-020: wallet channel isolation — off-platform-purchased
// coins must not be spendable inside Apple/Google's native apps, and vice versa).
import { describe, it, expect } from 'vitest';
import { rechargeChannelOf, spendChannelOf, displayChannelOf, effectiveCoins } from '../src/spendChannel';

describe('rechargeChannelOf — maps a verified recharge/IAP platform to a wallet bucket', () => {
  it('paddle and stripe both fund the web bucket', () => {
    expect(rechargeChannelOf('paddle')).toBe('web');
    expect(rechargeChannelOf('stripe')).toBe('web');
  });
  it('apple funds the apple bucket, google funds the google bucket', () => {
    expect(rechargeChannelOf('apple')).toBe('apple');
    expect(rechargeChannelOf('google')).toBe('google');
  });
  it('unrecognized platforms (including wechat, which never reaches this shared wallet) return null', () => {
    expect(rechargeChannelOf('wechat')).toBeNull();
    expect(rechargeChannelOf('dev')).toBeNull();
    expect(rechargeChannelOf('')).toBeNull();
  });
});

describe('spendChannelOf — maps a client-declared request platform to the bucket it may spend from', () => {
  it('ios → apple, android → google', () => {
    expect(spendChannelOf('ios')).toBe('apple');
    expect(spendChannelOf('android')).toBe('google');
  });
  it('web/wechat/crazygames/unknown/absent all default to web (back-compat: no restriction for pre-header clients)', () => {
    expect(spendChannelOf('web')).toBe('web');
    expect(spendChannelOf('wechat')).toBe('web');
    expect(spendChannelOf('crazygames')).toBe('web');
    expect(spendChannelOf('something-unexpected')).toBe('web');
    expect(spendChannelOf(undefined)).toBe('web');
  });
});

describe('effectiveCoins — free pool + the given channel bucket', () => {
  it('null/undefined wallet → 0', () => {
    expect(effectiveCoins(null, 'web')).toBe(0);
    expect(effectiveCoins(undefined, 'apple')).toBe(0);
  });
  it('sums free coins with only the requested bucket, ignoring other buckets', () => {
    const w = { coins: 100, recharged: { web: 50, apple: 200, google: 10 } };
    expect(effectiveCoins(w, 'web')).toBe(150);
    expect(effectiveCoins(w, 'apple')).toBe(300);
    expect(effectiveCoins(w, 'google')).toBe(110);
  });
  it('absent recharged map / absent specific key → treated as 0', () => {
    expect(effectiveCoins({ coins: 40 }, 'apple')).toBe(40);
    expect(effectiveCoins({ coins: 40, recharged: { web: 10 } }, 'apple')).toBe(40);
  });
});

describe('displayChannelOf — which bucket a mutation result should report', () => {
  it('prefers the explicit clientPlatform when given, regardless of which channel was funded', () => {
    expect(displayChannelOf('apple', 'web')).toBe('web');
    expect(displayChannelOf(undefined, 'ios')).toBe('apple');
  });
  it('falls back to the funded channel when clientPlatform is absent (so a just-completed credit is visible)', () => {
    expect(displayChannelOf('apple', undefined)).toBe('apple');
    expect(displayChannelOf('google', undefined)).toBe('google');
  });
  it('falls back to web when neither is known (free-pool-only credits)', () => {
    expect(displayChannelOf(undefined, undefined)).toBe('web');
  });
});
