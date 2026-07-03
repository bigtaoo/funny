// worldsvc business layer — public facade (WorldService).
//
// The implementation was split out of a single 3800-line class by domain
// (god-class refactor, 2026-07-03). No behavior change: WorldService re-exposes the
// exact same public API, so all callers (httpApi / index / scheduler / e2e tests)
// import `{ WorldService }` from here unchanged.
//
//   worldTypes.ts  view/response interfaces + WorldServiceDeps
//   core.ts        WorldCore — shared state, map reads, vision, spawn,
//                  push/schedule infra, settle/yield, nations
//
// Domain method groups (combat / territory / city / season / shop) are peeled off
// WorldCore into their own files incrementally; WorldService composes them while
// inheriting the shared core surface.
import { WorldCore } from './core';

// Re-export the response/deps types so existing `import { ... } from './service'` keeps working.
export * from './worldTypes';

export class WorldService extends WorldCore {}
