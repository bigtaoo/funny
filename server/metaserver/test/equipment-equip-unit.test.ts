// Unit tests for src/equipment/equip.ts (equipEquipment), importing directly from `../src/...`
// so v8 coverage attributes to source (see equipment-craft-unit.test.ts header for the "why").
import { describe, it, expect } from 'vitest';
import type { SaveData } from '@nw/shared';
import { equipEquipment } from '../src/equipment/equip.js';
import { makeFakeCols, seedSave, seedInst, seedCardInst } from './helpers/fakeEquipCols.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-equip';

describe('equipEquipment', () => {
  it('equip: writes instanceId into CardInstance.gear[slot]; unequip (null) removes it', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'card1' });

    const r = await equipEquipment(cols, now, ACC, 'weapon', 'w1', 'card1');
    expect('error' in r).toBe(false);
    expect((r as { save: SaveData }).save.equipmentInv).toBeNull();
    expect((await cardInstances.findOne({ _id: 'card1' }))!.gear.weapon).toBe('w1');
    expect((await cardInstances.findOne({ _id: 'card1' }))!.gearInstanceIds).toEqual(['w1']);

    const r2 = await equipEquipment(cols, now, ACC, 'weapon', null, 'card1');
    expect('error' in r2).toBe(false);
    expect((await cardInstances.findOne({ _id: 'card1' }))!.gear.weapon).toBeUndefined();
    expect((await cardInstances.findOne({ _id: 'card1' }))!.gearInstanceIds).toEqual([]);
  });

  it('invalid slot name -> INVALID_SLOT (bad request never reaches the DB)', async () => {
    const { cols, saves, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedCardInst(cardInstances, ACC, { id: 'card2' });
    const r = await equipEquipment(cols, now, ACC, 'helmet', null, 'card2');
    expect(r).toEqual({ error: 'invalid slot', code: 'INVALID_SLOT' });
  });

  it('missing cardInstanceId -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const r = await equipEquipment(cols, now, ACC, 'weapon', null, '');
    expect(r).toEqual({ error: 'cardInstanceId required', code: 'BAD_REQUEST' });
  });

  it('slot mismatch (weapon item into armor slot) -> INVALID_SLOT', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'card3' });
    const r = await equipEquipment(cols, now, ACC, 'armor', 'w2', 'card3');
    expect(r).toEqual({ error: 'slot mismatch: wp_pencil is weapon', code: 'INVALID_SLOT' });
  });

  it('unknown defId on the instance (no matching EquipDef) skips the slot-mismatch check entirely', async () => {
    // Branch: `if (def && def.slot !== slot)` — when def is undefined (stale/malformed instance), the
    // slot check is silently skipped rather than erroring; equip proceeds. Not exercised by e2e.
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w-unknown', defId: 'totally_unknown_def', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'card-unknown' });
    const r = await equipEquipment(cols, now, ACC, 'trinket', 'w-unknown', 'card-unknown');
    expect('error' in r).toBe(false);
    expect((await cardInstances.findOne({ _id: 'card-unknown' }))!.gear.trinket).toBe('w-unknown');
  });

  it('non-existent equipment instance -> EQUIP_NOT_FOUND', async () => {
    const { cols, saves, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedCardInst(cardInstances, ACC, { id: 'card4' });
    const r = await equipEquipment(cols, now, ACC, 'weapon', 'nope', 'card4');
    expect(r).toEqual({ error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' });
  });

  it('non-existent card instance -> NOT_FOUND (generic; no CARD_NOT_FOUND code exists)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await equipEquipment(cols, now, ACC, 'weapon', 'w3', 'card_does_not_exist');
    expect(r).toEqual({ error: 'card instance not found', code: 'NOT_FOUND' });
  });

  it('equipping an instance already equipped on a DIFFERENT card -> EQUIP_IN_USE (no duplication)', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w5', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'cardA', gear: { weapon: 'w5' } });
    seedCardInst(cardInstances, ACC, { id: 'cardB' });
    const r = await equipEquipment(cols, now, ACC, 'weapon', 'w5', 'cardB');
    expect(r).toEqual({ error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' });
    expect((await cardInstances.findOne({ _id: 'cardB' }))!.gear.weapon).toBeUndefined();
  });

  it('re-equipping the same instance on the SAME card/slot is a no-op success, not EQUIP_IN_USE', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'w6', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'cardC', gear: { weapon: 'w6' } });
    const r = await equipEquipment(cols, now, ACC, 'weapon', 'w6', 'cardC');
    expect('error' in r).toBe(false);
    expect((await cardInstances.findOne({ _id: 'cardC' }))!.gear.weapon).toBe('w6');
  });

  it('unequip a slot that was never set (instanceId=null on an empty slot) is a harmless no-op', async () => {
    const { cols, saves, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedCardInst(cardInstances, ACC, { id: 'cardD' });
    const r = await equipEquipment(cols, now, ACC, 'armor', null, 'cardD');
    expect('error' in r).toBe(false);
    expect((await cardInstances.findOne({ _id: 'cardD' }))!.gear.armor).toBeUndefined();
  });

  it('regression: a unique-index E11000 race on gearInstanceIds is translated to EQUIP_IN_USE (atomic backstop behind the pre-write read check)', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'wrace', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'cardE' });
    const realUpdateOne = cardInstances.updateOne.bind(cardInstances);
    cardInstances.updateOne = async () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); };
    const r = await equipEquipment(cols, now, ACC, 'weapon', 'wrace', 'cardE');
    expect(r).toEqual({ error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' });
    cardInstances.updateOne = realUpdateOne;
  });

  it('a non-11000 error from the update propagates instead of being swallowed', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'werr', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedCardInst(cardInstances, ACC, { id: 'cardF' });
    cardInstances.updateOne = async () => { throw new Error('boom'); };
    await expect(equipEquipment(cols, now, ACC, 'weapon', 'werr', 'cardF')).rejects.toThrow('boom');
  });

  it('a legacy card doc with gear=undefined is treated as an empty loadout (`cardDoc.gear ?? {}` branch)', async () => {
    const { cols, saves, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    // Bypass seedCardInst (which always defaults gear to {}) to simulate a malformed/legacy doc.
    cardInstances.seed({ _id: 'cardG', accountId: ACC, defId: 'card_test', level: 1, gear: undefined as unknown as Record<string, string>, gearInstanceIds: [], locked: false });
    const r = await equipEquipment(cols, now, ACC, 'armor', null, 'cardG');
    expect('error' in r).toBe(false);
    expect((await cardInstances.findOne({ _id: 'cardG' }))!.gear).toEqual({});
  });
});
