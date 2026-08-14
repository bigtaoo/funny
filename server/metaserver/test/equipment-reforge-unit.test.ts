// Unit tests for src/equipment/reforge.ts (reforgeEquipment), importing directly from `../src/...`
// so v8 coverage attributes to source (see equipment-craft-unit.test.ts header for the "why").
import { describe, it, expect } from 'vitest';
import { reforgeCoinCost, type EquipmentInstance, type SaveData } from '@nw/shared';
import { reforgeEquipment } from '../src/equipment/reforge.js';
import { makeFakeCols, seedSave, seedInst, readInst } from './helpers/fakeEquipCols.js';
import { makeFakeEquipCommercial } from './helpers/fakeEquipCommercial.js';

const now = () => 1_700_000_000_000;
const ACC = 'acc-reforge';

describe('reforgeEquipment', () => {
  it('success: target re-rolled (main affix kept), material consumed, coins deducted', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt0', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 8 }] });
    seedInst(equipmentInstances, ACC, { id: 'rm0', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const before = comm.bal(ACC);
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt0', 'rm0', 'rk-happy');
    expect('error' in r).toBe(false);
    const ok = r as { instance: EquipmentInstance; save: SaveData };
    expect(ok.instance.id).toBe('rt0');
    expect(ok.instance.affixes.find((a) => a.id === 'm_atk')?.value).toBe(8); // main affix preserved
    expect(readInst(equipmentInstances, 'rm0')).toBeUndefined(); // fuel consumed
    expect(comm.bal(ACC)).toBeLessThan(before);
    expect(comm.bal(ACC)).toBe(before - reforgeCoinCost('fine'));
  });

  it('missing idempotencyKey -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    const r = await reforgeEquipment(cols, comm, now, ACC, 't', 'm', '');
    expect(r).toEqual({ error: 'idempotencyKey required', code: 'BAD_REQUEST' });
  });

  it('targetId === materialId -> BAD_REQUEST', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    const r = await reforgeEquipment(cols, comm, now, ACC, 'same', 'same', 'rk1');
    expect(r).toEqual({ error: 'target and material must differ', code: 'BAD_REQUEST' });
  });

  it('commercial unavailable -> NOT_IMPLEMENTED (reforge is a coin sink, ADR-030)', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial(false);
    seedSave(saves, ACC, now());
    const r = await reforgeEquipment(cols, comm, now, ACC, 't', 'm', 'rk2');
    expect(r).toEqual({ error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' });
  });

  it('target not found -> EQUIP_NOT_FOUND', async () => {
    const { cols, saves } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    const r = await reforgeEquipment(cols, comm, now, ACC, 'ghost-t', 'ghost-m', 'rk3');
    expect(r).toEqual({ error: 'target equipment not found', code: 'EQUIP_NOT_FOUND' });
  });

  it('target is equipped -> EQUIP_IN_USE', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-eq', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    cardInstances.seed({ _id: 'card1', accountId: ACC, defId: 'card_test', level: 1, gear: { weapon: 'rt-eq' }, gearInstanceIds: ['rt-eq'], locked: false });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-eq', 'rm-x', 'rk4');
    expect(r).toEqual({ error: 'target is equipped', code: 'EQUIP_IN_USE' });
  });

  it('target is locked -> EQUIP_LOCKED', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-lock', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [], locked: true });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-lock', 'rm-x', 'rk5');
    expect(r).toEqual({ error: 'target is locked', code: 'EQUIP_LOCKED' });
  });

  it('target rarity not reforge-eligible (common has no sub-affixes) -> NOT_REFORGE_ELIGIBLE', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-common', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-common', 'rm-x', 'rk6');
    expect(r).toEqual({ error: 'common equipment cannot be reforged', code: 'NOT_REFORGE_ELIGIBLE' });
  });

  it('material not found -> EQUIP_NOT_FOUND', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-nomat', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-nomat', 'ghost-m', 'rk7');
    expect(r).toEqual({ error: 'material equipment not found', code: 'EQUIP_NOT_FOUND' });
  });

  it('material is equipped -> EQUIP_IN_USE', async () => {
    const { cols, saves, equipmentInstances, cardInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-me', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-me', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    cardInstances.seed({ _id: 'card2', accountId: ACC, defId: 'card_test', level: 1, gear: { weapon: 'rm-me' }, gearInstanceIds: ['rm-me'], locked: false });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-me', 'rm-me', 'rk8');
    expect(r).toEqual({ error: 'material is equipped', code: 'EQUIP_IN_USE' });
  });

  it('material is locked -> EQUIP_LOCKED (2026-08-03 fix)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-ml', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-ml', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: true });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-ml', 'rm-ml', 'rk9');
    expect(r).toEqual({ error: 'material is locked', code: 'EQUIP_LOCKED' });
  });

  it('unknown equipment def on target or material -> BAD_REQUEST', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-unk', defId: 'totally_unknown_def', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-unk', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-unk', 'rm-unk', 'rk10');
    expect(r).toEqual({ error: 'unknown equipment def', code: 'BAD_REQUEST' });
  });

  it('material slot mismatch (armor material for a weapon target) -> INVALID_SLOT', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-slot', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] }); // weapon
    seedInst(equipmentInstances, ACC, { id: 'rm-slot', defId: 'ar_draft', rarity: 'common', level: 0, affixes: [] }); // armor
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-slot', 'rm-slot', 'rk11');
    expect(r).toEqual({ error: 'material slot armor must match target slot weapon', code: 'INVALID_SLOT' });
  });

  it('material rarity mismatch (must be exactly one tier lower) -> INVALID_RARITY', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-rar', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] }); // needs a fine material
    seedInst(equipmentInstances, ACC, { id: 'rm-rar', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] }); // wrong: common, not fine
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-rar', 'rm-rar', 'rk12');
    expect(r).toEqual({ error: 'material must be fine (got common)', code: 'INVALID_RARITY' });
  });

  it('material already enhanced (level != 0) -> INVALID_MATERIAL_LEVEL', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-lvl', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-lvl', defId: 'wp_pencil', rarity: 'common', level: 1, affixes: [] });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-lvl', 'rm-lvl', 'rk13');
    expect(r).toEqual({ error: 'material must be unenhanced (+0), got +1', code: 'INVALID_MATERIAL_LEVEL' });
  });

  it('insufficient coins -> INSUFFICIENT_FUNDS, no mutation', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1); // reforgeCoinCost('fine') = 80
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-poor', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-poor', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-poor', 'rm-poor', 'rk14');
    expect(r).toEqual({ error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' });
    expect(readInst(equipmentInstances, 'rm-poor')).toBeTruthy(); // fuel NOT consumed
  });

  it('idempotent replay: same key returns the same result without re-consuming a (now-absent) material', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-rep', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-rep', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const r1 = await reforgeEquipment(cols, comm, now, ACC, 'rt-rep', 'rm-rep', 'rk-rep');
    const balAfterFirst = comm.bal(ACC);
    const r2 = await reforgeEquipment(cols, comm, now, ACC, 'rt-rep', 'rm-rep', 'rk-rep');
    expect((r2 as { instance: EquipmentInstance }).instance.id).toBe((r1 as { instance: EquipmentInstance }).instance.id);
    expect(comm.bal(ACC)).toBe(balAfterFirst); // not double-charged
  });

  it('save disappearing mid-flight (concurrent account deletion) -> NOT_FOUND inside the count-decrement loop, claim released', async () => {
    const { cols, saves, equipmentInstances, equipmentIdem } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-vanish', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-vanish', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    saves.findOne = async () => null; // reforge's own save-fetch loop never calls getOrCreateSave first
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-vanish', 'rm-vanish', 'rk-vanish');
    expect(r).toEqual({ error: 'save not found', code: 'NOT_FOUND' });
    expect(await equipmentIdem.findOne({ _id: 'rk-vanish' })).toBeNull();
    // Target upgrade + material deletion already committed unconditionally before this loop, per the doc comment.
    expect(readInst(equipmentInstances, 'rm-vanish')).toBeUndefined();
  });

  it('regression: equipmentInvCount rev-loop exhaustion still completes the reforge (coins settled)', async () => {
    const { cols, saves, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-exh', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-exh', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const before = comm.bal(ACC);
    saves.findOneAndUpdate = async () => null;

    const result = await reforgeEquipment(cols, comm, now, ACC, 'rt-exh', 'rm-exh', 'rk-exhaust');
    expect('error' in result).toBe(false);
    expect(readInst(equipmentInstances, 'rt-exh')).toBeTruthy();
    expect(readInst(equipmentInstances, 'rm-exh')).toBeUndefined(); // fuel gone
    expect(comm.bal(ACC)).toBeLessThan(before); // coin fee still collected via the fallback settlement
  });

  it('E11000 race against a concurrent duplicate reforge: replay-grants (verify-and-heal) via the catch branch', async () => {
    const { cols, saves, equipmentIdem, equipmentInstances } = makeFakeCols();
    const comm = makeFakeEquipCommercial();
    comm.setCoins(ACC, 1000);
    seedSave(saves, ACC, now());
    seedInst(equipmentInstances, ACC, { id: 'rt-race', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [] });
    seedInst(equipmentInstances, ACC, { id: 'rm-race', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    const reforged: EquipmentInstance = { id: 'rt-race', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 8 }] };
    // Simulate the race window: insertOne's own duplicate-key branch, by making the FIRST insertOne call
    // seed a competing "already inserted by the original request" doc and then throw E11000.
    const realInsertOne = equipmentIdem.insertOne.bind(equipmentIdem);
    let first = true;
    equipmentIdem.insertOne = async (doc) => {
      if (first) {
        first = false;
        equipmentIdem.docs.set(doc._id, { _id: doc._id, accountId: ACC, op: 'reforge', result: { instance: reforged, coins: reforgeCoinCost('fine') }, expireAt: doc.expireAt });
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      return realInsertOne(doc);
    };
    const r = await reforgeEquipment(cols, comm, now, ACC, 'rt-race', 'rm-race', 'rk-race');
    expect('error' in r).toBe(false);
    expect((r as { instance: EquipmentInstance }).instance.id).toBe('rt-race');
    expect(readInst(equipmentInstances, 'rm-race')).toBeUndefined(); // fuel still consumed via the replay branch
  });
});
