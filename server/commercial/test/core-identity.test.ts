// Regression coverage for the 2026-08-11 mixin-chain-to-composition pass (claudedocs/server.md):
// CommercialService used to be a 10-mixin linear inheritance chain over CommercialServiceBase — every
// domain mixin shared `this` by construction. Composition removes that guarantee: the constructor now
// explicitly builds one `WalletCore` and passes it to 10 `new XService(this.core)` calls — money-
// critical code, so a copy-paste that accidentally constructs a SECOND `WalletCore` (splitting the
// shared `cols`/`now`/`rng`/`verifyReceipt` state two domains would then read inconsistently) is
// exactly the class of bug worth pinning directly, not just hoping the e2e suite's specific account/
// order-id choices happen to expose it.
import { describe, expect, it } from 'vitest';
import { CommercialService } from '../src/service';
import type { CommercialDeps } from '../src/service/base';

const DOMAIN_FIELDS = [
  'gachaPool', 'shop', 'gachaDrawSvc', 'subscription', 'starter', 'recharge', 'promo', 'rewards', 'orders', 'audit',
] as const;

describe('CommercialService composition wiring: one shared WalletCore (2026-08-11 chain→composition pass)', () => {
  it('every domain instance holds the exact same WalletCore the facade constructed — not 10 independent copies', () => {
    const svc = new CommercialService({} as CommercialDeps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    expect(s.core).toBeDefined();
    for (const field of DOMAIN_FIELDS) {
      expect(s[field], `${field}.core should be the shared WalletCore`).toBeDefined();
      expect(s[field].core).toBe(s.core);
    }
  });
});
