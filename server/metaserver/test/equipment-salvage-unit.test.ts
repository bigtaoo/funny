// Unit tests for src/equipment/salvage.ts (salvageEquipment), importing directly from `../src/...`
// so v8 coverage attributes to source (see equipment-craft-unit.test.ts header for the "why").
import { describe, it, expect } from 'vitest';
import { salvageRefund, type SaveData } from '@nw/shared';
import { salvageEquipment } from '../src/equipment/salvage.js';
import { makeFakeCols, seedSave, seedInst, readInst } from './helpers/fakeEquipCols.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-salvage';

describe('salvageEquipment', () => {
  it('salvage +0: returns 70% craft materials, removes from inventory', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 10 }; });
    seedInst(equipmentInstances, ACC, { id: 's1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const refund = salvageRefund('wp_pencil');
    const r = await salvageEquipment(cols, now, ACC, ['s1'], 'sk1');
    const ok = r as { refunded: Record<string, number>; save: SaveData };
    expect(ok.refunded).toEqual(refund);
    expect(ok.save.materials.scrap).toBe(10 + refund.scrap!);
    expect(ok.save.equipmentInv).toBeNull();
    expect(readInst(equipmentInstances, 's1')).toBeUndefined();
  });

  it('salvage batch: total refund across all items', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 0 }; });
    seedInst(equipmentInstances, ACC, { id: 's2', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 's3', defId: 'wp_pencil', rarity: 'common', level: 4, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s2', 's3'], 'sk-batch');
    const ok = r as { refunded: Record<string, number> };
    expect(ok.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap! * 2);
    expect(readInst(equipmentInstances, 's2')).toBeUndefined();
    expect(readInst(equipmentInstances, 's3')).toBeUndefined();
  });

  it('duplicate ids in the batch are de-duplicated (refunded once, not twice)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 0 }; });
    seedInst(equipmentInstances, ACC, { id: 's-dup', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s-dup', 's-dup'], 'sk-dupids');
    const ok = r as { refunded: Record<string, number> };
    expect(ok.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap); // once, not twice
  });

  it('missing instanceIds (empty array) -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const r = await salvageEquipment(cols, now, ACC, [], 'sk-empty');
    expect(r).toEqual({ error: 'instanceIds required', code: 'BAD_REQUEST' });
  });

  it('non-array instanceIds -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await salvageEquipment(cols, now, ACC, 'not-an-array' as any, 'sk-notarr');
    expect(r).toEqual({ error: 'instanceIds required', code: 'BAD_REQUEST' });
  });

  it('missing idempotencyKey -> BAD_REQUEST', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's-nokey', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s-nokey'], '');
    expect(r).toEqual({ error: 'idempotencyKey required', code: 'BAD_REQUEST' });
    expect(readInst(equipmentInstances, 's-nokey')).toBeTruthy(); // not consumed
  });

  it('non-existent instance in the batch -> EQUIP_NOT_FOUND, nothing removed', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's4', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s4', 'ghost'], 'sk-ghost');
    expect(r).toEqual({ error: 'equipment instance not found: ghost', code: 'EQUIP_NOT_FOUND' });
    expect(readInst(equipmentInstances, 's4')).toBeTruthy(); // whole batch not executed
  });

  it('+5 and above -> NOT_SALVAGEABLE (whole batch rejected)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's5a', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 's5b', defId: 'wp_pencil', rarity: 'common', level: 5, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s5a', 's5b'], 'sk-hi');
    expect(r).toEqual({ error: 'not salvageable (common +5): s5b', code: 'NOT_SALVAGEABLE' });
    expect(readInst(equipmentInstances, 's5a')).toBeTruthy();
  });

  it('epic rarity at +0 -> NOT_SALVAGEABLE regardless of level (ADR-050)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's6', defId: 'wp_highlighter', rarity: 'epic', level: 0, affixes: [] });
    const r = await salvageEquipment(cols, now, ACC, ['s6'], 'sk-epic');
    expect(r).toEqual({ error: 'not salvageable (epic +0): s6', code: 'NOT_SALVAGEABLE' });
  });

  it('locked -> EQUIP_LOCKED', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's7', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: true });
    const r = await salvageEquipment(cols, now, ACC, ['s7'], 'sk-lock');
    expect(r).toEqual({ error: 'equipment locked: s7', code: 'EQUIP_LOCKED' });
  });

  it('equipped -> EQUIP_IN_USE', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's8', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    cardInstances.seed({ _id: 'card1', accountId: ACC, defId: 'card_test', level: 1, gear: { weapon: 's8' }, gearInstanceIds: ['s8'], locked: false });
    const r = await salvageEquipment(cols, now, ACC, ['s8'], 'sk-worn');
    expect(r).toEqual({ error: 'equipment in use: s8', code: 'EQUIP_IN_USE' });
  });

  it('idempotent replay: same key does not refund twice', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 0 }; });
    seedInst(equipmentInstances, ACC, { id: 's9', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    await salvageEquipment(cols, now, ACC, ['s9'], 'sk-dup');
    const r2 = await salvageEquipment(cols, now, ACC, ['s9'], 'sk-dup');
    const ok2 = r2 as { refunded: Record<string, number> };
    expect(ok2.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(salvageRefund('wp_pencil').scrap);
  });

  it('regression: exhausting rev retries preserves the refund for a later retry instead of losing it', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 10 }; });
    seedInst(equipmentInstances, ACC, { id: 's10', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const refund = salvageRefund('wp_pencil');
    const realFindOneAndUpdate = saves.findOneAndUpdate.bind(saves);
    saves.findOneAndUpdate = async () => null;

    const first = await salvageEquipment(cols, now, ACC, ['s10'], 'sk-exhaust');
    expect(first).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
    expect(readInst(equipmentInstances, 's10')).toBeUndefined(); // already destroyed, as designed
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(10); // not yet credited

    // Restore normal saves behavior and retry with the SAME key.
    saves.findOneAndUpdate = realFindOneAndUpdate;
    const retry = await salvageEquipment(cols, now, ACC, ['s10'], 'sk-exhaust');
    const okRetry = retry as { refunded: Record<string, number> };
    expect(okRetry.refunded).toEqual(refund);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(10 + refund.scrap!);

    const replayAgain = await salvageEquipment(cols, now, ACC, ['s10'], 'sk-exhaust');
    expect((replayAgain as { refunded: Record<string, number> }).refunded).toEqual(refund);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(10 + refund.scrap!); // not double-credited
  });

  it('a non-11000 error from the idem insert propagates instead of being swallowed', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 's-err', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    equipmentIdem.insertOne = async () => { throw new Error('boom'); };
    await expect(salvageEquipment(cols, now, ACC, ['s-err'], 'sk-err')).rejects.toThrow('boom');
  });

  it('E11000 race against a concurrent duplicate salvage (uncommitted): finishes the credit via the catch branch', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 5 }; });
    seedInst(equipmentInstances, ACC, { id: 's11', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const refund = salvageRefund('wp_pencil');
    const realInsertOne = equipmentIdem.insertOne.bind(equipmentIdem);
    let first = true;
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, { _id: doc._id, accountId: ACC, op: 'salvage', result: { refunded: refund, instanceIds: ['s11'] }, committed: false, expireAt: doc.expireAt });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsertOne(doc);
    };
    const r = await salvageEquipment(cols, now, ACC, ['s11'], 'sk-race');
    const ok = r as { refunded: Record<string, number> };
    expect(ok.refunded).toEqual(refund);
    expect(readInst(equipmentInstances, 's11')).toBeUndefined();
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(5 + refund.scrap!);
  });

  it('E11000 race against a concurrent duplicate salvage (already committed): returns the cached result without re-crediting', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 5 + salvageRefund('wp_pencil').scrap! }; }); // as if already credited
    seedInst(equipmentInstances, ACC, { id: 's12', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const refund = salvageRefund('wp_pencil');
    const realInsertOne = equipmentIdem.insertOne.bind(equipmentIdem);
    let first = true;
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, { _id: doc._id, accountId: ACC, op: 'salvage', result: { refunded: refund, instanceIds: ['s12'] }, committed: true, expireAt: doc.expireAt });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsertOne(doc);
    };
    const r = await salvageEquipment(cols, now, ACC, ['s12'], 'sk-race2');
    const ok = r as { refunded: Record<string, number> };
    expect(ok.refunded).toEqual(refund);
    expect(readInst(equipmentInstances, 's12')).toBeUndefined();
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(5 + refund.scrap!); // unchanged, not double-credited
  });
});
