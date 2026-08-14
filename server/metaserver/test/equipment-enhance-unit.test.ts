// Unit tests for src/equipment/enhance.ts (enhanceEquipment), importing directly from `../src/...`
// so v8 coverage attributes to source (see equipment-craft-unit.test.ts header for the "why").
import { describe, it, expect } from 'vitest';
import {
  EQUIP_MAX_LEVEL,
  PROTECT_ENHANCE_ITEM_ID,
  rollEnhanceSuccess,
  rollEnhanceDemote,
  enhanceCost,
  type EquipmentInstance,
  type SaveData,
} from '@nw/shared';
import { enhanceEquipment } from '../src/equipment/enhance.js';
import { makeFakeCols, seedSave, seedInst, readInst } from './helpers/fakeEquipCols.js';
import { makeFakeEquipCommercial } from './helpers/fakeEquipCommercial.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-enhance';

/** Finds a key for which rollEnhanceSuccess(key, fromLevel) === wantSuccess (and, when given, rollEnhanceDemote also matches wantDemote). */
function findKey(fromLevel: number, wantSuccess: boolean, wantDemote?: boolean): string {
  for (let i = 0; ; i++) {
    const key = `k${i}`;
    if (rollEnhanceSuccess(key, fromLevel) !== wantSuccess) continue;
    if (wantDemote === undefined || rollEnhanceDemote(key, fromLevel) === wantDemote) return key;
  }
}

describe('enhanceEquipment', () => {
  it('success: level+1, deducts materials + coins', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100, lead: 100, binding: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const key = findKey(0, true);
    const cost = enhanceCost(0);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e1', key);
    const ok = r as { success: boolean; instance: EquipmentInstance; save: SaveData };
    expect(ok.success).toBe(true);
    expect(ok.instance.level).toBe(1);
    expect(ok.save.materials.scrap).toBe(100 - cost.materials.scrap);
    expect(ok.save.wallet.coins).toBe(1000 - cost.coins);
    expect(ok.save.equipmentInv).toBeNull();
  });

  it('failure: level unchanged, materials + coins still deducted', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const key = findKey(0, false);
    const cost = enhanceCost(0);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e2', key);
    const ok = r as { success: boolean; instance: EquipmentInstance; save: SaveData };
    expect(ok.success).toBe(false);
    expect(ok.instance.level).toBe(0);
    expect(ok.save.materials.scrap).toBe(100 - cost.materials.scrap);
  });

  it('failure at +7 with a demoting roll -> level drops to +6 (ADR-063)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100, lead: 100, binding: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e7', defId: 'wp_pencil', rarity: 'common', level: 7, affixes: [] });
    const key = findKey(7, false, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e7', key);
    expect((r as { instance: EquipmentInstance }).instance.level).toBe(6);
  });

  it('failure at +7 with a non-demoting roll -> level stays at +7', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100, lead: 100, binding: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e7b', defId: 'wp_pencil', rarity: 'common', level: 7, affixes: [] });
    const key = findKey(7, false, false);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e7b', key);
    expect((r as { instance: EquipmentInstance }).instance.level).toBe(7);
  });

  it('protect item blocks both material loss AND the demote roll on failure (ADR-063)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10000);
    seedSave(saves, ACC, now(), (s) => {
      s.materials = { scrap: 100, lead: 100, binding: 100 };
      s.inventory = { skins: [], items: { [PROTECT_ENHANCE_ITEM_ID]: 1 } };
    });
    seedInst(equipmentInstances, ACC, { id: 'e8', defId: 'wp_pencil', rarity: 'common', level: 8, affixes: [] });
    const key = findKey(8, false, true); // would demote if unprotected
    const cost = enhanceCost(8);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e8', key, true);
    const ok = r as { success: boolean; instance: EquipmentInstance; save: SaveData };
    expect(ok.success).toBe(false);
    expect(ok.instance.level).toBe(8); // not demoted
    expect(ok.save.materials.scrap).toBe(100); // material loss skipped
    expect(ok.save.wallet.coins).toBe(10000 - cost.coins); // coins still charged
    expect(ok.save.inventory.items[PROTECT_ENHANCE_ITEM_ID]).toBe(0); // stone consumed
  });

  it('useProtect=true but no protect item owned -> behaves as an unprotected attempt (hasProtect gate)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100, lead: 100, binding: 100 }; }); // no protect_enhance in inventory.items
    seedInst(equipmentInstances, ACC, { id: 'e8c', defId: 'wp_pencil', rarity: 'common', level: 8, affixes: [] });
    const key = findKey(8, false, true); // demoting failure
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e8c', key, true);
    const ok = r as { success: boolean; instance: EquipmentInstance; save: SaveData };
    expect(ok.instance.level).toBe(7); // demoted anyway: no protect item actually owned
    expect(ok.save.materials.scrap).toBeLessThan(100); // materials WERE deducted
  });

  it('idempotent replay: same key does not deduct or re-roll again', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r1 = await enhanceEquipment(cols, comm, now, ACC, 'e3', 'dup-enh');
    const r2 = await enhanceEquipment(cols, comm, now, ACC, 'e3', 'dup-enh');
    const ok1 = r1 as { success: boolean; instance: EquipmentInstance };
    const ok2 = r2 as { success: boolean; instance: EquipmentInstance };
    expect(ok2.success).toBe(ok1.success);
    expect(ok2.instance.level).toBe(ok1.instance.level);
    // settleEquipCoins re-calls commercial.spend(orderId=idemKey) on replay too (idempotent re-settle,
    // covers "save updated but coin deduction interrupted"), but since the orderId already succeeded once
    // it must not deduct a second time.
    expect(comm.spendCalls.length).toBe(2);
    expect(comm.bal(ACC)).toBe(1000 - enhanceCost(0).coins);
  });

  it('at max level -> ENHANCE_MAX_LEVEL', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e9', defId: 'wp_pencil', rarity: 'common', level: EQUIP_MAX_LEVEL, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e9', 'ek-max');
    expect(r).toEqual({ error: 'already max level', code: 'ENHANCE_MAX_LEVEL' });
  });

  it('insufficient materials -> INSUFFICIENT_MATERIALS, coins untouched', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 1 }; });
    seedInst(equipmentInstances, ACC, { id: 'e4', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e4', 'ek-nomat');
    expect(r).toEqual({ error: 'insufficient scrap', code: 'INSUFFICIENT_MATERIALS' });
    expect(comm.bal(ACC)).toBe(1000);
  });

  it('insufficient coins -> INSUFFICIENT_FUNDS, materials untouched', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 10);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e5', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e5', 'ek-nocoin');
    expect(r).toEqual({ error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' });
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(100);
  });

  it('non-existent instance -> EQUIP_NOT_FOUND', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    const r = await enhanceEquipment(cols, comm, now, ACC, 'ghost', 'ek-ghost');
    expect(r).toEqual({ error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' });
  });

  it('missing instanceId / idempotencyKey -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    expect(await enhanceEquipment(cols, comm, now, ACC, '', 'k')).toEqual({ error: 'instanceId required', code: 'BAD_REQUEST' });
    expect(await enhanceEquipment(cols, comm, now, ACC, 'e1', '')).toEqual({ error: 'idempotencyKey required', code: 'BAD_REQUEST' });
  });

  it('commercial unavailable -> NOT_IMPLEMENTED (coins are commercial-authoritative)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial(false);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e6', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e6', 'ek-nocomm');
    expect(r).toEqual({ error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' });
  });

  it('regression: racing key (uncommitted claim) is rejected, not granted for free', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e10', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    equipmentIdem.seed({
      _id: 'racing-enh',
      accountId: ACC,
      op: 'enhance',
      result: { success: true, instance: { id: 'e10', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] }, coins: 40 },
      committed: false,
      expireAt: new Date(now() + 3600_000),
    });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e10', 'racing-enh');
    expect(r).toEqual({ error: 'enhance already in progress, retry', code: 'REV_CONFLICT' });
    expect(readInst(equipmentInstances, 'e10')!.level).toBe(0); // untouched
  });

  it('E11000 race against an already-COMMITTED claim: replay-grants + idempotently re-settles coins', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 960); // 1000 - 40 (cost.coins for level 0), as if already charged by the "original" request
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 96 }; }); // 100 - 4
    seedInst(equipmentInstances, ACC, { id: 'e11', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] }); // already advanced
    equipmentIdem.seed({
      _id: 'committed-enh',
      accountId: ACC,
      op: 'enhance',
      result: { success: true, instance: { id: 'e11', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] }, coins: 40, skipMaterials: false },
      committed: true,
      expireAt: new Date(now() + 3600_000),
    });
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e11', 'committed-enh');
    const ok = r as { success: boolean; instance: EquipmentInstance };
    expect(ok.success).toBe(true);
    expect(ok.instance.level).toBe(1);
  });

  it('E11000 race on the idem insert itself (uncommitted): rejects the duplicate instead of granting for free', async () => {
    // Unlike the "racing key" test above (which pre-seeds the idem doc so the top-of-function replay
    // check intercepts first), this hits enhanceEquipment's OWN insertOne try/catch — only reachable if a
    // concurrent request's claim lands in the narrow window between the top-of-function check and this
    // insertOne call. Simulated by making insertOne itself insert a competing doc before throwing E11000.
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e-race1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    let first = true;
    const realInsertOne = equipmentIdem.insertOne.bind(equipmentIdem);
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, { ...doc, committed: false });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsertOne(doc);
    };
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e-race1', key);
    expect(r).toEqual({ error: 'enhance already in progress, retry', code: 'REV_CONFLICT' });
  });

  it('E11000 race on the idem insert itself (already committed): replay-grants + idempotently re-settles coins', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e-race2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    let first = true;
    const realInsertOne = equipmentIdem.insertOne.bind(equipmentIdem);
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, {
          ...doc,
          committed: true,
          result: { success: true, instance: { id: 'e-race2', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] }, coins: 40, skipMaterials: false },
        });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsertOne(doc);
    };
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e-race2', key);
    const ok = r as { success: boolean; instance: EquipmentInstance };
    expect(ok.success).toBe(true);
    expect(ok.instance.level).toBe(1);
  });

  it('save disappearing mid-flight (concurrent account deletion) -> NOT_FOUND inside the rev loop, claim released', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e-vanish', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    let calls = 0;
    const realFindOne = saves.findOne.bind(saves);
    saves.findOne = async (q: Record<string, unknown>) => {
      calls++;
      return calls === 1 ? realFindOne(q) : null; // 1st = pre-validate; 2nd = inside the rev loop
    };
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e-vanish', key);
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(await equipmentIdem.findOne({ _id: key })).toBeNull();
  });

  it('instance level changes mid-flight (concurrent enhance) -> REV_CONFLICT, cost not re-applied', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e12', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    let calls = 0;
    const realFindOne = equipmentInstances.findOne.bind(equipmentInstances);
    equipmentInstances.findOne = async (q: Record<string, unknown>) => {
      calls++;
      if (calls === 1) return realFindOne(q); // the pre-loop read (fromLevel=0)
      // Simulate a concurrent enhance landing between the pre-loop read and the in-loop read.
      const d = await realFindOne(q);
      return d ? { ...d, level: 5 } : d;
    };
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e12', key);
    expect(r).toEqual({ error: 'instance level changed, retry', code: 'REV_CONFLICT' });
    expect(await equipmentIdem.findOne({ _id: key })).toBeNull(); // claim released
  });

  it('regression: exhausting rev retries releases the claim (coins untouched, safe to retry)', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 100 }; });
    seedInst(equipmentInstances, ACC, { id: 'e13', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    saves.findOneAndUpdate = async () => null;
    const key = findKey(0, true);
    const r = await enhanceEquipment(cols, comm, now, ACC, 'e13', key);
    expect(r).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
    expect(comm.bal(ACC)).toBe(1000); // untouched
    expect(await equipmentIdem.findOne({ _id: key })).toBeNull();
  });
});
