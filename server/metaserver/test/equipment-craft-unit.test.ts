// Unit tests for src/equipment/craft.ts (craftEquipment), importing directly from `../src/...`
// (NOT `../dist/...`) so v8 coverage attributes executed lines back to source — see
// equipment.e2e.test.ts's header comment for why the dist-importing e2e suite (which already
// exercises these same behaviors) doesn't count toward src/*.ts coverage.
// No Mongo: Collections is backed by FakeCollection (test/helpers/fakeEquipCols.ts).
import { describe, it, expect } from 'vitest';
import { EQUIPMENT_INV_CAP, type EquipmentInstance } from '@nw/shared';
import { craftEquipment } from '../src/equipment/craft.js';
import { makeFakeCols, seedSave, seedInst, readInst } from './helpers/fakeEquipCols.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-craft';

describe('craftEquipment', () => {
  it('success: deducts materials, inserts instance with primary affix, stamps provenance', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });

    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'ik1');
    expect('error' in r).toBe(false);
    const ok = r as { instance: EquipmentInstance; save: import('@nw/shared').SaveData };
    expect(ok.instance.defId).toBe('wp_pencil');
    expect(ok.instance.level).toBe(0);
    expect(ok.instance.rarity).toBe('common');
    expect(ok.instance.affixes).toHaveLength(1);
    expect(ok.instance.sourceType).toBe('craft');
    expect(ok.instance.obtainedAt).toBe(now());
    expect(ok.save.materials.scrap).toBe(15);
    expect(ok.save.equipmentInv).toBeNull(); // leanSave
    expect(readInst(equipmentInstances, ok.instance.id)).toBeTruthy();
  });

  it('fine rarity rolls 1 secondary affix and consumes the multi-material recipe', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20, lead: 10 }; });
    const r = await craftEquipment(cols, now, ACC, 'wp_pen', 'ik2');
    const ok = r as { instance: EquipmentInstance; save: import('@nw/shared').SaveData };
    expect(ok.instance.affixes.length).toBe(2);
    expect(ok.save.materials.scrap).toBe(12);
    expect(ok.save.materials.lead).toBe(8);
  });

  it('unknown defId -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const r = await craftEquipment(cols, now, ACC, 'nope', 'ik-bad');
    expect(r).toEqual({ error: 'unknown defId', code: 'BAD_REQUEST' });
  });

  it('non-craftable defId (epic, drop/gacha only) -> BAD_REQUEST (branch e2e never exercises)', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now());
    const r = await craftEquipment(cols, now, ACC, 'wp_highlighter', 'ik-epic');
    expect(r).toEqual({ error: 'defId not craftable', code: 'BAD_REQUEST' });
  });

  it('missing idempotencyKey -> BAD_REQUEST (schema requires it at HTTP layer, but the function itself must guard too)', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', '');
    expect(r).toEqual({ error: 'idempotencyKey required', code: 'BAD_REQUEST' });
  });

  it('insufficient materials -> INSUFFICIENT_MATERIALS, nothing charged or granted', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 2 }; });
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'ik3');
    expect(r).toEqual({ error: 'insufficient scrap', code: 'INSUFFICIENT_MATERIALS' });
    expect(equipmentInstances.docs.size).toBe(0);
  });

  it('full inventory -> INVENTORY_FULL', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; s.equipmentInvCount = EQUIPMENT_INV_CAP; });
    for (let i = 0; i < EQUIPMENT_INV_CAP; i++) {
      seedInst(equipmentInstances, ACC, { id: `fill_${i}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    }
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'ik-full');
    expect(r).toEqual({ error: 'equipment inventory full', code: 'INVENTORY_FULL' });
  });

  it('boundary: exactly cap-1 instances still succeeds (off-by-one guard)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; s.equipmentInvCount = EQUIPMENT_INV_CAP - 1; });
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'ik-almost-full');
    expect('error' in r).toBe(false);
    expect(equipmentInstances.docs.size).toBe(1);
  });

  it('idempotent replay: same key twice does not deduct materials twice or re-roll', async () => {
    const { cols, saves } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });
    const r1 = await craftEquipment(cols, now, ACC, 'wp_pencil', 'dup-key');
    const r2 = await craftEquipment(cols, now, ACC, 'wp_pencil', 'dup-key');
    const i1 = (r1 as { instance: EquipmentInstance }).instance;
    const i2 = (r2 as { instance: EquipmentInstance }).instance;
    expect(i2.id).toBe(i1.id);
    const save2 = (r2 as { save: import('@nw/shared').SaveData }).save;
    expect(save2.materials.scrap).toBe(15); // deducted only once
  });

  it('regression: a duplicate request behind an UNCOMMITTED claim (racing key) is rejected, not granted for free', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });
    const key = 'racing-key';
    equipmentIdem.seed({
      _id: key,
      accountId: ACC,
      op: 'craft',
      result: { id: `eq_${key}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] },
      committed: false,
      expireAt: new Date(now() + 3600_000),
    });
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', key);
    expect(r).toEqual({ error: 'craft already in progress, retry', code: 'REV_CONFLICT' });
    expect(equipmentInstances.docs.size).toBe(0);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(20);
  });

  it('E11000 race with an already-COMMITTED claim: replay-grants (verify-and-heal) instead of erroring', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 15 }; }); // already post-deduction, as if the original request committed
    const key = 'committed-key';
    const instance: EquipmentInstance = { id: `eq_${key}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 8 }] };
    equipmentIdem.seed({ _id: key, accountId: ACC, op: 'craft', result: instance, committed: true, expireAt: new Date(now() + 3600_000) });
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', key);
    expect('error' in r).toBe(false);
    const ok = r as { instance: EquipmentInstance };
    expect(ok.instance.id).toBe(instance.id);
    expect(readInst(equipmentInstances, instance.id)).toBeTruthy(); // re-asserted into the instances collection
  });

  it('regression: exhausting rev retries releases the idem claim (does not wedge the key forever)', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });
    const realFindOneAndUpdate = saves.findOneAndUpdate.bind(saves);
    saves.findOneAndUpdate = async () => null; // simulate permanent contention
    const first = await craftEquipment(cols, now, ACC, 'wp_pencil', 'stuck-key');
    expect(first).toEqual({ error: 'rev conflict, retry', code: 'REV_CONFLICT' });
    expect(equipmentInstances.docs.size).toBe(0);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(20);
    expect(await equipmentIdem.findOne({ _id: 'stuck-key' })).toBeNull(); // claim released

    saves.findOneAndUpdate = realFindOneAndUpdate; // restore for the retry
    const retry = await craftEquipment(cols, now, ACC, 'wp_pencil', 'stuck-key');
    expect('error' in retry).toBe(false);
    expect((await saves.findOne({ _id: ACC }))!.save.materials.scrap).toBe(15);
  });

  it('materials become insufficient between the pre-check and the rev loop (concurrent spend) -> INSUFFICIENT_MATERIALS, claim released', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; }); // enough at pre-check time
    let calls = 0;
    const realFindOne = saves.findOne.bind(saves);
    saves.findOne = async (q: Record<string, unknown>) => {
      calls++;
      const d = await realFindOne(q);
      if (calls === 1 || !d) return d; // pre-check (getOrCreateSave) sees the real (sufficient) materials
      return { ...d, save: { ...d.save, materials: { scrap: 1 } } }; // in-loop read: a concurrent spend already happened
    };
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'race-mat-key');
    expect(r).toEqual({ error: 'insufficient scrap', code: 'INSUFFICIENT_MATERIALS' });
    expect(equipmentInstances.docs.size).toBe(0);
    expect(await equipmentIdem.findOne({ _id: 'race-mat-key' })).toBeNull();
  });

  it('inventory becomes full between the pre-check and the rev loop (concurrent craft) -> INVENTORY_FULL, claim released', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; s.equipmentInvCount = 0; }); // room at pre-check time
    let calls = 0;
    const realFindOne = saves.findOne.bind(saves);
    saves.findOne = async (q: Record<string, unknown>) => {
      calls++;
      const d = await realFindOne(q);
      if (calls === 1 || !d) return d;
      return { ...d, save: { ...d.save, equipmentInvCount: EQUIPMENT_INV_CAP } }; // a concurrent craft already filled it
    };
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'race-full-key');
    expect(r).toEqual({ error: 'equipment inventory full', code: 'INVENTORY_FULL' });
    expect(equipmentInstances.docs.size).toBe(0);
    expect(await equipmentIdem.findOne({ _id: 'race-full-key' })).toBeNull();
  });

  it('save disappearing mid-flight (concurrent account deletion) -> NOT_FOUND inside the rev loop', async () => {
    const { cols, saves, equipmentIdem } = makeFakeCols();
    seedSave(saves, ACC, now(), (s) => { s.materials = { scrap: 20 }; });
    let calls = 0;
    const realFindOne = saves.findOne.bind(saves);
    saves.findOne = async (q: Record<string, unknown>) => {
      calls++;
      return calls === 1 ? realFindOne(q) : null; // 1st call = pre-validate (getOrCreateSave); 2nd = inside the loop
    };
    const r = await craftEquipment(cols, now, ACC, 'wp_pencil', 'vanish-key');
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(await equipmentIdem.findOne({ _id: 'vanish-key' })).toBeNull(); // claim released, not wedged
  });
});
