// Shared foundation for the SiegeService mixin chain (see ../combatSiege.ts assembly).
//
// SiegeServiceBase holds the single instance field (`core`, protected so every mixin body keeps
// referencing this.core verbatim) + the constructor. Each siege domain lives in its own sibling file
// as `XMixin(Base)` and is chained into the final SiegeService:
//   helpers.ts — recordSiege / transferLoot / applySectLeaderPenalty / passiveRelocate / buildDefenderConfig (leaf helpers shared by the other mixins)
//   damage.ts  — processDueSiegeDamage / settleSiegeDamage (ADR-026 delayed building-HP settlement)
//   arrival.ts — applySiege / applyBaseSiege / applyStrongholdSiege / landSiege / applySweep (siege / sweep arrival)
//   occupation.ts — applyOccupy / applyOccupationExpulsion / processDueOccupations (ADR-037 §5.4 occupation-hold settlement)
import type { WorldCore } from '../core';
import type { SiegeReplayInputs } from '../worldTypes';
import type { TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc } from '../db';
import type { SiegeOutcome, ResourceType } from '@nw/shared';

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type SiegeServiceBaseCtor = Constructor<SiegeServiceBase>;

export class SiegeServiceBase {
  constructor(protected readonly core: WorldCore) {}
}

// Cross-mixin method calls (helpers ← damage / arrival) type-check via interface/class declaration
// merging: methods a mixin calls but does not itself define are declared here so `this.transferLoot(...)`
// etc. resolve as METHODS (not properties, which would clash with the mixin override — TS2425). Emits
// NOTHING at runtime, so the real prototype methods provided by the mixins run and all bodies stay verbatim.
export interface SiegeServiceBase {
  recordSiege(m: MarchDoc, defenderId: string | undefined, outcome: SiegeOutcome, t: number, replay: SiegeReplayInputs | null): Promise<SiegeDoc>;
  transferLoot(defender: PlayerWorldDoc, attacker: PlayerWorldDoc, t: number): Promise<Record<ResourceType, number>>;
  applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void>;
  passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void>;
  buildDefenderConfig(target: TileDoc, effGarrison: number, inOwnNation: boolean): { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown; defenderBaseHp?: unknown } | null;
  applyOccupationExpulsion(m: MarchDoc, pw: PlayerWorldDoc, tile: TileDoc, t: number): Promise<void>;
}
