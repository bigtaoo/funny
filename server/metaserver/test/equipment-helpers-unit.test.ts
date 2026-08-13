// Unit tests for src/equipment/helpers.ts shared helpers, importing directly from `../src/...` so v8
// coverage attributes to source. These functions are exercised indirectly by every other
// equipment-*-unit.test.ts file, but a few branches (settleEquipCoins's coins<=0 / spend-fails paths,
// toInstanceDoc/fromInstanceDoc's optional-field round trip, assembleEquipmentInv's self-heal) are not
// naturally hit by any single equipment mutation, so they get direct coverage here.
import { describe, it, expect } from 'vitest';
import type { EquipmentInstance } from '@nw/shared';
import {
  idemExpireAt,
  toInstanceDoc,
  fromInstanceDoc,
  assembleEquipmentInv,
  leanSave,
  isEquipped,
  settleEquipCoins,
} from '../src/equipment/helpers.js';
import { makeFakeCols, seedSave, seedInst } from './helpers/fakeEquipCols.js';
import { makeFakeEquipCommercial } from './helpers/fakeEquipCommercial.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-helpers';

describe('idemExpireAt', () => {
  it('returns now + EQUIPMENT_IDEM_TTL_SEC (7 days)', () => {
    const d = idemExpireAt(now());
    expect(d.getTime() - now()).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('toInstanceDoc / fromInstanceDoc', () => {
  it('round-trips a minimal instance (no optional fields) without introducing undefined keys', () => {
    const inst: EquipmentInstance = { id: 'i1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    const doc = toInstanceDoc(inst, ACC);
    expect(doc).toEqual({ _id: 'i1', accountId: ACC, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    expect('locked' in doc).toBe(false);
    expect('sourceType' in doc).toBe(false);
    expect('obtainedAt' in doc).toBe(false);
    expect(fromInstanceDoc(doc)).toEqual(inst);
  });

  it('round-trips a full instance (locked/sourceType/obtainedAt all present)', () => {
    const inst: EquipmentInstance = {
      id: 'i2', defId: 'wp_pen', rarity: 'fine', level: 3, affixes: [{ id: 's_atk', value: 5 }],
      locked: true, sourceType: 'gacha:o1', obtainedAt: 12345,
    };
    const doc = toInstanceDoc(inst, ACC);
    expect(doc.locked).toBe(true);
    expect(doc.sourceType).toBe('gacha:o1');
    expect(doc.obtainedAt).toBe(12345);
    expect(fromInstanceDoc(doc)).toEqual(inst);
  });

  it('locked:false is preserved (not dropped like undefined would be)', () => {
    const inst: EquipmentInstance = { id: 'i3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: false };
    const doc = toInstanceDoc(inst, ACC);
    expect(doc.locked).toBe(false);
    expect(fromInstanceDoc(doc).locked).toBe(false);
  });
});

describe('assembleEquipmentInv', () => {
  it('reassembles the full map from equipmentInstances, keyed by instance id', async () => {
    const { cols, equipmentInstances } = makeFakeCols();
    seedInst(equipmentInstances, ACC, { id: 'a1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'a2', defId: 'ar_draft', rarity: 'common', level: 1, affixes: [] });
    const inv = await assembleEquipmentInv(cols, ACC);
    expect(Object.keys(inv).sort()).toEqual(['a1', 'a2']);
    expect(inv.a2!.level).toBe(1);
  });

  it('self-heals equipmentInvCount drift when a `save` is passed and the counts disagree', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const save = seedSave(saves, ACC, now(), (s) => { s.equipmentInvCount = 99; }); // deliberately wrong
    seedInst(equipmentInstances, ACC, { id: 'a3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    await assembleEquipmentInv(cols, ACC, save);
    expect((await saves.findOne({ _id: ACC }))!.save.equipmentInvCount).toBe(1); // healed to the real count
  });

  it('does not touch equipmentInvCount when the counts already agree (no-op write avoided)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const save = seedSave(saves, ACC, now(), (s) => { s.equipmentInvCount = 1; });
    seedInst(equipmentInstances, ACC, { id: 'a4', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    saves.updateOne = async () => { throw new Error('should not be called when counts already match'); };
    await expect(assembleEquipmentInv(cols, ACC, save)).resolves.toBeTruthy();
  });
});

describe('leanSave', () => {
  it('sets equipmentInv to null (not merely omitted) without mutating other fields', async () => {
    const { saves } = makeFakeCols();
    const save = seedSave(saves, ACC, now());
    const leaned = leanSave(save);
    expect(leaned.equipmentInv).toBeNull();
    expect(leaned.accountId).toBe(ACC);
    expect(leaned).not.toBe(save); // new object
  });
});

describe('isEquipped', () => {
  it('true when a card references the instance in any gear slot; false otherwise', async () => {
    const { cols, cardInstances } = makeFakeCols();
    cardInstances.seed({ _id: 'c1', accountId: ACC, defId: 'card_test', level: 1, gear: { armor: 'eq1' }, gearInstanceIds: ['eq1'], locked: false });
    expect(await isEquipped(cols, ACC, 'eq1')).toBe(true);
    expect(await isEquipped(cols, ACC, 'eq-not-worn')).toBe(false);
  });
});

describe('settleEquipCoins', () => {
  it('coins <= 0: skips commercial.spend entirely and just returns the current save', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const comm = makeFakeEquipCommercial();
    const save = await settleEquipCoins(cols, comm, now, ACC, 'k1', 0);
    expect(comm.spendCalls.length).toBe(0);
    expect(save.accountId).toBe(ACC);
  });

  it('commercial unavailable: skips spend, falls back to getOrCreateSave', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const comm = makeFakeEquipCommercial(false);
    const save = await settleEquipCoins(cols, comm, now, ACC, 'k2', 50);
    expect(comm.spendCalls.length).toBe(0);
    expect(save.accountId).toBe(ACC);
  });

  it('spend succeeds: mirrors the resulting coinsAfter into save.wallet.coins', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 100);
    const save = await settleEquipCoins(cols, comm, now, ACC, 'k3', 40);
    expect(save.wallet.coins).toBe(60);
    expect(comm.spendCalls).toEqual([{ accountId: ACC, amount: 40, reason: 'equip_enhance', orderId: 'k3', clientPlatform: undefined }]);
  });

  it('spend fails (insufficient funds mid-flight): does NOT mirror, falls back to getOrCreateSave', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.wallet.coins = 999; }); // stale mirror, should be left untouched
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 0); // real balance too low
    const save = await settleEquipCoins(cols, comm, now, ACC, 'k4', 40);
    expect(save.wallet.coins).toBe(999); // mirror untouched (spend failed, no mirrorCoins call)
  });

  it('passes a custom reason + clientPlatform through to commercial.spend', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 100);
    await settleEquipCoins(cols, comm, now, ACC, 'k5', 10, 'equip_reforge', 'ios');
    expect(comm.spendCalls[0]).toMatchObject({ reason: 'equip_reforge', clientPlatform: 'ios' });
  });
});
