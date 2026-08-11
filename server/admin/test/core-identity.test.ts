// Regression coverage for the 2026-08-11 mixin-chain-to-composition pass (claudedocs/server.md):
// AdminService used to be an 18-mixin linear inheritance chain over AdminServiceBase — every domain
// mixin shared `this` by construction, so there was structurally no way to end up with two different
// bases. Composition removes that guarantee: `AdminService`'s constructor now explicitly builds one
// `AdminCore` and passes it to 18 `new XService(this.core)` calls — a future edit that accidentally
// constructs a SECOND `AdminCore` (e.g. copy-pasting a constructor line and forgetting to reuse
// `this.core`) would silently split shared state (the cross-cutting `audit`/`requireCap`/`actorNames`
// methods, and the `cols`/`now`/etc. deps fields every domain reads) across two instances — each
// domain would still work in isolation, so this wouldn't surface as an obvious crash, just as subtly
// inconsistent behavior (e.g. one domain's audit write using a different `now()` than another's).
// This test pins the invariant directly: every one of the 18 domain instances holds the exact SAME
// `AdminCore` object identity as the facade itself.
import { describe, expect, it } from 'vitest';
import { AdminService } from '../src/service';
import type { AdminServiceDeps } from '../src/service/base';

const DOMAIN_FIELDS = [
  'events', 'gacha', 'promo', 'paddleEvents', 'ladder', 'world', 'mapTemplates', 'slgAudit',
  'auth', 'accounts', 'tickets', 'analytics', 'flags', 'shop', 'moderation', 'reports', 'appeals', 'feedback',
] as const;

describe('AdminService composition wiring: one shared AdminCore (2026-08-11 chain→composition pass)', () => {
  it('every domain instance holds the exact same AdminCore the facade constructed — not 18 independent copies', () => {
    // Deps are never read (no method call here touches them) — an empty stub satisfies the
    // pre-existing untyped `(...args: any[])` constructor, same as this file's sibling e2e tests.
    const svc = new AdminService({} as AdminServiceDeps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    expect(s.core).toBeDefined();
    for (const field of DOMAIN_FIELDS) {
      expect(s[field], `${field}.core should be the shared AdminCore`).toBeDefined();
      expect(s[field].core).toBe(s.core);
    }
  });
});
