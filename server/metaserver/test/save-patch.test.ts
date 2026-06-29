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

describe('applySyncPatch 信任边界', () => {
  it('只覆盖同步段，权威段（wallet/inventory/gacha/pvp）原样保留', () => {
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

  it('硬墙：patch 塞入权威段被结构性丢弃（HTTP body 无类型，客户端篡改无效）', () => {
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

  it('rev / updatedAt 按入参设定，其余不变', () => {
    const prev = makeNewSave('acc', 0);
    const next = applySyncPatch(prev, {}, NOW, 5);
    expect(next.rev).toBe(5);
    expect(next.updatedAt).toBe(NOW);
    expect(next.accountId).toBe('acc');
    expect(next.version).toBe(prev.version);
  });

  it('空 patch：所有段保持 prev（仅 rev/updatedAt 推进）', () => {
    const prev = makeNewSave('acc', 0);
    prev.progress.cleared = ['ch1_lv1'];
    prev.materials = { wood: 3 };
    prev.equipped = { skin: 's1' };
    const next = applySyncPatch(prev, {}, NOW, 1);
    expect(next.progress.cleared).toEqual(['ch1_lv1']);
    expect(next.materials).toEqual({ wood: 3 });
    expect(next.equipped).toEqual({ skin: 's1' });
  });

  it('部分 patch：提供的同步段（equipped/flags）覆盖，未提供的保留 prev', () => {
    const prev = makeNewSave('acc', 0);
    prev.equipped = { skin: 's1' };
    prev.flags = { seen_intro: true };

    const next = applySyncPatch(prev, { equipped: { skin: 's2' } }, NOW, 1);

    expect(next.equipped).toEqual({ skin: 's2' }); // overwritten
    expect(next.flags).toEqual({ seen_intro: true }); // not provided → retained
  });

  it('不改动入参 prev（无副作用）', () => {
    const prev = makeNewSave('acc', 0);
    applySyncPatch(prev, { flags: { a: true } }, NOW, 1);
    expect(prev.flags).toEqual({}); // prev is not mutated
    expect(prev.rev).toBe(0);
  });
});
