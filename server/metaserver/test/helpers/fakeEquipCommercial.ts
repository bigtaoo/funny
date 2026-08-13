// Fake CommercialClient for equipment/{enhance,reforge}.ts unit tests (only getWallet/spend are
// exercised by those two files; everything else is unused there). Mirrors the equivalent inline
// helper in equipment.e2e.test.ts (makeFakeCommercial), duplicated here for the src-import unit
// tests since that one lives in a test file that imports from ../dist and isn't meant to be shared.
import type { CommercialClient } from '../../src/commercialClient.js';

export interface FakeEquipCommercial extends CommercialClient {
  setCoins(id: string, n: number): void;
  bal(id: string): number;
  spendCalls: { accountId: string; amount: number; reason: string; orderId: string }[];
}

/** `available` defaults to true; pass false to test the NOT_IMPLEMENTED ("commercial unavailable") branch. */
export function makeFakeEquipCommercial(available = true): FakeEquipCommercial {
  const coins = new Map<string, number>();
  const spent = new Set<string>();
  const spendCalls: { accountId: string; amount: number; reason: string; orderId: string }[] = [];
  const bal = (id: string) => coins.get(id) ?? 0;
  return {
    available,
    spendCalls,
    setCoins: (id: string, n: number) => coins.set(id, n),
    bal,
    async getWallet(id: string) {
      return { coins: bal(id), pity: {} };
    },
    async spend(a: { accountId: string; amount: number; reason: string; orderId: string }) {
      spendCalls.push(a);
      if (spent.has(a.orderId)) return { ok: true as const, coinsAfter: bal(a.accountId) };
      if (bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
      coins.set(a.accountId, bal(a.accountId) - a.amount);
      spent.add(a.orderId);
      return { ok: true as const, coinsAfter: bal(a.accountId) };
    },
  } as unknown as FakeEquipCommercial;
}
