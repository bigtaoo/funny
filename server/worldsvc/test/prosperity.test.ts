// prosperity.ts unit tests (previously 42.85%, gaps at effectiveProsperity's defaulting/clamping,
// computeTerritoryCount's empty-members short circuit, refreshFamilyProsperity's two-step chaining, and
// aggregateSectProsperity's sum). Uses fake WorldCollections/WorldSocialsvcClient objects — no real Mongo.
import { describe, expect, it, vi } from 'vitest';
import { decayProsperity } from '@nw/shared';
import {
  effectiveProsperity,
  computeTerritoryCount,
  refreshFamilyProsperity,
  aggregateSectProsperity,
} from '../src/prosperity';
import type { WorldCollections } from '../src/db';
import type { WorldSocialsvcClient, FamilySummary } from '../src/socialsvcClient';

const DAY_MS = 86_400_000;

function fam(overrides: Partial<FamilySummary> = {}): FamilySummary {
  return {
    familyId: 'fam-1',
    name: 'Fam',
    tag: 'F',
    leaderId: 'acc-leader',
    memberCount: 1,
    prosperity: 0,
    ...overrides,
  };
}

describe('effectiveProsperity', () => {
  it('prosperity undefined -> base defaults to 0', () => {
    const now = 1_000_000;
    expect(effectiveProsperity(fam({ prosperity: undefined as unknown as number }), now)).toBe(0);
  });

  it('prosperityUpdatedAt absent -> anchors to now (no decay applied)', () => {
    const now = 1_000_000;
    const result = effectiveProsperity(fam({ prosperity: 500 }), now);
    expect(result).toBe(decayProsperity(500, 0));
    expect(result).toBe(500);
  });

  it('applies the documented day-based decay when prosperityUpdatedAt is in the past', () => {
    const now = 10 * DAY_MS;
    const updatedAt = 0;
    const result = effectiveProsperity(fam({ prosperity: 1000, prosperityUpdatedAt: updatedAt }), now);
    expect(result).toBe(decayProsperity(1000, 10));
    expect(result).toBeLessThan(1000);
  });

  it('prosperityUpdatedAt in the future (clock skew) -> negative dt clamps to 0, no decay', () => {
    const now = 0;
    const updatedAt = 5 * DAY_MS; // "updated" after "now" -> dtDays would be negative
    const result = effectiveProsperity(fam({ prosperity: 300, prosperityUpdatedAt: updatedAt }), now);
    expect(result).toBe(decayProsperity(300, 0));
    expect(result).toBe(300);
  });
});

describe('computeTerritoryCount', () => {
  it('empty member list -> returns 0 without ever querying tiles', async () => {
    const countDocuments = vi.fn().mockResolvedValue(999);
    const cols = {
      playerWorld: { find: () => ({ project: () => ({ toArray: async () => [] }) }) },
      tiles: { countDocuments },
    } as unknown as WorldCollections;

    const count = await computeTerritoryCount(cols, 'w1', 'fam-1');
    expect(count).toBe(0);
    expect(countDocuments).not.toHaveBeenCalled();
  });

  it('non-empty member list -> queries tiles owned by any of those member accountIds', async () => {
    let findArgs: unknown;
    let countArgs: unknown;
    const cols = {
      playerWorld: {
        find: (args: unknown) => {
          findArgs = args;
          return {
            project: () => ({
              toArray: async () => [{ accountId: 'acc-a' }, { accountId: 'acc-b' }],
            }),
          };
        },
      },
      tiles: {
        countDocuments: async (args: unknown) => {
          countArgs = args;
          return 7;
        },
      },
    } as unknown as WorldCollections;

    const count = await computeTerritoryCount(cols, 'w1', 'fam-1');
    expect(count).toBe(7);
    expect(findArgs).toEqual({ worldId: 'w1', familyId: 'fam-1' });
    expect(countArgs).toEqual({ worldId: 'w1', ownerId: { $in: ['acc-a', 'acc-b'] } });
  });
});

describe('refreshFamilyProsperity', () => {
  it('computes territoryCount locally then delegates to socialsvc.refreshProsperity with it', async () => {
    const cols = {
      playerWorld: {
        find: () => ({
          project: () => ({ toArray: async () => [{ accountId: 'acc-a' }, { accountId: 'acc-b' }, { accountId: 'acc-c' }] }),
        }),
      },
      tiles: { countDocuments: async () => 12 },
    } as unknown as WorldCollections;

    const refreshProsperity = vi.fn().mockResolvedValue(4321);
    const socialsvc = { refreshProsperity } as unknown as WorldSocialsvcClient;

    const result = await refreshFamilyProsperity(cols, socialsvc, 'w1', 'fam-1');
    expect(result).toBe(4321);
    expect(refreshProsperity).toHaveBeenCalledWith('fam-1', 12);
  });
});

describe('aggregateSectProsperity', () => {
  it('sums effective (decayed) prosperity across all member families', () => {
    const now = 10 * DAY_MS;
    const fams: FamilySummary[] = [
      fam({ familyId: 'a', prosperity: 1000, prosperityUpdatedAt: 0 }),
      fam({ familyId: 'b', prosperity: 500, prosperityUpdatedAt: now }), // no decay (anchored at now)
      fam({ familyId: 'c', prosperity: 0 }),
    ];
    const expected = decayProsperity(1000, 10) + decayProsperity(500, 0) + decayProsperity(0, 0);
    expect(aggregateSectProsperity(fams, now)).toBe(expected);
  });

  it('empty array -> 0', () => {
    expect(aggregateSectProsperity([], Date.now())).toBe(0);
  });
});
