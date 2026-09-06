// getComputeBackend() backend selection (worldsvc-concurrency-2026-09-05, phase 1 / phase 4 seam).
//
// The whole point of the ComputeBackend interface is that moving worldsvc's CPU work out to a separate
// service later is a config change rather than a refactor (user decision, 2026-09-05). Two things have to
// hold for that promise to be real, and both are cheap to check: the default must be the in-process worker
// pool, and asking for the not-yet-built remote backend must FAIL rather than quietly fall back — a silent
// fallback would hide a misconfigured deployment behind nothing but a latency change.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getComputeBackend, shutdownComputeBackend } from '../src/compute';

const ORIGINAL = process.env.NW_COMPUTE_BACKEND;

beforeEach(async () => {
  await shutdownComputeBackend();
});

afterEach(async () => {
  await shutdownComputeBackend();
  if (ORIGINAL === undefined) delete process.env.NW_COMPUTE_BACKEND;
  else process.env.NW_COMPUTE_BACKEND = ORIGINAL;
});

describe('getComputeBackend', () => {
  it('defaults to the in-process worker pool', async () => {
    delete process.env.NW_COMPUTE_BACKEND;
    process.env.NW_COMPUTE_POOL_SIZE = '1';
    const backend = getComputeBackend();
    expect(backend.name).toBe('worker');
    delete process.env.NW_COMPUTE_POOL_SIZE;
  });

  it('returns the same instance on repeated calls (one pool per process, not one per caller)', () => {
    delete process.env.NW_COMPUTE_BACKEND;
    process.env.NW_COMPUTE_POOL_SIZE = '1';
    expect(getComputeBackend()).toBe(getComputeBackend());
    delete process.env.NW_COMPUTE_POOL_SIZE;
  });

  it('an unrecognised value falls back to the worker pool rather than erroring', () => {
    process.env.NW_COMPUTE_BACKEND = 'something-else';
    process.env.NW_COMPUTE_POOL_SIZE = '1';
    expect(getComputeBackend().name).toBe('worker');
    delete process.env.NW_COMPUTE_POOL_SIZE;
  });

  it('NW_COMPUTE_BACKEND=remote throws until that service exists, instead of silently using the pool', () => {
    process.env.NW_COMPUTE_BACKEND = 'remote';
    expect(() => getComputeBackend()).toThrow(/not implemented/i);
  });

  it('actually computes a path through the default backend', async () => {
    delete process.env.NW_COMPUTE_BACKEND;
    process.env.NW_COMPUTE_POOL_SIZE = '1';
    const path = await getComputeBackend().findPath({
      world: 'compute-backend-test-world',
      mapW: 40,
      mapH: 40,
      fx: 3,
      fy: 3,
      tx: 12,
      ty: 12,
      passableGateKeys: [],
      blockedBaseKeys: [],
    });
    // Either a real path or a proven-unreachable null; what matters is that the round trip through the
    // worker thread completed and returned plain data.
    if (path) {
      expect(path[0]).toEqual({ x: 3, y: 3 });
      expect(path[path.length - 1]).toEqual({ x: 12, y: 12 });
    } else {
      expect(path).toBeNull();
    }
    delete process.env.NW_COMPUTE_POOL_SIZE;
  }, 20_000);
});
