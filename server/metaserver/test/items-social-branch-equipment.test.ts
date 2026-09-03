// Branch-coverage backfill for src/equipment/{enhance,craft,salvage,reforge}.ts (group G, 2026-09-03).
// The existing equipment-*-unit.test.ts files already cover every happy path and most refusals; what
// they never take are (a) the absent-field fallbacks that only appear when a save document is missing
// `materials`/`inventory` entirely, (b) the lost races where a concurrent writer drains materials or
// removes the protect item between the pre-validate read and the rev-guarded write, and (c) the
// non-E11000 rethrow arm of every idempotency-claim try/catch (a real Mongo outage, which must NOT be
// swallowed as "already in progress").
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes the executed lines to
// source — see equipment-enhance-unit.test.ts's header for the full rationale.
import { describe, it, expect } from 'vitest';
import {
  PROTECT_ENHANCE_ITEM_ID,
  EQUIPMENT_DEFS,
  rollEnhanceSuccess,
  enhanceCost,
  salvageRefund,
  reforgeCoinCost,
  type EquipmentInstance,
  type SaveData,
} from '@nw/shared';
import { enhanceEquipment } from '../src/equipment/enhance.js';
import { craftEquipment } from '../src/equipment/craft.js';
import { salvageEquipment } from '../src/equipment/salvage.js';
import { reforgeEquipment } from '../src/equipment/reforge.js';
import { makeFakeCols, seedSave, seedInst, type FakeEquipCols, type FakeSaveDoc } from './helpers/fakeEquipCols.js';
import { makeFakeEquipCommercial } from './helpers/fakeEquipCommercial.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-grpG-equip';

/** Finds an idempotency key whose deterministic enhance roll matches `wantSuccess` at `fromLevel`. */
function findKey(fromLevel: number, wantSuccess: boolean): string {
  for (let i = 0; ; i++) {
    const key = `g${i}`;
    if (rollEnhanceSuccess(key, fromLevel) === wantSuccess) return key;
  }
}

/** Strips fields off the stored save document just before the Nth `saves.findOne` resolves — i.e. a
 *  concurrent writer landing in the window between the pre-validate read and the rev-loop re-read. */
function stripSaveOnNthRead(saves: FakeEquipCols['saves'], nth: number, fields: (keyof SaveData)[]): void {
  let calls = 0;
  const real = saves.findOne.bind(saves);
  saves.findOne = async (q: Record<string, unknown>) => {
    calls++;
    if (calls === nth) {
      const d = (await real(q)) as FakeSaveDoc | null;
      if (d) {
        const next = { ...d.save } as Record<string, unknown>;
        for (const f of fields) delete next[f];
        saves.docs.set(d._id, { ...d, save: next as unknown as SaveData });
      }
    }
    return real(q) as Promise<FakeSaveDoc | null>;
  };
}

/** Replaces insertOne with one that fails the way a Mongo outage does (not a duplicate-key race). */
function failInsertWith<T extends { _id: string }>(col: { insertOne(d: T): Promise<unknown> }, err: Error): void {
  col.insertOne = async () => { throw err; };
}

describe('enhanceEquipment — absent-field fallbacks and lost races', () => {
  it('save document with no `materials` field at all -> INSUFFICIENT_MATERIALS (not a crash)', async () => {
    // A legacy/hand-repaired save can reach here without `materials`; the `?? 0` fallback must read as
    // "owns none" rather than throwing on the property access.
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { delete (s as Partial<SaveData>).materials; });
    seedInst(equipmentInstances, ACC, { id: 'g-e1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'g-e1', 'gk-nomatfield');
    expect(r).toEqual({ error: 'insufficient scrap', code: 'INSUFFICIENT_MATERIALS' });
    expect(comm.spendCalls).toEqual([]); // nothing charged
  });

  it('commercial.getWallet returning null (wallet lookup degraded) -> INSUFFICIENT_FUNDS, no state change', async () => {
    // getWallet's contract allows null (commercial unconfigured/ok:false). Treating that as 0 coins is
    // what stops a wallet-read failure from handing out a free enhancement.
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.getWallet = async () => null;
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'g-e2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'g-e2', 'gk-nullwallet');
    expect(r).toEqual({ error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' });
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(100);
  });

  it('idem insert failing with a non-duplicate error (Mongo outage) is rethrown, never masked as REV_CONFLICT', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'g-e3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    failInsertWith(equipmentIdem, Object.assign(new Error('not primary'), { code: 10107 }));
    await expect(enhanceEquipment(cols, comm, now, ACC, 'g-e3', 'gk-outage')).rejects.toThrow('not primary');
    expect(comm.spendCalls).toEqual([]);
  });

  it('materials drained by a concurrent op after the pre-check -> INSUFFICIENT_MATERIALS and the claim is released', async () => {
    // The in-loop re-check is the authoritative one: losing this race must leave the idem key reusable,
    // otherwise the player's retry would be wedged on "already in progress" forever.
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'g-e4', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    stripSaveOnNthRead(saves, 2, ['materials']); // 1st read = pre-validate, 2nd = inside the rev loop
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'g-e4', key);
    expect(r).toEqual({ error: 'insufficient scrap', code: 'INSUFFICIENT_MATERIALS' });
    expect(await equipmentIdem.findOne({ _id: key })).toBeNull(); // released, retry is safe
    expect(comm.spendCalls).toEqual([]); // coins untouched
  });

  it('protected failure whose save loses materials+inventory mid-flight still commits (fallbacks keep the write well-formed)', async () => {
    // skipMaterials is decided from the pre-validate snapshot, so the rev-loop write skips the material
    // re-check entirely and reaches `save.materials ?? {}` / `save.inventory ?? {skins:[]}` /
    // `nextItems[protect] ?? 0`. Those fallbacks are what stop a concurrent full-save overwrite from
    // producing a save with `materials: undefined` (which every later read would then crash on).
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10_000);
    seedSave(saves, ACC, now(), (s) => {
      s.materials = { scrap: 100, lead: 100, binding: 100 };
      s.inventory = { skins: [], items: { [PROTECT_ENHANCE_ITEM_ID]: 1 } };
    });
    seedInst(equipmentInstances, ACC, { id: 'g-e5', defId: 'wp_pencil', rarity: 'common', level: 8, affixes: [] });
    stripSaveOnNthRead(saves, 2, ['materials', 'inventory']);
    const key = findKey(8, false);
    const cost = enhanceCost(8);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'g-e5', key, true);
    const ok = r as { success: boolean; instance: EquipmentInstance; save: SaveData };
    expect(ok.success).toBe(false);
    expect(ok.instance.level).toBe(8); // protected: neither demoted nor advanced
    expect(ok.save.materials).toEqual({}); // rebuilt from the `?? {}` fallback, never undefined
    expect(ok.save.inventory.skins).toEqual([]); // rebuilt from the `?? { skins: [] }` fallback
    expect(ok.save.inventory.items[PROTECT_ENHANCE_ITEM_ID]).toBe(0); // clamped by Math.max(0, undefined ?? 0 - 1)
    expect(comm.bal(ACC)).toBe(10_000 - cost.coins); // the fee is still charged
  });
});

describe('craftEquipment — absent-field fallbacks and lost races', () => {
  const DEF = Object.entries(EQUIPMENT_DEFS).find(([, d]) => !!d.craftCost)![0];

  it('save document with no `materials` field at all -> INSUFFICIENT_MATERIALS', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { delete (s as Partial<SaveData>).materials; });
    const r = await craftEquipment(cols, now, ACC, DEF, 'gk-craft-nomat');
    expect(r).toMatchObject({ code: 'INSUFFICIENT_MATERIALS' });
  });

  it('idem insert failing with a non-duplicate error is rethrown, not treated as a concurrent claim', async () => {
    const { cols, saves, equipmentIdem } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 999, lead: 999, binding: 999, ink: 999 }; });
    failInsertWith(equipmentIdem, Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
    await expect(craftEquipment(cols, now, ACC, DEF, 'gk-craft-outage')).rejects.toThrow('connection reset');
  });

  it('E11000 against a committed claim whose stored result is missing -> falls back to the locally recomputed instance', async () => {
    // The result is deterministic from the idempotency key, so a claim doc that lost its `result`
    // (partial write / manual repair) can still be healed instead of returning nothing to the player.
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 999, lead: 999, binding: 999, ink: 999 }; });
    const key = 'gk-craft-noresult';
    const realInsert = equipmentIdem.insertOne.bind(equipmentIdem);
    let first = true;
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, { ...doc, committed: true, result: null });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsert(doc);
    };
    const r = await craftEquipment(cols, now, ACC, DEF, key);
    const ok = r as { instance: EquipmentInstance };
    expect(ok.instance.id).toBe(`eq_${key}`);
    expect(equipmentInstances.docs.get(`eq_${key}`)).toBeDefined(); // verify-and-heal re-asserted it
  });

  it('materials drained by a concurrent op after the pre-check -> INSUFFICIENT_MATERIALS and the claim is released', async () => {
    const { cols, saves, equipmentIdem } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 999, lead: 999, binding: 999, ink: 999 }; });
    stripSaveOnNthRead(saves, 2, ['materials']); // 1st = getOrCreateSave pre-check, 2nd = rev loop
    const key = 'gk-craft-race';
    const r = await craftEquipment(cols, now, ACC, DEF, key);
    expect(r).toMatchObject({ code: 'INSUFFICIENT_MATERIALS' });
    expect(await equipmentIdem.findOne({ _id: key })).toBeNull(); // released so the retry can restart
  });
});

describe('salvageEquipment — credit settlement failures and replay/duplicate credit paths', () => {
  const seedSalvageable = (f: FakeEquipCols, id: string): void => {
    seedInst(f.equipmentInstances, ACC, { id, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
  };

  it('refund lands on a save that owns none of the refunded material (the `?? 0` credit base)', async () => {
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.materials = { lead: 5 }; s.equipmentInvCount = 1; });
    seedSalvageable(f, 'g-s1');
    const r = await salvageEquipment(f.cols, now, ACC, ['g-s1'], 'gk-salv-empty');
    const ok = r as { refunded: Record<string, number>; save: SaveData };
    const expected = salvageRefund('wp_pencil');
    for (const [mat, qty] of Object.entries(expected)) expect(ok.save.materials[mat]).toBe(qty);
    expect(ok.save.materials.lead).toBe(5); // untouched
  });

  it('save vanishing before the credit -> REV_CONFLICT, and the claim is deliberately kept uncommitted', async () => {
    // The destructive delete already happened, so the claim must survive as `committed:false`: a retry
    // with the same key re-enters the replay branch and finishes the refund instead of losing it.
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.equipmentInvCount = 1; });
    seedSalvageable(f, 'g-s2');
    f.saves.findOne = async () => null;
    const r = await salvageEquipment(f.cols, now, ACC, ['g-s2'], 'gk-salv-nosave');
    expect(r).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
    expect(f.equipmentInstances.docs.get('g-s2')).toBeUndefined(); // already destroyed
    const claim = await f.equipmentIdem.findOne({ _id: 'gk-salv-nosave' });
    expect(claim?.committed).toBe(false); // retryable, refund not lost
  });

  it('replay of an uncommitted claim with no recorded instanceIds still finishes the materials credit', async () => {
    // `instanceIds` may be absent on a claim written by an older build; the `?? 0` count fallback keeps
    // the equipmentInvCount decrement at 0 rather than NaN-ing the mirror.
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.materials = {}; s.equipmentInvCount = 3; });
    f.equipmentIdem.seed({
      _id: 'gk-salv-replay',
      accountId: ACC,
      op: 'salvage',
      result: { refunded: { scrap: 7 } }, // no instanceIds
      committed: false,
      expireAt: new Date(now() + 3600_000),
    });
    const r = await salvageEquipment(f.cols, now, ACC, ['whatever'], 'gk-salv-replay');
    const ok = r as { refunded: Record<string, number>; save: SaveData };
    expect(ok.refunded).toEqual({ scrap: 7 });
    expect(ok.save.materials.scrap).toBe(7);
    expect(ok.save.equipmentInvCount).toBe(3); // nothing recorded as deleted -> no decrement
    expect((await f.equipmentIdem.findOne({ _id: 'gk-salv-replay' }))!.committed).toBe(true);
  });

  it('replay of an uncommitted claim whose credit still cannot land -> REV_CONFLICT (claim stays uncommitted)', async () => {
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now());
    f.equipmentIdem.seed({
      _id: 'gk-salv-replay2',
      accountId: ACC,
      op: 'salvage',
      result: { refunded: { scrap: 7 }, instanceIds: ['g-s3'] },
      committed: false,
      expireAt: new Date(now() + 3600_000),
    });
    f.saves.findOne = async () => null;
    const r = await salvageEquipment(f.cols, now, ACC, ['g-s3'], 'gk-salv-replay2');
    expect(r).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
    expect((await f.equipmentIdem.findOne({ _id: 'gk-salv-replay2' }))!.committed).toBe(false);
  });

  it('E11000 race against an uncommitted claim finishes that claim\'s credit (no instanceIds recorded)', async () => {
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.materials = {}; s.equipmentInvCount = 2; });
    seedSalvageable(f, 'g-s4');
    const realInsert = f.equipmentIdem.insertOne.bind(f.equipmentIdem);
    let first = true;
    f.equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        f.equipmentIdem.docs.set(doc._id, { ...doc, committed: false, result: { refunded: { scrap: 3 } } });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsert(doc);
    };
    const r = await salvageEquipment(f.cols, now, ACC, ['g-s4'], 'gk-salv-dup');
    const ok = r as { refunded: Record<string, number>; save: SaveData };
    expect(ok.refunded).toEqual({ scrap: 3 }); // the winning claim's refund, not this call's own tally
    expect(ok.save.materials.scrap).toBe(3);
    expect((await f.equipmentIdem.findOne({ _id: 'gk-salv-dup' }))!.committed).toBe(true);
  });

  it('E11000 race whose credit cannot land -> REV_CONFLICT instead of reporting a refund that never happened', async () => {
    const f = makeFakeCols();
    seedSave(f.saves, ACC, now(), (s) => { s.equipmentInvCount = 1; });
    seedSalvageable(f, 'g-s5');
    const realInsert = f.equipmentIdem.insertOne.bind(f.equipmentIdem);
    let first = true;
    f.equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        f.equipmentIdem.docs.set(doc._id, { ...doc, committed: false, result: { refunded: { scrap: 3 }, instanceIds: ['g-s5'] } });
        f.saves.findOne = async () => null; // the competing request also lost the save
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsert(doc);
    };
    const r = await salvageEquipment(f.cols, now, ACC, ['g-s5'], 'gk-salv-dup2');
    expect(r).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
  });
});

describe('reforgeEquipment — coin fallbacks and the non-duplicate insert error', () => {
  /** Seeds a fine target + its required common fuel item (same slot), returning their ids. */
  function seedReforgePair(f: FakeEquipCols, suffix: string): { targetId: string; materialId: string } {
    const target = Object.entries(EQUIPMENT_DEFS).find(([, d]) => d.rarity === 'fine')!;
    const material = Object.entries(EQUIPMENT_DEFS).find(([, d]) => d.rarity === 'common' && d.slot === target[1].slot)!;
    const targetId = `g-r-t-${suffix}`;
    const materialId = `g-r-m-${suffix}`;
    seedInst(f.equipmentInstances, ACC, { id: targetId, defId: target[0], rarity: 'fine', level: 0, affixes: [] });
    seedInst(f.equipmentInstances, ACC, { id: materialId, defId: material[0], rarity: 'common', level: 0, affixes: [] });
    return { targetId, materialId };
  }

  it('commercial.getWallet returning null -> INSUFFICIENT_FUNDS, fuel item not destroyed', async () => {
    const f = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.getWallet = async () => null;
    seedSave(f.saves, ACC, now());
    const { targetId, materialId } = seedReforgePair(f, 'nullwallet');
    const r = await reforgeEquipment(f.cols, comm, now, ACC, targetId, materialId, 'gk-rf-nullwallet');
    expect(r).toEqual({ error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' });
    expect(f.equipmentInstances.docs.get(materialId)).toBeDefined();
  });

  it('replay of a claim recorded without `coins` re-settles 0 (never re-charges a guessed fee)', async () => {
    const f = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 5_000);
    seedSave(f.saves, ACC, now());
    const { targetId, materialId } = seedReforgePair(f, 'replay');
    const reforged: EquipmentInstance = {
      id: targetId, defId: f.equipmentInstances.docs.get(targetId)!.defId, rarity: 'fine', level: 0,
      affixes: [{ id: 'atk_flat', value: 3 }],
    };
    f.equipmentIdem.seed({
      _id: 'gk-rf-replay',
      accountId: ACC,
      op: 'reforge',
      result: { instance: reforged }, // no `coins` field
      expireAt: new Date(now() + 3600_000),
    });
    const r = await reforgeEquipment(f.cols, comm, now, ACC, targetId, materialId, 'gk-rf-replay');
    expect((r as { instance: EquipmentInstance }).instance.affixes).toEqual(reforged.affixes);
    expect(comm.spendCalls).toEqual([]); // coins===0 -> settleEquipCoins never calls spend
    expect(comm.bal(ACC)).toBe(5_000);
    expect(f.equipmentInstances.docs.get(materialId)).toBeUndefined(); // fuel re-asserted as consumed
  });

  it('E11000 race against a claim recorded without `coins` also re-settles 0', async () => {
    const f = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 5_000);
    seedSave(f.saves, ACC, now());
    const { targetId, materialId } = seedReforgePair(f, 'dup');
    const realInsert = f.equipmentIdem.insertOne.bind(f.equipmentIdem);
    let first = true;
    f.equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        const stored = doc.result as { instance: EquipmentInstance; coins?: number };
        f.equipmentIdem.docs.set(doc._id, { ...doc, result: { instance: stored.instance } });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsert(doc);
    };
    const r = await reforgeEquipment(f.cols, comm, now, ACC, targetId, materialId, 'gk-rf-dup');
    expect(r).toHaveProperty('instance');
    expect(comm.spendCalls).toEqual([]);
    expect(comm.bal(ACC)).toBe(5_000); // the winner of the race charges the fee, not this duplicate
  });

  it('idem insert failing with a non-duplicate error is rethrown before anything is destroyed', async () => {
    const f = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 5_000);
    seedSave(f.saves, ACC, now());
    const { targetId, materialId } = seedReforgePair(f, 'outage');
    failInsertWith(f.equipmentIdem, Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await expect(reforgeEquipment(f.cols, comm, now, ACC, targetId, materialId, 'gk-rf-outage'))
      .rejects.toThrow('socket hang up');
    expect(f.equipmentInstances.docs.get(materialId)).toBeDefined(); // fuel intact
    expect(comm.bal(ACC)).toBe(5_000);
    expect(reforgeCoinCost('fine')).toBeGreaterThan(0); // pins that this path really had a fee to charge
  });
});
