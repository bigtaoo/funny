// Unit tests (no Mongo) for combatSiege.ts's SiegeService — a thin assembly/delegation facade over
// its five independent sibling classes (helpers/damage/occupation/encounter/arrival). Its own
// function coverage sat at 63.15% because most e2e suites reach the underlying domain classes
// directly (or via httpApi/scheduler paths that never go through these particular pass-through
// methods by name) — every one of the ~17 wrapper methods below is a one-line
// `return this.sibling.method(...args)`, so pinning "the facade forwards to the right sibling with
// the right args and returns its result" for EVERY exported method (not just the ones some other
// suite happens to exercise) is exactly what was missing. Same spy-on-prototype-and-assert-identity
// technique as combatSiege-ctx-wiring.test.ts, but here there is no `.bind()` at construction time
// (each wrapper calls `this.sibling.method(...)` fresh), so spying any time before the call is safe.
import { describe, expect, it, vi } from 'vitest';
import { SiegeService } from '../src/combatSiege';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import { SiegeDamageService } from '../src/combatSiege/damage';
import { OccupationService } from '../src/combatSiege/occupation';
import { EncounterService } from '../src/combatSiege/encounter';
import { ArrivalService } from '../src/combatSiege/arrival';
import type { WorldCore } from '../src/core';

describe('SiegeService (combatSiege.ts) — every facade method forwards to its owning sibling', () => {
  const core = {} as WorldCore;
  const svc = new SiegeService(core);

  const cases: Array<{
    method: keyof SiegeService;
    proto: { prototype: Record<string, unknown> };
    protoMethod: string;
    args: unknown[];
  }> = [
    { method: 'buildDefenderConfig', proto: SiegeHelpersService, protoMethod: 'buildDefenderConfig', args: [{}, 10, false] },
    { method: 'recordSiege', proto: SiegeHelpersService, protoMethod: 'recordSiege', args: [{}, 'def-1', 'attacker_win', 100, null] },
    { method: 'transferLoot', proto: SiegeHelpersService, protoMethod: 'transferLoot', args: [{}, {}, 100] },
    { method: 'applySectLeaderPenalty', proto: SiegeHelpersService, protoMethod: 'applySectLeaderPenalty', args: ['w1', 'def-1', 100] },
    { method: 'passiveRelocate', proto: SiegeHelpersService, protoMethod: 'passiveRelocate', args: ['w1', 'def-1', 100] },
    { method: 'processDueSiegeDamage', proto: SiegeDamageService, protoMethod: 'processDueSiegeDamage', args: [100] },
    { method: 'applyOccupy', proto: OccupationService, protoMethod: 'applyOccupy', args: [{}, {}, 100] },
    { method: 'applyOccupationExpulsion', proto: OccupationService, protoMethod: 'applyOccupationExpulsion', args: [{}, {}, {}, 100] },
    { method: 'processDueOccupations', proto: OccupationService, protoMethod: 'processDueOccupations', args: [100] },
    { method: 'cancelOccupation', proto: OccupationService, protoMethod: 'cancelOccupation', args: ['w1', 'acc-1', 't1'] },
    { method: 'getOccupations', proto: OccupationService, protoMethod: 'getOccupations', args: ['w1', 'acc-1'] },
    { method: 'writeContestedHold', proto: OccupationService, protoMethod: 'writeContestedHold', args: [{}, {}, {}, 0, 0, 10, 100] },
    { method: 'startOccupationHold', proto: OccupationService, protoMethod: 'startOccupationHold', args: [{}, {}, {}, 0, 0, 10, 100, null] },
    { method: 'resolveFieldEncounter', proto: EncounterService, protoMethod: 'resolveFieldEncounter', args: [{}, {}, {}, 'tile-1', 100] },
    { method: 'applyTowerDamage', proto: EncounterService, protoMethod: 'applyTowerDamage', args: [{}, {}, {}, 100] },
    { method: 'applySiege', proto: ArrivalService, protoMethod: 'applySiege', args: [{}, {}, 100] },
    { method: 'applySweep', proto: ArrivalService, protoMethod: 'applySweep', args: [{}, {}, 100] },
  ];

  for (const { method, proto, protoMethod, args } of cases) {
    it(`${method}() forwards its exact arguments to ${proto.name}.prototype.${protoMethod} and returns its result`, async () => {
      const sentinel = { sentinel: `${method}-result` };
      const spy = vi.spyOn(proto.prototype as never, protoMethod).mockImplementation(async () => sentinel);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (svc[method] as any)(...args);
      expect(spy).toHaveBeenCalledWith(...args);
      expect(result).toBe(sentinel);
      spy.mockRestore();
    });
  }
});
