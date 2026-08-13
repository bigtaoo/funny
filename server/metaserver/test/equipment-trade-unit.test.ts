// Unit tests for src/equipment/trade.ts (escrowEquipment/grantEquipment: worldsvc auction escrow +
// transfer), importing directly from `../src/...` so v8 coverage attributes to source (see
// equipment-craft-unit.test.ts header for the "why").
import { describe, it, expect } from 'vitest';
import type { EquipmentInstance, SaveData } from '@nw/shared';
import { escrowEquipment, grantEquipment } from '../src/equipment/trade.js';
import { makeFakeCols, seedSave, seedInst, readInst } from './helpers/fakeEquipCols.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-trade';
const BUYER = 'acc-trade-buyer';

describe('escrowEquipment', () => {
  it('removes the instance from inventory and returns a snapshot', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'e1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await escrowEquipment(cols, now, ACC, 'e1', 'order1');
    expect('error' in r).toBe(false);
    expect((r as { instance: EquipmentInstance }).instance.id).toBe('e1');
    expect(readInst(equipmentInstances, 'e1')).toBeUndefined();
  });

  it('missing instanceId or orderId -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    expect(await escrowEquipment(cols, now, ACC, '', 'order')).toEqual({ error: 'instanceId + orderId required', code: 'BAD_REQUEST' });
    expect(await escrowEquipment(cols, now, ACC, 'e1', '')).toEqual({ error: 'instanceId + orderId required', code: 'BAD_REQUEST' });
  });

  it('non-existent instance -> EQUIP_NOT_FOUND', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const r = await escrowEquipment(cols, now, ACC, 'ghost', 'order-ghost');
    expect(r).toEqual({ error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' });
  });

  it('locked -> EQUIP_LOCKED', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'locked1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: true });
    const r = await escrowEquipment(cols, now, ACC, 'locked1', 'order-locked');
    expect(r).toEqual({ error: 'equipment locked', code: 'EQUIP_LOCKED' });
  });

  it('equipped -> EQUIP_IN_USE', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'worn1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    cardInstances.seed({ _id: 'card1', accountId: ACC, defId: 'card_test', level: 1, gear: { weapon: 'worn1' }, gearInstanceIds: ['worn1'], locked: false });
    const r = await escrowEquipment(cols, now, ACC, 'worn1', 'order-worn');
    expect(r).toEqual({ error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' });
  });

  it('idempotent replay: same orderId returns the same snapshot (no double-removal)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'e2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const e1 = await escrowEquipment(cols, now, ACC, 'e2', 'orderX');
    const e2 = await escrowEquipment(cols, now, ACC, 'e2', 'orderX');
    expect((e2 as { instance: EquipmentInstance }).instance.id).toBe((e1 as { instance: EquipmentInstance }).instance.id);
    expect(readInst(equipmentInstances, 'e2')).toBeUndefined();
  });

  it('save has no document for this account -> NOT_FOUND inside the equipmentInvCount decrement loop (item + ledger still committed)', async () => {
    // Unlike craft/enhance/reforge, escrowEquipment never calls getOrCreateSave — the account must
    // already have a save doc. If it doesn't (deleted account / bad accountId), the destructive delete +
    // idem-ledger write above still land unconditionally; only the informational count-decrement fails.
    const { cols, equipmentInstances, equipmentIdem } = makeFakeCols(); // no save seeded at all
    seedInst(equipmentInstances, ACC, { id: 'e-nosave', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await escrowEquipment(cols, now, ACC, 'e-nosave', 'order-nosave');
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(readInst(equipmentInstances, 'e-nosave')).toBeUndefined(); // deleted anyway
    expect((await equipmentIdem.findOne({ _id: 'order-nosave' }))?.op).toBe('escrow'); // ledger entry still recorded
  });

  it('regression: exhausting rev retries on the count decrement still reports success (item already gone, ledger recorded)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'e-exhaust', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    saves.findOneAndUpdate = async () => null;

    const result = await escrowEquipment(cols, now, ACC, 'e-exhaust', 'order-exhaust');
    expect('error' in result).toBe(false);
    expect((result as { instance: EquipmentInstance }).instance.id).toBe('e-exhaust');
    expect(readInst(equipmentInstances, 'e-exhaust')).toBeUndefined();

    const replay = await escrowEquipment(cols, now, ACC, 'e-exhaust', 'order-exhaust');
    expect((replay as { instance: EquipmentInstance }).instance.id).toBe('e-exhaust');
  });

  it('concurrent escrow: instance vanishes between the findOne and the not-found branch is covered by the idem replay fallback', async () => {
    // Branch: `if (!instDoc) { replay = idem.findOne(orderId); if replay.op==='escrow' return replay; }` —
    // only reachable if the idem doc appears AFTER the top-of-function check but BEFORE this second read.
    // Simulate via a findOne override on equipmentIdem that returns null on the 1st call (top-of-function
    // check) and the real doc on the 2nd call (inside the not-found branch).
    const { cols, saves, equipmentIdem } = makeFakeCols();
    seedSave(saves, ACC, now());
    const snapshot: EquipmentInstance = { id: 'e-vanish', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    equipmentIdem.seed({ _id: 'order-vanish', accountId: ACC, op: 'escrow', result: snapshot, expireAt: new Date(now() + 1000) });
    let calls = 0;
    const realFindOne = equipmentIdem.findOne.bind(equipmentIdem);
    equipmentIdem.findOne = async (q: Record<string, unknown>) => {
      calls++;
      return calls === 1 ? null : realFindOne(q);
    };
    const r = await escrowEquipment(cols, now, ACC, 'e-vanish', 'order-vanish');
    expect(r).toEqual({ instance: snapshot });
  });
});

describe('grantEquipment', () => {
  it('writes the instance into the target account inventory + increments equipmentInvCount + everOwned', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, BUYER, now());
    const inst: EquipmentInstance = { id: 'g1', defId: 'wp_marker', rarity: 'rare', level: 2, affixes: [{ id: 'm_atk', value: 8 }] };
    const r = await grantEquipment(cols, now, BUYER, inst);
    expect(r).toEqual({ ok: true });
    expect(readInst(equipmentInstances, 'g1')).toMatchObject({ id: 'g1', level: 2 });
    const save = (await saves.findOne({ _id: BUYER }))!.save;
    expect(save.equipmentInvCount).toBe(1);
    expect(save.everOwned?.equipment).toContain('wp_marker');
  });

  it('missing instance / instance.id -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, BUYER, now());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await grantEquipment(cols, now, BUYER, undefined as any)).toEqual({ error: 'instance required', code: 'BAD_REQUEST' });
    expect(await grantEquipment(cols, now, BUYER, { id: '', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] })).toEqual({
      error: 'instance required',
      code: 'BAD_REQUEST',
    });
  });

  it('idempotent replay: re-sending the same instance overwrites by id and does not double-increment the count', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, BUYER, now());
    const inst: EquipmentInstance = { id: 'g2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    await grantEquipment(cols, now, BUYER, inst);
    await grantEquipment(cols, now, BUYER, { ...inst, level: 3 }); // even a mutated resend of the same id
    expect(readInst(equipmentInstances, 'g2')).toMatchObject({ level: 3 }); // overwritten
    const save = (await saves.findOne({ _id: BUYER }))!.save;
    expect(save.equipmentInvCount).toBe(1); // not double-incremented
  });

  it('save not found -> NOT_FOUND, instance write is NOT rolled back (documents the existing non-transactional ordering)', async () => {
    const { cols, equipmentInstances } = makeFakeCols(); // no save seeded
    const inst: EquipmentInstance = { id: 'g-nosave', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    const r = await grantEquipment(cols, now, 'acc-no-save', inst);
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(readInst(equipmentInstances, 'g-nosave')).toBeTruthy(); // upsert already landed before the save-side loop
  });

  it('regression: exhausting rev retries on the count increment -> REV_CONFLICT (grant has no idem claim to release)', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, BUYER, now());
    saves.findOneAndUpdate = async () => null;
    const inst: EquipmentInstance = { id: 'g-exhaust', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    const r = await grantEquipment(cols, now, BUYER, inst);
    expect(r).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
  });
});
