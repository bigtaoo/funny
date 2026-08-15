// SectQueryService.getSect branch gap (2026-08-15): the member-family emblemKey/emblemColor spread
// (query.ts lines ~38-39) is never exercised in test/sect.e2e.test.ts's FakeSocialsvc, which never
// populates those fields on a FamilySummary. No Mongo: getSect only touches deps.cols.sects.findOne
// and the socialsvc client, both trivially faked (mirrors combatDefense-gaps.test.ts's style).
import { describe, expect, it, vi } from 'vitest';
import { SectQueryService } from '../src/sect/query';
import type { SectServiceDeps } from '../src/sect/types';
import type { FamilySummary, WorldSocialsvcClient } from '../src/socialsvcClient';
import type { SectDoc } from '../src/db';

function build(sect: SectDoc | null, families: FamilySummary[]): SectQueryService {
  const socialsvc = {
    available: true,
    getFamiliesBySect: vi.fn(async () => families),
  } as unknown as WorldSocialsvcClient;
  const deps = {
    cols: { sects: { findOne: async () => sect } },
    now: () => 1000,
    socialsvc,
  } as unknown as SectServiceDeps;
  return new SectQueryService(deps);
}

const BASE_SECT: SectDoc = {
  _id: 'sect:w1:SKY', worldId: 'w1', name: 'Sky', tag: 'SKY', leaderFamilyId: 'fam1', leaderId: 'alice',
  memberFamilyCount: 1, allySectIds: [], prosperity: 0, rev: 1,
};

describe('SectQueryService.getSect — member family emblem spread', () => {
  it('includes emblemKey/emblemColor when the family has both set', async () => {
    const svc = build(BASE_SECT, [
      { familyId: 'fam1', name: 'Fam', tag: 'FA', leaderId: 'alice', memberCount: 1, prosperity: 0, emblemKey: 'lion', emblemColor: 5 } as FamilySummary,
    ]);
    const detail = await svc.getSect(BASE_SECT._id);
    expect(detail!.memberFamilies[0]).toMatchObject({ emblemKey: 'lion', emblemColor: 5 });
  });

  it('omits emblemKey/emblemColor entirely when the family has neither (not just undefined)', async () => {
    const svc = build(BASE_SECT, [
      { familyId: 'fam1', name: 'Fam', tag: 'FA', leaderId: 'alice', memberCount: 1, prosperity: 0 } as FamilySummary,
    ]);
    const detail = await svc.getSect(BASE_SECT._id);
    expect('emblemKey' in detail!.memberFamilies[0]!).toBe(false);
    expect('emblemColor' in detail!.memberFamilies[0]!).toBe(false);
  });

  it('emblemColor 0 (falsy but valid) is still included — the guard is `!= null`, not truthiness', async () => {
    const svc = build(BASE_SECT, [
      { familyId: 'fam1', name: 'Fam', tag: 'FA', leaderId: 'alice', memberCount: 1, prosperity: 0, emblemColor: 0 } as FamilySummary,
    ]);
    const detail = await svc.getSect(BASE_SECT._id);
    expect(detail!.memberFamilies[0]).toMatchObject({ emblemColor: 0 });
  });

  it('returns null for a sect that does not exist', async () => {
    const svc = build(null, []);
    await expect(svc.getSect('nope')).resolves.toBeNull();
  });
});
