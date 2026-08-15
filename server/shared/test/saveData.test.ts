// Unit tests for types.ts's only runtime function, makeNewSave() (everything else in types.ts is
// interface/type declarations, erased at compile time and not executable).
import { describe, it, expect } from 'vitest';
import { makeNewSave, SAVE_VERSION } from '../src/types';
import { STARTER_TITLE } from '../src/titles';

describe('makeNewSave', () => {
  it('builds a fresh zero-state save with accountId/now threaded through', () => {
    const now = 1700000000000;
    const save = makeNewSave('acc-42', now);

    expect(save.version).toBe(SAVE_VERSION);
    expect(save.accountId).toBe('acc-42');
    expect(save.rev).toBe(0);
    expect(save.updatedAt).toBe(now);

    expect(save.wallet).toEqual({ coins: 0 });
    expect(save.inventory).toEqual({ skins: [], items: {} });
    expect(save.gacha).toEqual({ pity: {} });
    expect(save.deliveredOrders).toEqual([]);

    expect(save.pvp).toEqual({
      elo: 1000,
      rank: 'unranked',
      wins: 0,
      losses: 0,
      streak: 0,
      seasonNo: 1,
      seasonPeakElo: 1000,
      seasonPeakRank: 'bronze',
      reachedRanks: [],
    });

    expect(save.progress).toEqual({ cleared: [], stars: {}, best: {} });
    expect(save.materials).toEqual({});
    expect(save.pveUpgrades).toEqual({});
    expect(save.cardInventory).toEqual({});

    expect(save.titles).toEqual([STARTER_TITLE]);
    expect(save.titleGrants).toEqual({ [STARTER_TITLE]: now });
    expect(save.equipped).toEqual({ title: STARTER_TITLE });
    expect(save.flags).toEqual({});

    expect(save.equipmentInvCount).toBe(0);
    expect(save.cardInvCount).toBe(0);
  });

  it('two calls with different accountId/now produce independent objects (no shared mutable state)', () => {
    const save1 = makeNewSave('acc-1', 100);
    const save2 = makeNewSave('acc-2', 200);
    save1.titles!.push('extra-title');
    expect(save2.titles).toEqual([STARTER_TITLE]); // not affected by mutating save1
    expect(save1.accountId).toBe('acc-1');
    expect(save2.accountId).toBe('acc-2');
    expect(save1.updatedAt).toBe(100);
    expect(save2.updatedAt).toBe(200);
  });
});
