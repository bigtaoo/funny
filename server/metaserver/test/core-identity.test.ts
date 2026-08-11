// Regression coverage for the 2026-08-11 mixin-chain-to-composition pass (claudedocs/server.md):
// MetaService used to be a 9-mixin linear inheritance chain over MetaServiceBase — every domain mixin
// shared `this` by construction. Composition removes that guarantee: the constructor now explicitly
// builds one `MetaCore` and passes it to 9 `new XService(this.core)` calls — a copy-paste that
// accidentally constructs a SECOND `MetaCore` would split the shared `deps` (cols/jwt/commercial/etc.)
// across domains, each still individually functional but silently inconsistent with the others.
import { describe, expect, it } from 'vitest';
import { MetaService } from '../src/service';
import type { ServiceDeps } from '../src/service/base';

const DOMAIN_FIELDS = [
  'authSvc', 'saveSvc', 'pveSvc', 'economySvc', 'inventorySvc', 'progressionSvc', 'liveopsSvc', 'socialSvc', 'telemetrySvc',
] as const;

describe('MetaService composition wiring: one shared MetaCore (2026-08-11 chain→composition pass)', () => {
  it('every domain instance holds the exact same MetaCore the facade constructed — not 9 independent copies', () => {
    const svc = new MetaService({} as ServiceDeps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    expect(s.core).toBeDefined();
    for (const field of DOMAIN_FIELDS) {
      expect(s[field], `${field}.core should be the shared MetaCore`).toBeDefined();
      expect(s[field].core).toBe(s.core);
    }
  });
});
