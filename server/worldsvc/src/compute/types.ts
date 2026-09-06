// The compute seam (worldsvc-concurrency-2026-09-05, phase 1 / phase 4 hook).
//
// worldsvc is a single Node event loop. Everything it does per request is I/O — except two pure,
// CPU-bound computations that are heavy enough to stop the whole process while they run:
//
//   • the deterministic siege engine (up to ~18,600 ticks for an evenly-matched base siege), moved off
//     the loop in SERVER_LOGIC_AUDIT_2026-07-29 item 15;
//   • A* march pathfinding, measured at 2-6 SECONDS on an unreachable target and hundreds of ms on a
//     long one (WORLDSVC_CONCURRENCY_AUDIT_2026-09-05) — the direct cause of the "my fifth team's order
//     lags" report that opened that audit.
//
// Both are pure functions of their input: same input, same output, no DB, no clock, no shared state. That
// is what lets them run anywhere — and it is why this file exists as an interface rather than as a direct
// call into the worker pool.
//
// PHASE 4 SEAM (user decision, 2026-09-05): when the player count justifies it, this computation moves out
// of worldsvc entirely into a dedicated compute service, and worldsvc talks to it over the network. Nothing
// in the business layer should have to change for that: call sites depend on {@link ComputeBackend} only,
// `NW_COMPUTE_BACKEND` selects the implementation, and remote.ts already states the contract that service
// has to satisfy. Keep this interface free of anything a remote implementation could not honour — no
// callbacks, no shared memory, no object identity: every argument and result must survive being JSON.
import type { SiegeResolution, PathCell } from '@nw/shared';
import type { SiegeBattleInput } from '../siegeEngine';

/**
 * One A* pathfinding request. Mirrors `findMarchPath`'s parameters, with the two `Set`s flattened to
 * arrays so the payload is plain JSON (a `Set` survives structured clone but not a network hop, and the
 * remote backend must not need a different shape).
 */
export interface PathRequest {
  world: string;
  mapW: number;
  mapH: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  /** Crossing tiles ("x:y") the marcher may pass — bridges/plankways held by their faction or allies. */
  passableGateKeys: string[];
  /** Enemy capital footprints and hostile blocker structures ("x:y") that the route must go around. */
  blockedBaseKeys: string[];
}

/**
 * Where worldsvc sends its CPU-bound work. Two implementations today: the in-process worker pool
 * (`pool.ts`) and the not-yet-built remote service (`remote.ts`). Selected by {@link getComputeBackend}.
 */
export interface ComputeBackend {
  /** Identifies the implementation in logs and in the heartbeat (`worker` / `remote`). */
  readonly name: string;

  /** Run one authoritative siege battle. Rejects on bad input or backend failure; callers already catch. */
  runSiege(input: SiegeBattleInput): Promise<SiegeResolution>;

  /**
   * Find a march path, or resolve `null` when the destination is unreachable. Backends are expected to
   * apply the cheap terrain-connectivity proof before running A* (see `@nw/shared`'s mapTerrainIndex) —
   * that is what turns the multi-second unreachable case into a lookup.
   */
  findPath(req: PathRequest): Promise<PathCell[] | null>;

  /**
   * Precompute whatever per-world state pathing needs (terrain classification + connectivity), so the
   * first real march of the day does not pay the ~2.5s build. Best-effort: a failure here degrades to
   * "the first path request for that world is slow", never to a wrong answer.
   */
  warmWorld(world: string, mapW: number, mapH: number): Promise<void>;

  /** Release resources (worker threads / sockets). Called from worldsvc's shutdown handler. */
  close(): Promise<void>;
}
