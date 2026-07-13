// worldsvc combat domain: siege / sweep arrival settlement (S8-3) + delayed building-HP model (ADR-026).
// Peeled out of CombatService (2026-07-03); split by domain into ./combatSiege/*.ts (2026-07-07). Depends on
// WorldCore for shared state, settle/yield, push/schedule infra, nations (applyNationChange), loot protection
// and vision. Marches (combatMarch) dispatch attack/sweep arrivals here via applySiege / applySweep, and the
// scheduler drives processDueSiegeDamage. No behavior change.
//
// Thin assembly file: the service is composed via the mixin chain below over SiegeServiceBase
// (./combatSiege/base.ts, which owns the single `core` field + constructor + cross-mixin method decls).
// Each siege domain lives in its own sibling file (helpers / damage / arrival). SiegeService stays exported
// HERE so importers (`from './combatSiege'` in combat.ts / combatMarch.ts) keep resolving to this file, not
// the directory. To add a handler: find the matching domain mixin or add a new one to the chain — do NOT
// grow this file.
import { SiegeServiceBase } from './combatSiege/base';
import { SiegeHelpersMixin } from './combatSiege/helpers';
import { SiegeDamageMixin } from './combatSiege/damage';
import { SiegeArrivalMixin } from './combatSiege/arrival';
import { OccupationMixin } from './combatSiege/occupation';

const Assembled = SiegeArrivalMixin(
  OccupationMixin(
    SiegeDamageMixin(
      SiegeHelpersMixin(SiegeServiceBase),
    ),
  ),
);

/**
 * SiegeService — siege / sweep settlement + ADR-026 delayed building-HP model.
 * Assembled from the per-domain mixin chain over SiegeServiceBase. Constructed as `new SiegeService(core)`.
 */
export class SiegeService extends Assembled {}
