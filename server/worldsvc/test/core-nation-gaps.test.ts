// core/nation.ts branch gap (2026-08-15): getNationAt is exposed on WorldCore/WorldService but never
// called anywhere in worldsvc's own code or the existing test suite — dead-from-here but part of the
// public service surface, so it's worth a direct unit test. No Mongo: only touches
// core.deps.cols.nations.findOne, trivially faked.
import { describe, expect, it, vi } from 'vitest';
import { NationService } from '../src/core/nation';
import type { WorldCore } from '../src/core';
import type { NationDoc } from '../src/db';

function build(nation: NationDoc | null) {
  const findOne = vi.fn(async () => nation);
  const core = { deps: { cols: { nations: { findOne } } } } as unknown as WorldCore;
  return { svc: new NationService(core), findOne };
}

describe('NationService.getNationAt', () => {
  it('resolves the province at (x,y) to its nation doc when one exists', async () => {
    const doc: NationDoc = { _id: 'nation:w1:0', worldId: 'w1', capitalIdx: 0, x: 5, y: 5, rev: 1 };
    const { svc, findOne } = build(doc);
    const result = await svc.getNationAt('w1', 5, 5);
    expect(result).toBe(doc);
    expect(findOne).toHaveBeenCalledWith({ _id: expect.stringMatching(/^nation:w1:\d+$/) });
  });

  it('returns null when the province is ownerless (no nation doc yet)', async () => {
    const { svc } = build(null);
    await expect(svc.getNationAt('w1', 5, 5)).resolves.toBeNull();
  });
});
