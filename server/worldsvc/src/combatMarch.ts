// worldsvc combat domain: march start / recall / listing + arrival processing & dispatch (S8-2).
// Thin assembly file, same convention as combatSiege.ts over ./combatSiege/*.
//
// The service is composed via the mixin chain below over MarchServiceBase (./combatMarch/base.ts,
// which owns the two fields — `core` for shared state and `siege` for attack/sweep dispatch — plus
// the constructor). Each march domain lives in its own sibling file (command / arrival / stationed).
// MarchService stays exported HERE so importers (`from './combatMarch'` in combat.ts) keep resolving
// to this file, not the directory. To add a handler: find the matching domain mixin or add a new one
// to the chain — do NOT grow this file.
import { MarchServiceBase } from './combatMarch/base';
import { CommandMixin } from './combatMarch/command';
import { ArrivalMixin } from './combatMarch/arrival';
import { StationedMixin } from './combatMarch/stationed';

const Assembled = StationedMixin(ArrivalMixin(CommandMixin(MarchServiceBase)));

/**
 * MarchService — march lifecycle: departure, in-flight recall, arrival settlement and stationing.
 * Assembled from the per-domain mixin chain. Constructed as `new MarchService(core, siege)`.
 */
export class MarchService extends Assembled {}
