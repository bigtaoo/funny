// worldsvc combat domain: siege / sweep arrival settlement (S8-3) + delayed building-HP model (ADR-026).
// Peeled out of CombatService (2026-07-03); split by domain into ./combatSiege/*.ts (2026-07-07). Depends on
// WorldCore for shared state, settle/yield, push/schedule infra, loot protection
// and vision. Marches (combatMarch) dispatch attack/sweep arrivals here via applySiege / applySweep, and the
// scheduler drives processDueSiegeDamage. No behavior change.
//
// Thin assembly file: the service is composed by holding five independent sibling instances — helpers (the
// base layer: recordSiege/transferLoot/applySectLeaderPenalty/passiveRelocate/buildDefenderConfig), damage
// (ADR-026 delayed building-HP), occupation (ADR-037 occupation-hold), encounter (ADR-051 P2b field battles),
// and arrival (siege/sweep dispatch — the only one needing both helpers AND occupation). No shared base
// class, no mixin chain (2026-08-11: converted from the `XMixin(Base)` chain per claudedocs/server.md's
// "拆分形态的优先级" 形态②/独立类+组合 — the cross-mixin call graph turned out to be a clean DAG: helpers
// has zero out-edges and everything else either depends on helpers alone or on helpers+occupation, so
// composition with a couple of narrow injected references, same shape as Gateway.ts/Matchsvc.ts, fits better
// than a 5-deep inheritance chain). SiegeService stays exported HERE so importers (`from './combatSiege'` in
// combat.ts / combatMarch/arrival.ts) keep resolving to this file, not the directory. To add a handler: find
// the matching domain class or add a new one — do NOT grow this file, and do NOT let helpers depend on
// anything else (it is the DAG's root).
import { WorldCore } from './core';
import { SiegeHelpersService } from './combatSiege/helpers';
import { SiegeDamageService } from './combatSiege/damage';
import { OccupationService } from './combatSiege/occupation';
import { EncounterService } from './combatSiege/encounter';
import { ArrivalService } from './combatSiege/arrival';

/**
 * SiegeService — siege / sweep settlement + ADR-026 delayed building-HP model.
 * Constructed as `new SiegeService(core)`; composed from five independent sibling classes.
 */
export class SiegeService {
  private readonly helpers: SiegeHelpersService;
  private readonly damage: SiegeDamageService;
  private readonly occupation: OccupationService;
  private readonly encounter: EncounterService;
  private readonly arrival: ArrivalService;

  constructor(core: WorldCore) {
    this.helpers = new SiegeHelpersService(core);
    this.damage = new SiegeDamageService(core, this.helpers);
    this.occupation = new OccupationService(core, this.helpers);
    this.encounter = new EncounterService(core, this.helpers);
    this.arrival = new ArrivalService(core, this.helpers, this.occupation);
  }

  // ── helpers ──
  buildDefenderConfig(...args: Parameters<SiegeHelpersService['buildDefenderConfig']>) { return this.helpers.buildDefenderConfig(...args); }
  recordSiege(...args: Parameters<SiegeHelpersService['recordSiege']>) { return this.helpers.recordSiege(...args); }
  transferLoot(...args: Parameters<SiegeHelpersService['transferLoot']>) { return this.helpers.transferLoot(...args); }
  applySectLeaderPenalty(...args: Parameters<SiegeHelpersService['applySectLeaderPenalty']>) { return this.helpers.applySectLeaderPenalty(...args); }
  passiveRelocate(...args: Parameters<SiegeHelpersService['passiveRelocate']>) { return this.helpers.passiveRelocate(...args); }

  // ── damage ──
  processDueSiegeDamage(...args: Parameters<SiegeDamageService['processDueSiegeDamage']>) { return this.damage.processDueSiegeDamage(...args); }

  // ── occupation ──
  applyOccupy(...args: Parameters<OccupationService['applyOccupy']>) { return this.occupation.applyOccupy(...args); }
  applyOccupationExpulsion(...args: Parameters<OccupationService['applyOccupationExpulsion']>) { return this.occupation.applyOccupationExpulsion(...args); }
  processDueOccupations(...args: Parameters<OccupationService['processDueOccupations']>) { return this.occupation.processDueOccupations(...args); }
  cancelOccupation(...args: Parameters<OccupationService['cancelOccupation']>) { return this.occupation.cancelOccupation(...args); }
  getOccupations(...args: Parameters<OccupationService['getOccupations']>) { return this.occupation.getOccupations(...args); }
  writeContestedHold(...args: Parameters<OccupationService['writeContestedHold']>) { return this.occupation.writeContestedHold(...args); }
  startOccupationHold(...args: Parameters<OccupationService['startOccupationHold']>) { return this.occupation.startOccupationHold(...args); }

  // ── encounter ──
  resolveFieldEncounter(...args: Parameters<EncounterService['resolveFieldEncounter']>) { return this.encounter.resolveFieldEncounter(...args); }
  applyTowerDamage(...args: Parameters<EncounterService['applyTowerDamage']>) { return this.encounter.applyTowerDamage(...args); }

  // ── arrival ──
  applySiege(...args: Parameters<ArrivalService['applySiege']>) { return this.arrival.applySiege(...args); }
  applySweep(...args: Parameters<ArrivalService['applySweep']>) { return this.arrival.applySweep(...args); }
}
