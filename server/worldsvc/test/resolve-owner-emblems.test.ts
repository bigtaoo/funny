// Pure-ish unit tests for the map-token family-emblem batch resolver (2026-08-14, no Mongo, always-run).
// See design/product/family-emblem-art-prompts.md and combatShared.ts::resolveOwnerEmblems. Fakes
// just the two things the function touches (core.deps.cols.playerWorld.find + core.socialsvc.
// getFamiliesByIds) instead of constructing a real WorldCore — this is the batch-lookup logic
// itself (dedupe / no-family / no-badge / socialsvc-failure), not an integration test of
// getMarches/getOccupations/getStationed (already covered end-to-end by their own e2e suites).
import { describe, expect, it, vi } from 'vitest';
import { resolveOwnerEmblems } from '../src/combatShared';
import type { WorldCore } from '../src/core';
import type { FamilySummary } from '../src/socialsvcClient';

const WORLD = 'w1';

/** Minimal WorldCore stand-in: only `deps.cols.playerWorld.find(...).toArray()` and `socialsvc.getFamiliesByIds` are touched. */
function fakeCore(playerWorldDocs: Array<{ accountId: string; familyId?: string }>, families: FamilySummary[]): WorldCore {
  const getFamiliesByIds = vi.fn(async (ids: string[]) => families.filter((f) => ids.includes(f.familyId)));
  return {
    deps: {
      cols: {
        playerWorld: {
          find: () => ({ toArray: async () => playerWorldDocs }),
        },
      },
    },
    socialsvc: { getFamiliesByIds },
  } as unknown as WorldCore;
}

describe('resolveOwnerEmblems', () => {
  it('empty ownerIds → [] without touching playerWorld/socialsvc', async () => {
    const core = fakeCore([], []);
    expect(await resolveOwnerEmblems(core, WORLD, [])).toEqual([]);
  });

  it('owner has no family → undefined for that index, no socialsvc call needed', async () => {
    const core = fakeCore([{ accountId: 'solo' }], []);
    const getFamiliesByIds = core.socialsvc.getFamiliesByIds as unknown as ReturnType<typeof vi.fn>;
    expect(await resolveOwnerEmblems(core, WORLD, ['solo'])).toEqual([undefined]);
    expect(getFamiliesByIds).not.toHaveBeenCalled();
  });

  it('owner has a family but the family chose no badge → undefined for that index', async () => {
    const core = fakeCore(
      [{ accountId: 'a1', familyId: 'fam:AA' }],
      [{ familyId: 'fam:AA', name: 'A', tag: 'AA', leaderId: 'a1', memberCount: 1, prosperity: 0 }],
    );
    expect(await resolveOwnerEmblems(core, WORLD, ['a1'])).toEqual([undefined]);
  });

  it('owner has a family with a badge → {emblemKey, emblemColor} at that index', async () => {
    const core = fakeCore(
      [{ accountId: 'a1', familyId: 'fam:AA' }],
      [{ familyId: 'fam:AA', name: 'A', tag: 'AA', leaderId: 'a1', memberCount: 1, prosperity: 0, emblemKey: 'emblem_fox', emblemColor: 0xcc3333 }],
    );
    expect(await resolveOwnerEmblems(core, WORLD, ['a1'])).toEqual([{ emblemKey: 'emblem_fox', emblemColor: 0xcc3333 }]);
  });

  it('emblemColor absent on the family view → falls back to 0 rather than undefined (still a valid tint)', async () => {
    const core = fakeCore(
      [{ accountId: 'a1', familyId: 'fam:AA' }],
      [{ familyId: 'fam:AA', name: 'A', tag: 'AA', leaderId: 'a1', memberCount: 1, prosperity: 0, emblemKey: 'emblem_fox' }],
    );
    expect(await resolveOwnerEmblems(core, WORLD, ['a1'])).toEqual([{ emblemKey: 'emblem_fox', emblemColor: 0 }]);
  });

  it('same family repeated across many owners → one getFamiliesByIds call with the family deduped, result aligned per-index (repeats included)', async () => {
    const core = fakeCore(
      [{ accountId: 'a1', familyId: 'fam:AA' }, { accountId: 'a2', familyId: 'fam:AA' }],
      [{ familyId: 'fam:AA', name: 'A', tag: 'AA', leaderId: 'a1', memberCount: 2, prosperity: 0, emblemKey: 'emblem_owl', emblemColor: 1 }],
    );
    const getFamiliesByIds = core.socialsvc.getFamiliesByIds as unknown as ReturnType<typeof vi.fn>;
    // ownerIds intentionally repeats 'a1' (mirrors a real march list where the same owner can have
    // several in-transit marches) — every matching index gets the same resolved badge.
    const result = await resolveOwnerEmblems(core, WORLD, ['a1', 'a2', 'a1']);
    expect(result).toEqual([
      { emblemKey: 'emblem_owl', emblemColor: 1 },
      { emblemKey: 'emblem_owl', emblemColor: 1 },
      { emblemKey: 'emblem_owl', emblemColor: 1 },
    ]);
    expect(getFamiliesByIds).toHaveBeenCalledTimes(1);
    expect(getFamiliesByIds).toHaveBeenCalledWith(['fam:AA']);
  });

  it('socialsvc.getFamiliesByIds throws → degrades to all-undefined instead of failing the whole list', async () => {
    const core = fakeCore([{ accountId: 'a1', familyId: 'fam:AA' }], []);
    (core.socialsvc.getFamiliesByIds as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('socialsvc down'));
    await expect(resolveOwnerEmblems(core, WORLD, ['a1'])).resolves.toEqual([undefined]);
  });
});
