// Pure unit coverage for walletView() — the projection meta mirrors into save.monetization.
// Focus: firstPurchaseUsed (2026-07-17), which gates the client's "首充双倍" recharge badge. It must
// be derived from wallets.firstPurchasedAt (absent = never purchased = bonus still available = false).
import { describe, it, expect } from 'vitest';
import { walletView } from '../src/service/base';
import type { WalletDoc } from '../src/db';

/** Minimal well-formed wallet doc; spread overrides on top. */
function wallet(over: Partial<WalletDoc> = {}): WalletDoc {
  return { _id: 'a', coins: 0, rev: 0, gacha: { pity: {} }, updatedAt: 0, ...over };
}

describe('walletView — firstPurchaseUsed reflects firstPurchasedAt', () => {
  it('is false for a null (never-created) wallet', () => {
    expect(walletView(null).firstPurchaseUsed).toBe(false);
  });

  it('is false when firstPurchasedAt is absent (created but never purchased)', () => {
    expect(walletView(wallet()).firstPurchaseUsed).toBe(false);
  });

  it('is true once firstPurchasedAt is stamped (first-purchase bonus already claimed)', () => {
    expect(walletView(wallet({ firstPurchasedAt: 1_700_000_000_000 })).firstPurchaseUsed).toBe(true);
  });

  it('treats firstPurchasedAt: 0 as claimed (a real epoch timestamp, present = used)', () => {
    // != null guard, not truthiness — a 0ms stamp is still a claim and must not re-open the bonus.
    expect(walletView(wallet({ firstPurchasedAt: 0 })).firstPurchaseUsed).toBe(true);
  });
});
