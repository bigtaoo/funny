// Regression coverage for the 2026-08-11 mixin-chain-to-composition pass (claudedocs/server.md):
// MarchService used to be a 3-mixin linear inheritance chain over MarchServiceBase (which held both
// `core` AND `siege` as constructor-set fields shared by every mixin). Composition removes that
// guarantee: command.ts/stationed.ts only ever need `core`, and arrival.ts is the ONE sibling that
// also needs `siege` — a copy-paste at construction time (in combatMarch.ts) could pass the wrong
// `SiegeService` instance to ArrivalService, or the wrong `WorldCore` to any of the three, without
// tripping a type error (all three constructors accept the exact same `WorldCore`/`SiegeService`
// types). This test pins that every sibling holds the exact same `core` (and, for arrival, `siege`)
// the facade itself was constructed with.
import { describe, expect, it } from 'vitest';
import { MarchService } from '../src/combatMarch';
import type { WorldCore } from '../src/core';
import type { SiegeService } from '../src/combatSiege';

describe('MarchService composition wiring: shared core (+siege for arrival) (2026-08-11 chain→composition pass)', () => {
  it('command/arrival/stationed all hold the same core, and arrival also holds the exact siege instance passed in', () => {
    const core = {} as WorldCore;
    const siege = {} as SiegeService;
    const svc = new MarchService(core, siege);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;

    expect(s.command.core).toBe(core);
    expect(s.arrival.core).toBe(core);
    expect(s.stationed.core).toBe(core);
    expect(s.arrival.siege).toBe(siege);
  });
});
