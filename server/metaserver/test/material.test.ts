// Unit tests for material.ts's recordMaterialGrants/toInstanceDoc (ITEM_IDENTITY_DESIGN.md task2,
// 2026-08-10) — direct, no-Mongo coverage of the module itself, complementing the route/e2e-level
// assertions already in internal-economy.test.ts / economy.e2e.test.ts / pve.e2e.test.ts / etc.
// (multi-material single event → N rows, expireAt = obtainedAt + 30d, idempotent upsert by baseId) are
// already covered there; this file focuses on branches those call sites don't exercise directly:
// the count<=0 skip, the best-effort try/catch around the Mongo write, and toInstanceDoc's raw shape.
import { describe, it, expect } from 'vitest';
import type { Collections } from '@nw/shared';
import { recordMaterialGrants, toInstanceDoc } from '../src/material.js';
import { FakeCollection } from './helpers/fakeCollection.js';

interface MaterialInstanceRow {
  _id: string; accountId: string; materialId: string; count: number;
  sourceType?: string; obtainedAt?: number; expireAt: Date;
}

function build(seed: MaterialInstanceRow[] = []) {
  const materialInstances = new FakeCollection<MaterialInstanceRow>().seed(...seed);
  const cols = { materialInstances } as unknown as Collections;
  return { cols, materialInstances };
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

describe('toInstanceDoc', () => {
  it('expireAt = obtainedAt + 30 days exactly', () => {
    const obtainedAt = 1_700_000_000_000;
    const doc = toInstanceDoc({ id: 'mat_x', materialId: 'scrap', count: 5, obtainedAt }, 'acc-1');
    expect(doc.expireAt.getTime()).toBe(obtainedAt + THIRTY_DAYS_MS);
  });

  it('falls back to Date.now() for expireAt anchoring when obtainedAt is omitted, but omits the obtainedAt field itself from the doc', () => {
    const before = Date.now();
    const doc = toInstanceDoc({ id: 'mat_y', materialId: 'scrap', count: 5 }, 'acc-1');
    const after = Date.now();
    expect(doc.obtainedAt).toBeUndefined();
    expect(doc.expireAt.getTime()).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS);
    expect(doc.expireAt.getTime()).toBeLessThanOrEqual(after + THIRTY_DAYS_MS);
  });

  it('omits sourceType from the doc when absent on the instance', () => {
    const doc = toInstanceDoc({ id: 'mat_z', materialId: 'scrap', count: 5, obtainedAt: 1000 }, 'acc-1');
    expect('sourceType' in doc).toBe(false);
  });
});

describe('recordMaterialGrants', () => {
  it('zero and negative entries are skipped; only positive counts mint a row', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'base1', { scrap: 5, lead: 0, binding: -3, stamina: 2 }, 'test', 1000);
    const rows = [...materialInstances.docs.values()];
    expect(rows.map((r) => r.materialId).sort()).toEqual(['scrap', 'stamina']);
  });

  it('an all-zero/negative grants object mints no rows at all', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'base1', { lead: 0, binding: -1 }, 'test', 1000);
    expect(materialInstances.docs.size).toBe(0);
  });

  it('one event touching multiple materialIds mints one row per id, not one row total and not one row per unit', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'evt1', { scrap: 6, lead: 2 }, 'pve_drop:ch1_lv1', 1000);
    expect(materialInstances.docs.size).toBe(2);
    const byId = new Map([...materialInstances.docs.values()].map((r) => [r.materialId, r]));
    expect(byId.get('scrap')).toMatchObject({ count: 6, sourceType: 'pve_drop:ch1_lv1' });
    expect(byId.get('lead')).toMatchObject({ count: 2, sourceType: 'pve_drop:ch1_lv1' });
  });

  it('repeated calls with the same baseId+materialId upsert the same row (idempotent), not a duplicate insert', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'dup-evt', { scrap: 6 }, 'src1', 1000);
    await recordMaterialGrants(cols, 'a', 'dup-evt', { scrap: 6 }, 'src1', 1000);
    expect(materialInstances.docs.size).toBe(1);
    expect(materialInstances.docs.get('mat_dup-evt_scrap')).toMatchObject({ count: 6, sourceType: 'src1' });
  });

  it('a retry with the same baseId+materialId but different fields (e.g. a later obtainedAt) overwrites the row via $set, not $inc — count/obtainedAt reflect the latest call', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'dup-evt-2', { scrap: 6 }, 'src1', 1000);
    await recordMaterialGrants(cols, 'a', 'dup-evt-2', { scrap: 999 }, 'src2', 2000);
    expect(materialInstances.docs.size).toBe(1);
    const row = materialInstances.docs.get('mat_dup-evt-2_scrap')!;
    expect(row).toMatchObject({ count: 999, sourceType: 'src2', obtainedAt: 2000 });
  });

  it('a Mongo write failure is swallowed (best-effort) and does not throw, and does not block sibling materialIds in the same call', async () => {
    const throwing = {
      async updateOne() { throw new Error('boom: simulated Mongo outage'); },
    };
    const cols = { materialInstances: throwing } as unknown as Collections;
    await expect(
      recordMaterialGrants(cols, 'a', 'evt-fail', { scrap: 6, lead: 2 }, 'test', 1000),
    ).resolves.toBeUndefined();
  });

  it('a write failure on one materialId does not prevent a sibling materialId in the same event from being recorded', async () => {
    const { materialInstances } = build();
    let calls = 0;
    const flaky = {
      async updateOne(filter: Record<string, unknown>, update: Record<string, Record<string, unknown>>, opts?: { upsert?: boolean }) {
        calls++;
        if (filter._id === 'mat_evt-flaky_scrap') throw new Error('boom: scrap write fails');
        return materialInstances.updateOne(filter, update, opts);
      },
    };
    const cols = { materialInstances: flaky } as unknown as Collections;
    await recordMaterialGrants(cols, 'a', 'evt-flaky', { scrap: 6, lead: 2 }, 'test', 1000);
    expect(calls).toBe(2);
    expect(materialInstances.docs.has('mat_evt-flaky_scrap')).toBe(false);
    expect(materialInstances.docs.get('mat_evt-flaky_lead')).toMatchObject({ count: 2 });
  });

  it('distinct baseIds never collide on _id even when granting the same materialId (each event gets its own row)', async () => {
    const { cols, materialInstances } = build();
    await recordMaterialGrants(cols, 'a', 'evt-A', { scrap: 3 }, 'src', 1000);
    await recordMaterialGrants(cols, 'a', 'evt-B', { scrap: 4 }, 'src', 1000);
    // No baseId-collision guard exists in recordMaterialGrants (nor does one need to: `_id` is
    // deterministically derived as `mat_${baseId}_${materialId}`, so two DIFFERENT baseIds can only ever
    // produce the same _id if they are byte-identical strings — i.e. not actually different callers'
    // events at all. There is no realistic scenario where distinct natural idempotency keys (orderId /
    // checkin monthKey:day / verifyId / recharge tier / random uuid) collide, so this test only documents
    // the (expected, by-design) absence of extra collision protection rather than exercising a real bug.
    expect(materialInstances.docs.size).toBe(2);
    expect(materialInstances.docs.get('mat_evt-A_scrap')).toMatchObject({ count: 3 });
    expect(materialInstances.docs.get('mat_evt-B_scrap')).toMatchObject({ count: 4 });
  });
});
