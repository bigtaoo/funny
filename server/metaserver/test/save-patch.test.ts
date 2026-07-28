// applySyncPatch trust-boundary unit tests (M5 / SERVER_API.md §2.2) — always-run, no Mongo required.
//
// Security guard against client tampering: PUT /save only accepts sync fields;
// wallet / inventory / gacha / ladder are server-authoritative.
// e2e (save.e2e.test.ts) also verifies the "hard wall", but only when Mongo is running; this function is pure logic
// and must be covered unconditionally — otherwise this security assertion is silently absent in CI without a DB.
//
// Imports from dist (metaserver uses NodeNext/ESM, .js extension); run tsc -b first (already included in the test script).
import { describe, expect, it } from 'vitest';
import { makeNewSave } from '@nw/shared';
import { applySyncPatch } from '../dist/save.js';

const NOW = 1_700_000_000_000;

describe('applySyncPatch trust boundary', () => {
  it('only overwrites sync fields; authoritative fields (wallet/inventory/gacha/pvp) are preserved', () => {
    const prev = makeNewSave('acc', 0);
    prev.wallet.coins = 500;
    prev.inventory.skins = ['skin_a'];
    prev.pvp.elo = 1234;
    prev.gacha.pity = { pool1: 7 };

    const next = applySyncPatch(prev, { flags: { seen_intro: true } }, NOW, 1);

    expect(next.wallet.coins).toBe(500);
    expect(next.inventory.skins).toEqual(['skin_a']);
    expect(next.pvp.elo).toBe(1234);
    expect(next.gacha.pity).toEqual({ pool1: 7 });
    expect(next.flags).toEqual({ seen_intro: true });
  });

  it('hard wall: authoritative fields injected into patch are structurally discarded (HTTP body is untyped, client tampering has no effect)', () => {
    const prev = makeNewSave('acc', 0);
    // Simulate a malicious / out-of-bounds body: SyncPatch type does not include these fields and they must be dropped at runtime.
    // As of PVE_INTEGRITY_PLAN §8, progress/materials/pveUpgrades are also server-authoritative → equally discarded.
    const malicious = {
      flags: { x: true },
      wallet: { coins: 999_999 },
      inventory: { skins: ['hacked'], items: { gold: 999 } },
      pvp: { elo: 9999, rank: 'legend', wins: 999, losses: 0, streak: 99 },
      gacha: { pity: { p: 999 } },
      progress: { cleared: ['ch_stress'], stars: { ch_stress: 3 }, best: {} },
      materials: { scrap: 999 },
      pveUpgrades: { inf_hp: 5 },
    } as Parameters<typeof applySyncPatch>[1];

    const next = applySyncPatch(prev, malicious, NOW, 1);

    expect(next.wallet.coins).toBe(0); // not overwritten by 999999
    expect(next.inventory.skins).toEqual([]); // not overwritten by 'hacked'
    expect(next.pvp.elo).toBe(1000); // default value, not overwritten by 9999
    expect(next.gacha.pity).toEqual({}); // not overwritten
    expect(next.progress.cleared).toEqual([]); // §8 server-authoritative, not overwritten
    expect(next.materials).toEqual({}); // §8 server-authoritative, not overwritten
    expect(next.pveUpgrades).toEqual({}); // §8 server-authoritative, not overwritten
    expect(next.flags).toEqual({ x: true }); // legitimate sync field written as expected
  });

  it('rev / updatedAt are set from parameters, everything else unchanged', () => {
    const prev = makeNewSave('acc', 0);
    const next = applySyncPatch(prev, {}, NOW, 5);
    expect(next.rev).toBe(5);
    expect(next.updatedAt).toBe(NOW);
    expect(next.accountId).toBe('acc');
    expect(next.version).toBe(prev.version);
  });

  it('empty patch: all fields retain prev values (only rev/updatedAt advance)', () => {
    const prev = makeNewSave('acc', 0);
    prev.progress.cleared = ['ch1_lv1'];
    prev.materials = { wood: 3 };
    prev.equipped = { skin: 's1' };
    const next = applySyncPatch(prev, {}, NOW, 1);
    expect(next.progress.cleared).toEqual(['ch1_lv1']);
    expect(next.materials).toEqual({ wood: 3 });
    expect(next.equipped).toEqual({ skin: 's1' });
  });

  it('partial patch: provided sync fields (equipped/flags) are overwritten, unprovided fields retain prev', () => {
    const prev = makeNewSave('acc', 0);
    prev.equipped = { skin: 's1' };
    prev.flags = { seen_intro: true };

    const next = applySyncPatch(prev, { equipped: { skin: 's2' } }, NOW, 1);

    expect(next.equipped).toEqual({ skin: 's2' }); // overwritten
    expect(next.flags).toEqual({ seen_intro: true }); // not provided → retained
  });

  it('does not mutate the prev argument (no side effects)', () => {
    const prev = makeNewSave('acc', 0);
    applySyncPatch(prev, { flags: { a: true } }, NOW, 1);
    expect(prev.flags).toEqual({}); // prev is not mutated
    expect(prev.rev).toBe(0);
  });
});

// P0-11 (comm-audit-2026-07-27 finding B12): PUT /save is a full-map replace of `equipped` with zero
// ownership checks, while the two dedicated endpoints (service/liveops.ts equipTitle/equipAvatar) that
// DO validate ownership are never called by the client — this is the only path that actually writes
// equipped, and it must reject/strip entries the account doesn't own.
describe('applySyncPatch equipped ownership validation', () => {
  it('title: only an owned title is accepted; an unowned one is stripped', () => {
    const prev = makeNewSave('acc', 0);
    prev.titles = ['starter', 'season1_gold'];

    const owned = applySyncPatch(prev, { equipped: { title: 'season1_gold' } }, NOW, 1);
    expect(owned.equipped).toEqual({ title: 'season1_gold' });

    const unowned = applySyncPatch(prev, { equipped: { title: 'legendary_champion' } }, NOW, 1);
    expect(unowned.equipped).toEqual({}); // stripped, not persisted
  });

  it('avatar: preset digits are always allowed with no ownership check', () => {
    const prev = makeNewSave('acc', 0);
    const next = applySyncPatch(prev, { equipped: { avatar: '3' } }, NOW, 1);
    expect(next.equipped).toEqual({ avatar: '3' });
  });

  it('avatar: composite id requires the category-specific lifetime-owned record; unowned is stripped', () => {
    const prev = makeNewSave('acc', 0);
    prev.everOwned = { hero: ['lichuang'] };

    const owned = applySyncPatch(prev, { equipped: { avatar: 'hero:lichuang' } }, NOW, 1);
    expect(owned.equipped).toEqual({ avatar: 'hero:lichuang' });

    const unowned = applySyncPatch(prev, { equipped: { avatar: 'hero:never_obtained' } }, NOW, 1);
    expect(unowned.equipped).toEqual({});
  });

  it('avatar: title/equip/material/skin categories each check their own lifetime-owned bucket', () => {
    const prev = makeNewSave('acc', 0);
    prev.titles = ['season1_gold'];
    prev.everOwned = { equipment: ['sword_def'], material: ['scrap'] };
    prev.inventory.skins = ['owned_skin'];

    expect(applySyncPatch(prev, { equipped: { avatar: 'title:season1_gold' } }, NOW, 1).equipped).toEqual({ avatar: 'title:season1_gold' });
    expect(applySyncPatch(prev, { equipped: { avatar: 'equip:sword_def' } }, NOW, 1).equipped).toEqual({ avatar: 'equip:sword_def' });
    expect(applySyncPatch(prev, { equipped: { avatar: 'material:scrap' } }, NOW, 1).equipped).toEqual({ avatar: 'material:scrap' });
    expect(applySyncPatch(prev, { equipped: { avatar: 'skin:owned_skin' } }, NOW, 1).equipped).toEqual({ avatar: 'skin:owned_skin' });
    expect(applySyncPatch(prev, { equipped: { avatar: 'material:never_had' } }, NOW, 1).equipped).toEqual({});
  });

  it('skin:<UnitType> equip slot requires the skin in inventory.skins or everOwned.skin', () => {
    const prev = makeNewSave('acc', 0);
    prev.inventory.skins = ['scholar_gold'];
    prev.everOwned = { skin: ['warrior_festival'] };

    const fromInventory = applySyncPatch(prev, { equipped: { 'skin:Scholar': 'scholar_gold' } }, NOW, 1);
    expect(fromInventory.equipped).toEqual({ 'skin:Scholar': 'scholar_gold' });

    // Auction-escrowed away from inventory.skins but still in the lifetime-owned ledger — still allowed.
    const fromLedger = applySyncPatch(prev, { equipped: { 'skin:Warrior': 'warrior_festival' } }, NOW, 1);
    expect(fromLedger.equipped).toEqual({ 'skin:Warrior': 'warrior_festival' });

    const unowned = applySyncPatch(prev, { equipped: { 'skin:Warrior': 'never_owned_skin' } }, NOW, 1);
    expect(unowned.equipped).toEqual({});
  });

  it('a mixed patch strips only the unowned entries, keeping the owned ones', () => {
    const prev = makeNewSave('acc', 0);
    prev.titles = ['starter'];
    prev.inventory.skins = ['scholar_gold'];

    const next = applySyncPatch(prev, {
      equipped: { title: 'starter', avatar: 'hero:never_obtained', 'skin:Scholar': 'scholar_gold' },
    }, NOW, 1);

    expect(next.equipped).toEqual({ title: 'starter', 'skin:Scholar': 'scholar_gold' });
  });
});
