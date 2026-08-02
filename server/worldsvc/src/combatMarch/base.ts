// Shared foundation for the MarchService mixin chain (see ../combatMarch.ts assembly).
//
// MarchServiceBase holds the two instance fields (`core` and `siege`, protected so every mixin body
// keeps referencing this.core / this.siege verbatim) + the constructor. Each march domain lives in
// its own sibling file as `XMixin(Base)` and is chained into the final MarchService:
//   command.ts   — startMarch / recallMarch / instantReturnMarch / getMarches (player-issued commands)
//   arrival.ts   — processDueArrivals / advanceMarch / applyArrival / applyMove / tryParkTeam (scheduler-driven settlement)
//   stationed.ts — recallStationed / getStationed (troops parked at a destination)
import { WorldCore } from '../core';
import type { SiegeService } from '../combatSiege';



export class MarchServiceBase {


  constructor(
    protected readonly core: WorldCore,
    protected readonly siege: SiegeService,
  ) {}


}

export type Constructor<T = object> = new (...args: any[]) => T;
export type MarchServiceBaseCtor = Constructor<MarchServiceBase>;

// ── Domain entrypoints dispatched to from base-level code (the render dispatcher) and across
// sibling mixins. Declared via interface/class declaration merging so base-level calls type-check
// as METHODS (properties would clash with the mixin override — TS2425). Emits NOTHING at runtime,
// so the real prototype methods provided by the mixins run and every body stays verbatim.
export interface MarchServiceBase {

}
