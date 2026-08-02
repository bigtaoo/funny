// worldsvc business layer — WorldCore shared kernel (assembled).
//
// WorldCore was a single ~1070-line class holding all shared state + read/vision/spawn/
// yield/push/nation primitives that every domain subservice (city / combat / territory /
// season / shop) leans on. It is now split by concern across a linear inheritance chain,
// one file per layer under ./core/, so no `core.xxx` call site changes and the composed object
// is identical. Thin assembly file, same convention as combatSiege.ts over ./combatSiege/*:
// WorldCore stays exported HERE so importers (`from './core'`) keep resolving to this file,
// not the directory. To add a layer: extend the chain below — do NOT grow this file.
//
//   core/kernel.ts  WorldCoreKernel  — clients, deps, sequences, capitals, bounds/coord, marchView
//   core/yield.ts   WorldCoreYield   — settle / yieldRecord / recomputeYield
//   core/push.ts    WorldCorePush    — Redis schedule ZSETs + gateway push helpers
//   core/nation.ts  WorldCoreNation  — nation init / founding / naming / lookup
//   core/spawn.ts   WorldCoreSpawn   — spawn selection + 3×3 base footprint helpers (ADR-025)
//   core/vision.ts  WorldCoreVision  — family/sect membership, fog-of-war vision, observers
//   core/map.ts     WorldCoreMap     — map / tile / getMe reads + tile→view mappers
//
// Standalone free functions & constants live in core/helpers.ts; they are re-exported here so
// existing `import { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './core'`
// call sites keep working unchanged.
import { WorldCoreMap } from './core/map';

export { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './core/helpers';

/** The full shared kernel, composed from the concern layers. WorldService extends this. */
export class WorldCore extends WorldCoreMap {}
