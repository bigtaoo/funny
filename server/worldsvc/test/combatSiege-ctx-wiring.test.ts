// Regression coverage for the 2026-08-11 combatSiege re-audit (claudedocs/server.md): converting the
// 5-mixin linear inheritance chain into composition is the one chain of the six converted that day
// with REAL cross-layer calls (14 of them) — ArrivalService binds a handful of SiegeHelpersService/
// OccupationService methods into a plain `SiegeCtx` object (combatSiege/ctx.ts) and hands that to the
// five arrival/*.ts free functions, which is exactly the shape metaserver's pve.ts/liveops.ts already
// used to sidestep MetaServiceBase's `protected` wall. That ctx-bind step is precisely the part
// existing e2e tests don't specifically pin: they exercise full siege/occupy/sweep business flows and
// would still pass even if, say, `startOccupationHold` were accidentally bound to `helpers` instead of
// `occupation` (both are legal `.bind()` targets from a typing standpoint — a mis-wiring here fails at
// runtime with "not a function" or silently calls the wrong implementation, not a compile error).
//
// No Mongo: `core` is never actually touched below (every helpers/occupation method the ctx binds to
// is mocked out), so an empty `{} as WorldCore` is enough — same "hand-built fake, no Mongo" style as
// occupation-battle.test.ts / get-teams-card-lookup.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import { OccupationService } from '../src/combatSiege/occupation';
import { ArrivalService } from '../src/combatSiege/arrival';
import type { WorldCore } from '../src/core';
import type { SiegeCtx } from '../src/combatSiege/ctx';

/** Reads the private `ctx` field ArrivalService builds in its constructor — TS privacy is
 *  compile-time only, so this is a plain, unhidden property at runtime (same access pattern already
 *  used by worldsvc/admin's own `(svc as any).xxx` test reaches). */
function ctxOf(arrival: ArrivalService): SiegeCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (arrival as any).ctx as SiegeCtx;
}

describe('combatSiege ArrivalService ctx-bind wiring (2026-08-11 chain→composition re-audit)', () => {
  it('binds recordSiege/transferLoot/applySectLeaderPenalty/passiveRelocate to the INJECTED SiegeHelpersService instance (not a detached copy)', async () => {
    // `.bind()` permanently fixes `this` at bind time — calling the resulting bound function can never
    // observe a different `this` no matter how it's later invoked. So the way to actually prove "bound
    // to the right sibling" (not just "some function got called") is to capture `this` inside the mock
    // implementation itself and assert its identity — vi.spyOn's call-count assertions alone would NOT
    // catch a mis-wiring here: a bound mock function still records its call even when bound to the
    // WRONG object, since mock call-tracking is `this`-agnostic (verified by deliberately mis-wiring
    // writeContestedHold to `helpers` while developing this test — the naive "toHaveBeenCalledTimes"
    // version below kept passing; only capturing and asserting `this` catches it).
    const core = {} as WorldCore;
    const helpers = new SiegeHelpersService(core);
    const seenThis: unknown[] = [];
    vi.spyOn(helpers, 'recordSiege').mockImplementation(async function (this: unknown) { seenThis.push(this); return { _id: 'siege-1' } as never; });
    vi.spyOn(helpers, 'transferLoot').mockImplementation(async function (this: unknown) { seenThis.push(this); return {} as never; });
    vi.spyOn(helpers, 'applySectLeaderPenalty').mockImplementation(async function (this: unknown) { seenThis.push(this); });
    vi.spyOn(helpers, 'passiveRelocate').mockImplementation(async function (this: unknown) { seenThis.push(this); });
    const occupation = new OccupationService(core, helpers);
    // The bind happens INSIDE ArrivalService's constructor — must be constructed AFTER the spies are
    // installed, otherwise `.bind()` would capture the original (un-spied) method reference and this
    // test would silently exercise the real implementation instead of proving the wiring.
    const arrival = new ArrivalService(core, helpers, occupation);
    const ctx = ctxOf(arrival);

    await ctx.recordSiege({} as never, 'defender-1', 'attacker_win', 100, null);
    await ctx.transferLoot({} as never, {} as never, 100);
    await ctx.applySectLeaderPenalty('w1', 'defender-1', 100);
    await ctx.passiveRelocate('w1', 'defender-1', 100);

    expect(seenThis).toHaveLength(4);
    expect(seenThis.every((t) => t === helpers)).toBe(true);
  });

  it('binds writeContestedHold/startOccupationHold to the INJECTED OccupationService instance, not SiegeHelpersService', async () => {
    const core = {} as WorldCore;
    const helpers = new SiegeHelpersService(core);
    const occupation = new OccupationService(core, helpers);
    const seenThis: unknown[] = [];
    vi.spyOn(occupation, 'writeContestedHold').mockImplementation(async function (this: unknown) { seenThis.push(this); });
    vi.spyOn(occupation, 'startOccupationHold').mockImplementation(async function (this: unknown) { seenThis.push(this); });
    const arrival = new ArrivalService(core, helpers, occupation);
    const ctx = ctxOf(arrival);

    await ctx.writeContestedHold({} as never, {} as never, {} as never, 0, 0, 10, 100);
    await ctx.startOccupationHold({} as never, {} as never, {} as never, 0, 0, 10, 100, null);

    expect(seenThis).toHaveLength(2);
    expect(seenThis.every((t) => t === occupation)).toBe(true);
    expect(seenThis.every((t) => t !== helpers)).toBe(true);
  });
});
