// worldsvc business layer — WorldCore shared kernel (assembled).
//
// WorldCore was a single ~1070-line class holding all shared state + read/vision/spawn/
// yield/push/nation primitives that every domain subservice (city / combat / territory /
// season / shop) leans on. It is now split by concern across a linear inheritance chain,
// one file per layer, so no `core.xxx` call site changes and the composed object is identical:
//
//   coreKernel.ts  WorldCoreKernel  — clients, deps, sequences, capitals, bounds/coord, marchView
//   coreYield.ts   WorldCoreYield   — settle / yieldRecord / recomputeYield
//   corePush.ts    WorldCorePush    — Redis schedule ZSETs + gateway push helpers
//   coreNation.ts  WorldCoreNation  — nation init / founding / naming / lookup
//   coreSpawn.ts   WorldCoreSpawn   — spawn selection + 3×3 base footprint helpers (ADR-025)
//   coreVision.ts  WorldCoreVision  — family/sect membership, fog-of-war vision, observers
//   coreMap.ts     WorldCoreMap     — map / tile / getMe reads + tile→view mappers
//
// Standalone free functions & constants live in coreHelpers.ts; they are re-exported here so
// existing `import { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './core'`
// call sites keep working unchanged.
import { WorldCoreMap } from './coreMap';

export { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './coreHelpers';

/** The full shared kernel, composed from the concern layers. WorldService extends this. */
export class WorldCore extends WorldCoreMap {}
