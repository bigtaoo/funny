// Phase-4 seam: worldsvc's CPU work served by a separate process over HTTP (worldsvc-concurrency-2026-09-05).
//
// STATUS: not built. This file exists so the decision is written down at the point of use rather than in a
// design doc nobody opens, and so switching to it is a config change instead of a refactor. User decision,
// 2026-09-05: "leave the seam now; when the player count justifies it I will build a separate service to
// handle the computation". Selecting it today (`NW_COMPUTE_BACKEND=remote`) fails fast at construction —
// silently falling back to the worker pool would hide a misconfigured deployment behind a latency cliff.
//
// The contract that service has to satisfy is exactly ComputeBackend (./types.ts), which is already written
// to be network-shaped: every payload is plain JSON, every call is request/response, nothing depends on
// object identity or shared memory. Concretely:
//
//   POST /compute/siege  { input: SiegeBattleInput }              -> { result: SiegeResolution }
//   POST /compute/path   { input: PathRequest }                   -> { result: PathCell[] | null }
//   POST /compute/warm   { world, mapW, mapH }                    -> { ok: true }
//
// Notes for whoever builds it, from what this workstream learned:
//   • Authenticate with X-Internal-Key and call it through `fetchInternalJson` (@nw/shared), like every
//     other internal hop — it must never be publicly reachable.
//   • Determinism is a hard requirement for /compute/siege: the client replays the battle locally from the
//     same seed, so the service must be pinned to the same @nw/engine version as worldsvc (ENGINE_VERSION).
//   • /compute/path is where the win is, and it is stateful in one specific way: the per-world terrain
//     index (~2.5s to build, ~6.75MB) must be warmed per instance, so the service needs /compute/warm
//     called at boot and needs sticky-by-world routing (or enough memory to hold every active world on
//     every instance) to avoid rebuilding it constantly.
//   • Keep the existing worker pool as the fallback path: a compute service outage must degrade worldsvc
//     to "slower", not to "no marches".
import type { SiegeResolution, PathCell } from '@nw/shared';
import type { ComputeBackend, PathRequest } from './types';
import type { SiegeBattleInput } from '../siegeEngine';

const NOT_BUILT = 'remote compute backend is not implemented yet (see worldsvc/src/compute/remote.ts); unset NW_COMPUTE_BACKEND to use the in-process worker pool';

export class RemoteComputeBackend implements ComputeBackend {
  readonly name = 'remote';

  constructor(_baseUrl: string, _internalKey: string) {
    throw new Error(NOT_BUILT);
  }

  runSiege(_input: SiegeBattleInput): Promise<SiegeResolution> {
    return Promise.reject(new Error(NOT_BUILT));
  }

  findPath(_req: PathRequest): Promise<PathCell[] | null> {
    return Promise.reject(new Error(NOT_BUILT));
  }

  warmWorld(): Promise<void> {
    return Promise.reject(new Error(NOT_BUILT));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
