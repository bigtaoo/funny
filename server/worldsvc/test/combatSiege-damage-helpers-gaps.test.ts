// Unit tests (hand-built fake WorldCore, no Mongo — same style as occupation-battle.test.ts /
// get-teams-card-lookup.test.ts) targeting the branch-coverage gaps in combatSiege/damage.ts
// (SiegeDamageService, 34.78% branch) and combatSiege/helpers.ts (SiegeHelpersService, 64.15%
// branch). Both classes only ever touch `this.core` (deps.cols + a handful of core methods) plus,
// for damage.ts, a `SiegeHelpersService`-shaped object — every dependency is stubbed directly, no
// real Mongo needed. Real @nw/shared pure functions (buildingMaxHp/baseDurabilityMax/
// regenDurability/buildingLevel/cabinetLootProtect/npcBaseHp) are used unmocked so expected values
// are computed the same way the source does, following occupation-battle.test.ts's convention of
// asserting against the real formula rather than a hand-duplicated constant.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildingMaxHp,
  baseDurabilityMax,
  regenDurability,
  cabinetLootProtect,
  npcBaseHp,
  SIEGE_LOOT_RATE,
  RESOURCE_TYPES,
  RESOURCE_CAP,
} from '@nw/shared';
import { SiegeDamageService } from '../src/combatSiege/damage';
import { SiegeHelpersService } from '../src/combatSiege/helpers';
import { emptyResources } from '../src/core';
import type { WorldCore } from '../src/core';
import type { SiegeHelpersService as SHS } from '../src/combatSiege/helpers';
import type { PlayerWorldDoc, TileDoc, SiegeDamageDoc, MarchDoc } from '../src/db';

const W = 's1';
const ATK = 'atk-1';
const DEF = 'def-1';
const TILE = `${W}:5:5`;

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${overrides.accountId ?? ATK}`,
    worldId: W,
    accountId: ATK,
    troops: 0,
    troopCap: 10_000,
    resources: emptyResources(),
    yieldRate: emptyResources(),
    lastTickAt: 0,
    rev: 0,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return {
    _id: TILE, worldId: W, x: 5, y: 5, type: 'territory', level: 1, ownerId: DEF, garrison: 0, rev: 0,
    ...overrides,
  } as unknown as TileDoc;
}

function dmgDoc(overrides: Partial<SiegeDamageDoc> = {}): SiegeDamageDoc {
  return {
    _id: 'siege-1', worldId: W, attackerId: ATK, defenderId: DEF, tile: TILE,
    isBase: false, damage: 10, attackerSurvivors: 5, dueAt: 0,
    ...overrides,
  } as unknown as SiegeDamageDoc;
}

/** Fake WorldCore covering exactly what damage.ts touches (tiles/playerWorld collections + a
 * handful of core methods). `pwById` seeds the playerWorld fake collection by _id; `tilesFindOne`
 * lets a test drive successive tiles.findOne calls (the initial re-validate read, then the later
 * "after" re-fetch) with different results per call. */
function makeCore(opts: {
  pwById?: Record<string, PlayerWorldDoc | null>;
  tilesFindOne?: (call: number, query: unknown) => TileDoc | null;
  tilesUpdateOne?: ReturnType<typeof vi.fn>;
  pwUpdateOne?: ReturnType<typeof vi.fn>;
} = {}) {
  const pwById = opts.pwById ?? {};
  const tilesFindOneImpl = opts.tilesFindOne ?? (() => null);
  const tilesUpdateOne = opts.tilesUpdateOne ?? vi.fn(async () => ({ matchedCount: 1 }));
  const pwUpdateOne = opts.pwUpdateOne ?? vi.fn(async () => ({ matchedCount: 1 }));
  const pushTile = vi.fn(async () => {});
  const recomputeYield = vi.fn(async () => emptyResources());
  const applyNationChange = vi.fn(async () => true);
  const settle = vi.fn((doc: PlayerWorldDoc) => ({ ...doc.resources }));
  let tileCallCount = 0;

  const core = {
    deps: {
      now: () => 1_000,
      cols: {
        tiles: {
          findOne: async (query: unknown) => {
            tileCallCount++;
            return tilesFindOneImpl(tileCallCount, query);
          },
          updateOne: tilesUpdateOne,
        },
        playerWorld: {
          findOne: async ({ _id }: { _id: string }) => pwById[_id] ?? null,
          updateOne: pwUpdateOne,
        },
        marches: { insertOne: vi.fn(async () => ({})) },
      },
    },
    coordX: (tid: string) => Number(tid.split(':')[1]),
    coordY: (tid: string) => Number(tid.split(':')[2]),
    pushTile,
    recomputeYield,
    applyNationChange,
    settle,
    marchSeq: 0,
    pushMarch: vi.fn(async () => {}),
    marchView: (m: MarchDoc) => m as unknown as never,
  } as unknown as WorldCore;

  return { core, tilesUpdateOne, pwUpdateOne, pushTile, recomputeYield, applyNationChange };
}

function fakeHelpers() {
  return {
    transferLoot: vi.fn(async () => emptyResources()),
    applySectLeaderPenalty: vi.fn(async () => {}),
    passiveRelocate: vi.fn(async () => {}),
  } as unknown as SHS;
}

describe('SiegeDamageService.processDueSiegeDamage', () => {
  it('no due docs → returns 0, never calls findOneAndDelete', async () => {
    const { core } = makeCore();
    (core as unknown as { deps: { cols: { siegeDamage: unknown } } }).deps.cols.siegeDamage = {
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      findOneAndDelete: vi.fn(async () => null),
    };
    const svc = new SiegeDamageService(core, fakeHelpers());
    const n = await svc.processDueSiegeDamage(1_000);
    expect(n).toBe(0);
  });

  it('a claim lost to a concurrent processor (findOneAndDelete → null) is skipped, not counted', async () => {
    const { core } = makeCore({ tilesFindOne: () => null });
    const d1 = dmgDoc({ _id: 'd1' });
    const findOneAndDelete = vi.fn(async ({ _id }: { _id: string }) => (_id === 'd1' ? null : dmgDoc({ _id: 'd2' })));
    (core as unknown as { deps: { cols: { siegeDamage: unknown } } }).deps.cols.siegeDamage = {
      find: () => ({ limit: () => ({ toArray: async () => [d1, dmgDoc({ _id: 'd2' })] }) }),
      findOneAndDelete,
    };
    const svc = new SiegeDamageService(core, fakeHelpers());
    const n = await svc.processDueSiegeDamage(1_000);
    expect(n).toBe(1); // only d2 actually settled
    expect(findOneAndDelete).toHaveBeenCalledTimes(2);
  });

  it('nowMs omitted → falls back to core.deps.now()', async () => {
    const { core } = makeCore();
    (core as unknown as { deps: { cols: { siegeDamage: unknown } } }).deps.cols.siegeDamage = {
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
      findOneAndDelete: vi.fn(async () => null),
    };
    const svc = new SiegeDamageService(core, fakeHelpers());
    const n = await svc.processDueSiegeDamage(); // no nowMs argument
    expect(n).toBe(0);
  });

  it('settleSiegeDamage throwing is caught and logged, but the item is still counted', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { core } = makeCore();
    (core as unknown as { deps: { cols: { tiles: { findOne: unknown } } } }).deps.cols.tiles.findOne = async () => {
      throw new Error('boom');
    };
    const d1 = dmgDoc({ _id: 'd1' });
    (core as unknown as { deps: { cols: { siegeDamage: unknown } } }).deps.cols.siegeDamage = {
      find: () => ({ limit: () => ({ toArray: async () => [d1] }) }),
      findOneAndDelete: vi.fn(async () => d1),
    };
    const svc = new SiegeDamageService(core, fakeHelpers());
    const n = await svc.processDueSiegeDamage(1_000);
    expect(n).toBe(1);
    expect(errSpy).toHaveBeenCalledWith('[worldsvc] settleSiegeDamage failed:', expect.objectContaining({ id: 'd1' }));
    errSpy.mockRestore();
  });
});

/** Drives `settleSiegeDamage` (private) through the only public entry point. */
async function settle(
  core: WorldCore,
  helpers: SHS,
  doc: SiegeDamageDoc,
  t: number,
  siegeDamageFindOneAndDelete?: ReturnType<typeof vi.fn>,
) {
  const findOneAndDelete = siegeDamageFindOneAndDelete ?? vi.fn(async () => doc);
  (core as unknown as { deps: { cols: { siegeDamage: unknown } } }).deps.cols.siegeDamage = {
    find: () => ({ limit: () => ({ toArray: async () => [doc] }) }),
    findOneAndDelete,
  };
  const svc = new SiegeDamageService(core, helpers);
  await svc.processDueSiegeDamage(t);
}

describe('SiegeDamageService settleSiegeDamage — stale target (void damage)', () => {
  it('!tile (already gone) + attacker present with survivors → refund path runs, no capture write', async () => {
    const { core, tilesUpdateOne, pwUpdateOne } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK, mainBaseTile: undefined }) },
      tilesFindOne: () => null,
    });
    await settle(core, fakeHelpers(), dmgDoc({ attackerSurvivors: 5 }), 1_000);
    expect(tilesUpdateOne).not.toHaveBeenCalled();
    // startReturnMarch → no mainBaseTile → refundTroops → playerWorld.updateOne for the attacker.
    expect(pwUpdateOne).toHaveBeenCalledTimes(1);
    expect(pwUpdateOne.mock.calls[0]![0]).toMatchObject({ _id: `${W}:${ATK}` });
  });

  it('!tile + attacker missing → no refund call at all (nothing to return)', async () => {
    const { core, pwUpdateOne } = makeCore({ pwById: {}, tilesFindOne: () => null });
    await settle(core, fakeHelpers(), dmgDoc({ attackerSurvivors: 5 }), 1_000);
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('!tile + attacker present but 0 survivors → refund skipped (nothing to return)', async () => {
    const { core, pwUpdateOne } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK }) },
      tilesFindOne: () => null,
    });
    await settle(core, fakeHelpers(), dmgDoc({ attackerSurvivors: 0 }), 1_000);
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('missing defenderId on the doc → treated as stale even though the tile exists', async () => {
    const { core, tilesUpdateOne } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK }) },
      tilesFindOne: () => tile({ ownerId: DEF }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ defenderId: undefined, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).not.toHaveBeenCalled();
  });

  it('tile.ownerId !== defenderId (ownership already changed) → stale', async () => {
    const { core, tilesUpdateOne } = makeCore({
      pwById: {},
      tilesFindOne: () => tile({ ownerId: 'someone-else' }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).not.toHaveBeenCalled();
  });

  it('tile still under an active protection shield → stale', async () => {
    const { core, tilesUpdateOne } = makeCore({
      pwById: {},
      tilesFindOne: () => tile({ ownerId: DEF, protectedUntil: 5_000 }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).not.toHaveBeenCalled();
  });
});

describe('SiegeDamageService settleSiegeDamage — building survives (newHp > 0)', () => {
  it('non-base tile: deducts damage from tile.hp, writes {hp}, returns survivors, pushes to both sides', async () => {
    const maxHp = buildingMaxHp(3);
    let call = 0;
    const { core, tilesUpdateOne, pwUpdateOne, pushTile } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK }) },
      tilesFindOne: () => {
        call++;
        if (call === 1) return tile({ ownerId: DEF, level: 3, hp: maxHp });
        return tile({ ownerId: ATK, level: 3, hp: maxHp - 10 }); // "after" re-fetch
      },
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 10, attackerSurvivors: 7 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { hp: maxHp - 10 }, $inc: { rev: 1 } },
    );
    expect(pwUpdateOne).toHaveBeenCalledTimes(1); // return-march refund for the attacker
    expect(pushTile).toHaveBeenCalledTimes(2); // attacker + defender
  });

  it('non-base tile, attacker present but 0 survivors → no return-march refund call', async () => {
    const maxHp = buildingMaxHp(1);
    const { core, tilesUpdateOne, pwUpdateOne } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK }) },
      tilesFindOne: () => tile({ ownerId: DEF, hp: maxHp }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 1, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalled();
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('non-base tile with no persisted hp field yet → falls back to buildingMaxHp(level) before deducting', async () => {
    const maxHp = buildingMaxHp(5);
    const { core, tilesUpdateOne } = makeCore({
      pwById: {},
      tilesFindOne: () => tile({ ownerId: DEF, level: 5, hp: undefined }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 10, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { hp: maxHp - 10 }, $inc: { rev: 1 } },
    );
  });

  it('"after" re-fetch returns null → pushTile is never called (tile vanished mid-settlement)', async () => {
    let call = 0;
    const { core, pushTile } = makeCore({
      pwById: {},
      tilesFindOne: () => {
        call++;
        if (call === 1) return tile({ ownerId: DEF, hp: buildingMaxHp(1) });
        return null;
      },
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 1, attackerSurvivors: 0 }), 1_000);
    expect(pushTile).not.toHaveBeenCalled();
  });

  it('base tile (isBase): uses durability/durabilityMax (wall-derived) instead of hp, regenerates before deducting', async () => {
    const wallLevel = 2;
    const maxDur = baseDurabilityMax(wallLevel);
    const regenAt = 1_000 - 3_600_000; // 1 hour ago → regen kicks in before the hit lands
    const startDur = Math.max(0, maxDur - 50);
    const expectedRegened = regenDurability(startDur, maxDur, regenAt, 1_000);
    const expectedNewHp = expectedRegened - 5;
    const { core, tilesUpdateOne } = makeCore({
      pwById: {
        [`${W}:${DEF}`]: pw({ accountId: DEF, buildings: { wall: wallLevel } }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: startDur, durabilityRegenAt: regenAt }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ isBase: true, damage: 5, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { durability: expectedNewHp, durabilityMax: maxDur, durabilityRegenAt: 1_000 }, $inc: { rev: 1 } },
    );
  });
});

describe('SiegeDamageService settleSiegeDamage — isBase edge fallbacks', () => {
  it('isBase but the defender playerWorld doc is missing → wall level falls back to 0 (baseDurabilityMax(0))', async () => {
    const maxDur = baseDurabilityMax(0);
    const { core, tilesUpdateOne } = makeCore({
      pwById: {}, // no defender doc at all
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: maxDur }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ isBase: true, damage: 5, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { durability: maxDur - 5, durabilityMax: maxDur, durabilityRegenAt: 1_000 }, $inc: { rev: 1 } },
    );
  });

  it('isBase with no persisted durability field yet → falls back to full baseDurabilityMax before deducting', async () => {
    const wallLevel = 1;
    const maxDur = baseDurabilityMax(wallLevel);
    const { core, tilesUpdateOne } = makeCore({
      pwById: { [`${W}:${DEF}`]: pw({ accountId: DEF, buildings: { wall: wallLevel } }) },
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: undefined }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ isBase: true, damage: 5, attackerSurvivors: 0 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      { $set: { durability: maxDur - 5, durabilityMax: maxDur, durabilityRegenAt: 1_000 }, $inc: { rev: 1 } },
    );
  });
});

describe('SiegeDamageService settleSiegeDamage — HP depleted (capture)', () => {
  it('non-base, non-crossing (territory) hand-over: sets type=territory, ownerId, garrison, hp=maxHp, unsets protectedUntil; recomputes both yields + applyNationChange', async () => {
    const maxHp = buildingMaxHp(2);
    const { core, tilesUpdateOne, recomputeYield, applyNationChange } = makeCore({
      pwById: {
        [`${W}:${ATK}`]: pw({ accountId: ATK, familyId: 'fam-atk' }),
        [`${W}:${DEF}`]: pw({ accountId: DEF }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, level: 2, hp: 5, type: 'territory' }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 100, attackerSurvivors: 3 }), 1_000);
    expect(tilesUpdateOne).toHaveBeenCalledWith(
      { _id: TILE },
      {
        $set: { type: 'territory', ownerId: ATK, garrison: 3, hp: maxHp },
        $unset: { protectedUntil: '' },
        $inc: { rev: 1 },
      },
    );
    expect(recomputeYield).toHaveBeenCalledTimes(2);
    expect(applyNationChange).toHaveBeenCalledWith(W, 5, 5, ATK, 'fam-atk');
  });

  it('crossing (bridge) hand-over with an attacker familyId: KEEPS bridge type + sets familyId, no $unset.familyId', async () => {
    const { core, tilesUpdateOne } = makeCore({
      pwById: {
        [`${W}:${ATK}`]: pw({ accountId: ATK, familyId: 'fam-atk' }),
        [`${W}:${DEF}`]: pw({ accountId: DEF }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, level: 1, hp: 1, type: 'bridge' }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 100, attackerSurvivors: 1 }), 1_000);
    const [, updateArgs] = tilesUpdateOne.mock.calls[0]!;
    expect((updateArgs as { $set: { type: string; familyId?: string } }).$set.type).toBe('bridge');
    expect((updateArgs as { $set: { familyId?: string } }).$set.familyId).toBe('fam-atk');
    expect((updateArgs as { $unset: Record<string, string> }).$unset.familyId).toBeUndefined();
  });

  it('crossing (plankway) hand-over with NO attacker familyId: unsets familyId, does not set one', async () => {
    const { core, tilesUpdateOne } = makeCore({
      pwById: {
        [`${W}:${ATK}`]: pw({ accountId: ATK, familyId: undefined }),
        [`${W}:${DEF}`]: pw({ accountId: DEF }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, level: 1, hp: 1, type: 'plankway' }),
    });
    await settle(core, fakeHelpers(), dmgDoc({ damage: 100, attackerSurvivors: 1 }), 1_000);
    const [, updateArgs] = tilesUpdateOne.mock.calls[0]!;
    expect((updateArgs as { $set: { type: string; familyId?: string } }).$set.type).toBe('plankway');
    expect((updateArgs as { $set: { familyId?: string } }).$set.familyId).toBeUndefined();
    expect((updateArgs as { $unset: Record<string, string> }).$unset.familyId).toBe('');
  });

  it('loot transfers when both attacker and defender resolve; helpers.transferLoot is called with both docs', async () => {
    const helpers = fakeHelpers();
    const { core } = makeCore({
      pwById: {
        [`${W}:${ATK}`]: pw({ accountId: ATK }),
        [`${W}:${DEF}`]: pw({ accountId: DEF }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, hp: 1 }),
    });
    await settle(core, helpers, dmgDoc({ damage: 100, attackerSurvivors: 1 }), 1_000);
    expect(helpers.transferLoot).toHaveBeenCalledTimes(1);
  });

  it('no loot transfer when the defender doc cannot be resolved at all', async () => {
    const helpers = fakeHelpers();
    const { core } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ accountId: ATK }) }, // defender absent
      tilesFindOne: () => tile({ ownerId: DEF, hp: 1 }),
    });
    await settle(core, helpers, dmgDoc({ damage: 100, attackerSurvivors: 1 }), 1_000);
    expect(helpers.transferLoot).not.toHaveBeenCalled();
  });

  it('no loot transfer when the attacker doc cannot be resolved', async () => {
    const helpers = fakeHelpers();
    const { core } = makeCore({
      pwById: { [`${W}:${DEF}`]: pw({ accountId: DEF }) }, // attacker absent
      tilesFindOne: () => tile({ ownerId: DEF, hp: 1 }),
    });
    await settle(core, helpers, dmgDoc({ damage: 100, attackerSurvivors: 1 }), 1_000);
    expect(helpers.transferLoot).not.toHaveBeenCalled();
  });

  it('main base capture (isBase): calls applySectLeaderPenalty + passiveRelocate, and returns survivors home when > 0', async () => {
    const helpers = fakeHelpers();
    const wallLevel = 0;
    const { core, pwUpdateOne } = makeCore({
      pwById: {
        [`${W}:${ATK}`]: pw({ accountId: ATK, mainBaseTile: undefined }),
        [`${W}:${DEF}`]: pw({ accountId: DEF, buildings: { wall: wallLevel } }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: 1 }),
    });
    await settle(core, helpers, dmgDoc({ isBase: true, damage: 100, attackerSurvivors: 4 }), 1_000);
    expect(helpers.applySectLeaderPenalty).toHaveBeenCalledWith(W, DEF, 1_000);
    expect(helpers.passiveRelocate).toHaveBeenCalledWith(W, DEF, 1_000);
    expect(pwUpdateOne).toHaveBeenCalledTimes(1); // return-march refund for the attacker's 4 survivors
  });

  it('main base capture with 0 attacker survivors → no return-march refund, penalty/relocate still run', async () => {
    const helpers = fakeHelpers();
    const { core, pwUpdateOne } = makeCore({
      pwById: {
        [`${W}:${DEF}`]: pw({ accountId: DEF }),
      },
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: 1 }),
    });
    await settle(core, helpers, dmgDoc({ isBase: true, damage: 100, attackerSurvivors: 0 }), 1_000);
    expect(helpers.applySectLeaderPenalty).toHaveBeenCalledTimes(1);
    expect(helpers.passiveRelocate).toHaveBeenCalledTimes(1);
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('main base capture with attacker missing entirely (no refund attempted, no loot) — relocate still runs', async () => {
    const helpers = fakeHelpers();
    const { core } = makeCore({
      pwById: { [`${W}:${DEF}`]: pw({ accountId: DEF }) },
      tilesFindOne: () => tile({ ownerId: DEF, type: 'base', durability: 1 }),
    });
    await settle(core, helpers, dmgDoc({ isBase: true, damage: 100, attackerSurvivors: 9 }), 1_000);
    expect(helpers.transferLoot).not.toHaveBeenCalled();
    expect(helpers.passiveRelocate).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SiegeHelpersService (helpers.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SiegeHelpersService.buildDefenderConfig', () => {
  const core = {} as unknown as WorldCore;
  const svc = new SiegeHelpersService(core);

  it('a non-empty custom garrison + inOwnNation=true → scales each unit HP by (1+NATION_BONUS_DEFENSE)', () => {
    const target = tile({ level: 4, defense: { garrison: [{ unitType: 0, col: 0, row: 0, initialHp: 100 }] } });
    const result = svc.buildDefenderConfig(target, 0, true);
    expect(result).not.toBeNull();
    const garrison = (result as { garrison: { initialHp: number }[] }).garrison;
    expect(garrison[0]!.initialHp).toBeGreaterThan(100); // nation bonus actually scaled it up
    expect((result as { defenderBaseHp: number }).defenderBaseHp).toBe(npcBaseHp(4));
  });

  it('a non-empty custom garrison + inOwnNation=false → used verbatim (no scaling)', () => {
    const customGarrison = [{ unitType: 0, col: 0, row: 0, initialHp: 100 }];
    const target = tile({ level: 1, defense: { garrison: customGarrison } });
    const result = svc.buildDefenderConfig(target, 0, false);
    expect((result as { garrison: unknown }).garrison).toEqual(customGarrison);
  });

  it('custom.garrison present but empty array → falls through to synthesis (not treated as "custom")', () => {
    const target = tile({ level: 1, defense: { garrison: [] } });
    const result = svc.buildDefenderConfig(target, 50, false);
    expect(result).not.toBeNull();
    expect((result as { defenderBaseHp: number }).defenderBaseHp).toBe(npcBaseHp(1));
  });

  it('no custom defense + effGarrison > 0 → synthesizes a default formation', () => {
    const target = tile({ level: 2 });
    const result = svc.buildDefenderConfig(target, 30, false);
    expect(result).not.toBeNull();
    expect((result as { garrison: unknown[] }).garrison.length).toBeGreaterThan(0);
  });

  it('no custom defense + effGarrison <= 0 → null (nothing to defend with)', () => {
    const target = tile({ level: 2 });
    expect(svc.buildDefenderConfig(target, 0, false)).toBeNull();
  });

  it('target.level absent → defenderBaseHp falls back to npcBaseHp(1)', () => {
    const target = tile({ level: undefined });
    const result = svc.buildDefenderConfig(target, 10, false);
    expect((result as { defenderBaseHp: number }).defenderBaseHp).toBe(npcBaseHp(1));
  });
});

describe('SiegeHelpersService.recordSiege', () => {
  function makeSvc() {
    const insertOne = vi.fn(async () => ({}));
    const core = {
      deps: { cols: { sieges: { insertOne } } },
      siegeSeq: 0,
    } as unknown as WorldCore;
    return { svc: new SiegeHelpersService(core), insertOne };
  }
  const march = (): MarchDoc => ({
    _id: 'm1', worldId: W, ownerId: ATK, fromTile: `${W}:0:0`, toTile: TILE,
    kind: 'attack', troops: 100, departAt: 0, arriveAt: 0, path: [], stepIndex: 0, nextStepAt: 0,
    status: 'marching', rev: 0,
  } as unknown as MarchDoc);

  it('defenderId present → spread into the doc; replay null → no seed/army fields at all', async () => {
    const { svc, insertOne } = makeSvc();
    const doc = await svc.recordSiege(march(), DEF, 'attacker_win', 1_000, null);
    expect(doc.defenderId).toBe(DEF);
    expect(doc.seed).toBeUndefined();
    expect(insertOne).toHaveBeenCalledTimes(1);
  });

  it('defenderId undefined (PvE, no owner) → field omitted entirely (not just undefined)', async () => {
    const { svc } = makeSvc();
    const doc = await svc.recordSiege(march(), undefined, 'attacker_win', 1_000, null);
    expect('defenderId' in doc).toBe(false);
  });

  it('replay present with cardInstances/equipmentInv/siegeAcademy all set → every optional field lands on the doc', async () => {
    const { svc } = makeSvc();
    const doc = await svc.recordSiege(march(), DEF, 'attacker_win', 1_000, {
      seed: 42,
      attackerArmy: [],
      defenderConfig: null,
      tileLevel: 1,
      cardInstances: [{ id: 'c1' } as never],
      equipmentInv: { slot: 'x' } as never,
      siegeAcademy: { hp: 1, damage: 1, siege: 1 },
    });
    expect(doc.seed).toBe(42);
    expect(doc.cardInstances).toBeDefined();
    expect(doc.equipmentInv).toBeDefined();
    expect(doc.siegeAcademy).toEqual({ hp: 1, damage: 1, siege: 1 });
  });

  it('replay present but cardInstances/equipmentInv/siegeAcademy all absent → none of those optional fields appear', async () => {
    const { svc } = makeSvc();
    const doc = await svc.recordSiege(march(), DEF, 'attacker_win', 1_000, {
      seed: 1, attackerArmy: [], defenderConfig: null, tileLevel: 1,
    });
    expect('cardInstances' in doc).toBe(false);
    expect('equipmentInv' in doc).toBe(false);
    expect('siegeAcademy' in doc).toBe(false);
  });
});

describe('SiegeHelpersService.transferLoot', () => {
  function makeSvc(opts: {
    defenderUpdateResults?: Array<{ matchedCount: number }>;
    attackerUpdateResults?: Array<{ matchedCount: number }>;
    defenderRefetch?: PlayerWorldDoc | null;
    attackerRefetch?: PlayerWorldDoc | null;
  } = {}) {
    let defCall = 0;
    let atkCall = 0;
    const defResults = opts.defenderUpdateResults ?? [{ matchedCount: 1 }];
    const atkResults = opts.attackerUpdateResults ?? [{ matchedCount: 1 }];
    const defenderUpdateOne = vi.fn(async () => defResults[Math.min(defCall++, defResults.length - 1)]!);
    const attackerFindOne = vi.fn(async () => opts.attackerRefetch ?? null);
    const defenderFindOne = vi.fn(async () => opts.defenderRefetch ?? null);
    const updateOne = vi.fn(async (query: { _id: string }) => {
      // Distinguish attacker vs defender writes by which doc's rev matches (both share one mock,
      // mirroring how `cols.playerWorld` is a single collection for both docs).
      if (query._id === `${W}:${DEF}`) return defenderUpdateOne();
      atkCall++;
      return atkResults[Math.min(atkCall - 1, atkResults.length - 1)]!;
    });
    const findOne = vi.fn(async (query: { _id: string }) =>
      (query._id === `${W}:${DEF}` ? defenderFindOne() : attackerFindOne()));
    const core = {
      deps: { cols: { playerWorld: { updateOne, findOne } } },
      settle: (doc: PlayerWorldDoc) => ({ ...doc.resources }),
    } as unknown as WorldCore;
    return { svc: new SiegeHelpersService(core), updateOne, findOne };
  }

  const richResources = () => {
    const r = emptyResources();
    r.ink = 1000;
    return r;
  };

  it('happy path: loot = floor(defender resources * SIEGE_LOOT_RATE), moved from defender to attacker', async () => {
    const { svc } = makeSvc();
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    expect(loot.ink).toBe(Math.floor(1000 * SIEGE_LOOT_RATE));
    expect(loot.ink).toBeGreaterThan(0);
  });

  it('cabinet loot protection reduces the effective loot rate', async () => {
    const { svc } = makeSvc();
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources(), buildings: { cabinet: 4 } });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    const protection = cabinetLootProtect({ cabinet: 4 });
    expect(protection).toBeGreaterThan(0);
    expect(loot.ink).toBe(Math.floor(1000 * SIEGE_LOOT_RATE * (1 - protection)));
  });

  it('defender write rev-conflicts once then succeeds on retry (refetches a fresh doc in between)', async () => {
    const refreshedDefender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources(), rev: 1 });
    const { svc, findOne } = makeSvc({
      defenderUpdateResults: [{ matchedCount: 0 }, { matchedCount: 1 }],
      defenderRefetch: refreshedDefender,
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources(), rev: 0 });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    expect(loot.ink).toBeGreaterThan(0);
    expect(findOne).toHaveBeenCalled();
  });

  it('defender write exhausts every retry attempt → gives up, returns emptyResources, logs an error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refreshedDefender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const { svc } = makeSvc({
      defenderUpdateResults: [{ matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }],
      defenderRefetch: refreshedDefender,
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    expect(loot).toEqual(emptyResources());
    expect(errSpy).toHaveBeenCalledWith(
      '[worldsvc] transferLoot: giving up on defender debit after rev-conflict retries',
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it('defender refetch comes back null mid-retry → bail out early, still emptyResources', async () => {
    const { svc } = makeSvc({
      defenderUpdateResults: [{ matchedCount: 0 }],
      defenderRefetch: null,
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    expect(loot).toEqual(emptyResources());
  });

  it('attacker credit rev-conflicts once then succeeds — attacker.resources is synced in-memory afterward', async () => {
    const refreshedAttacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources(), rev: 1 });
    const { svc } = makeSvc({
      attackerUpdateResults: [{ matchedCount: 0 }, { matchedCount: 1 }],
      attackerRefetch: refreshedAttacker,
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    await svc.transferLoot(defender, attacker, 1_000);
    expect(attacker.lastTickAt).toBe(1_000); // mutated in place on the eventual success
  });

  it('attacker credit exhausts every retry → logs a distinct error but still returns the (already-debited) loot', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc } = makeSvc({
      attackerUpdateResults: [{ matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }, { matchedCount: 0 }],
      attackerRefetch: pw({ accountId: ATK, _id: `${W}:${ATK}` }),
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    const loot = await svc.transferLoot(defender, attacker, 1_000);
    expect(loot.ink).toBeGreaterThan(0); // defender was already debited — loot is real, just not credited
    expect(errSpy).toHaveBeenCalledWith(
      '[worldsvc] transferLoot: giving up on attacker credit after rev-conflict retries',
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it('attacker refetch comes back null mid-retry → bail out of the attacker loop early', async () => {
    const { svc } = makeSvc({
      attackerUpdateResults: [{ matchedCount: 0 }],
      attackerRefetch: null,
    });
    const defender = pw({ accountId: DEF, _id: `${W}:${DEF}`, resources: richResources() });
    const attacker = pw({ accountId: ATK, _id: `${W}:${ATK}`, resources: emptyResources() });
    await expect(svc.transferLoot(defender, attacker, 1_000)).resolves.toBeDefined();
  });
});

describe('SiegeHelpersService.applySectLeaderPenalty', () => {
  function makeSvc(opts: {
    defPw?: PlayerWorldDoc | null;
    sect?: { _id: string; leaderId: string } | null;
    families?: { familyId: string }[];
    members?: PlayerWorldDoc[];
  }) {
    const updateOne = vi.fn(async () => ({}));
    const getFamiliesBySect = vi.fn(async () => opts.families ?? []);
    const core = {
      deps: {
        cols: {
          playerWorld: {
            findOne: async () => opts.defPw ?? null,
            find: () => ({ toArray: async () => opts.members ?? [] }),
            updateOne,
          },
          sects: { findOne: async () => opts.sect ?? null },
        },
      },
      socialsvc: { getFamiliesBySect },
      settle: (doc: PlayerWorldDoc) => ({ ...doc.resources }),
    } as unknown as WorldCore;
    return { svc: new SiegeHelpersService(core), updateOne, getFamiliesBySect };
  }

  it('defender playerWorld doc not found → no-op', async () => {
    const { svc, updateOne } = makeSvc({ defPw: null });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('defender has no familyId → no-op', async () => {
    const { svc, updateOne } = makeSvc({ defPw: pw({ accountId: DEF, familyId: undefined }) });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('defender has a familyId but no sectId mirror → no-op (no extra sect lookup needed)', async () => {
    const { svc, updateOne } = makeSvc({ defPw: pw({ accountId: DEF, familyId: 'f1', sectId: undefined }) });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('sect doc not found → no-op', async () => {
    const { svc, updateOne } = makeSvc({
      defPw: pw({ accountId: DEF, familyId: 'f1', sectId: 'sect-1' }),
      sect: null,
    });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('defender is not the sect leader → no-op', async () => {
    const { svc, updateOne } = makeSvc({
      defPw: pw({ accountId: DEF, familyId: 'f1', sectId: 'sect-1' }),
      sect: { _id: 'sect-1', leaderId: 'someone-else' },
    });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('sect leader destroyed but the sect has no member families → no-op', async () => {
    const { svc, updateOne, getFamiliesBySect } = makeSvc({
      defPw: pw({ accountId: DEF, familyId: 'f1', sectId: 'sect-1' }),
      sect: { _id: 'sect-1', leaderId: DEF },
      families: [],
    });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(getFamiliesBySect).toHaveBeenCalledWith('sect-1');
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('sect leader destroyed, real members present → every member is docked SECT_LEADER_PENALTY_RATE', async () => {
    const m1 = pw({ accountId: 'm1', _id: `${W}:m1`, resources: { ...emptyResources(), ink: 100 } });
    const { svc, updateOne } = makeSvc({
      defPw: pw({ accountId: DEF, familyId: 'f1', sectId: 'sect-1' }),
      sect: { _id: 'sect-1', leaderId: DEF },
      families: [{ familyId: 'f1' }],
      members: [m1],
    });
    await svc.applySectLeaderPenalty(W, DEF, 1_000);
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [, args] = updateOne.mock.calls[0]!;
    expect((args as { $set: { resources: Record<string, number> } }).$set.resources.ink).toBe(50); // keep 1-0.5
  });
});

describe('SiegeHelpersService.passiveRelocate', () => {
  function makeSvc(opts: {
    playerDoc?: PlayerWorldDoc | null;
    towerTiles?: TileDoc[];
    spot?: { x: number; y: number; level: number; resType?: string } | null;
    afterTile?: TileDoc | null;
  }) {
    const removeCover = vi.fn(async () => {});
    const deleteMany = vi.fn(async () => ({}));
    const tilesUpdateOne = vi.fn(async () => ({}));
    const pwUpdateOne = vi.fn(async () => ({}));
    const pushTile = vi.fn(async () => {});
    const pushTileToObservers = vi.fn(async () => {});
    const sendSystemMail = vi.fn();
    let tilesFindOneCall = 0;
    const baseTileDocs = vi.fn(() => [{ _id: 'newtile1' } as unknown as TileDoc]);
    const core = {
      deps: {
        cols: {
          playerWorld: { findOne: async () => opts.playerDoc ?? null, updateOne: pwUpdateOne },
          tiles: {
            find: () => ({ toArray: async () => opts.towerTiles ?? [] }),
            deleteMany,
            updateOne: tilesUpdateOne,
            findOne: async () => {
              tilesFindOneCall++;
              return opts.afterTile ?? null;
            },
          },
        },
      },
      removeCover,
      pickRandomEmptyTile: vi.fn(async () => opts.spot ?? null),
      baseTileDocs,
      recomputeYield: vi.fn(async () => emptyResources()),
      pushTile,
      pushTileToObservers,
      mail: { sendSystemMail },
    } as unknown as WorldCore;
    return { svc: new SiegeHelpersService(core), removeCover, deleteMany, tilesUpdateOne, pwUpdateOne, pushTile, pushTileToObservers, sendSystemMail, baseTileDocs };
  }

  it('playerWorld doc not found → no-op entirely', async () => {
    const { svc, deleteMany } = makeSvc({ playerDoc: null });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('sweeps arrow-tower coverage for every registered tower tile before wiping territory', async () => {
    const towers = [tile({ _id: `${W}:1:1`, x: 1, y: 1, structure: { kind: 'arrowTower' } as never })];
    const { svc, removeCover, deleteMany } = makeSvc({ playerDoc: pw({ accountId: DEF }), towerTiles: towers, spot: null });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(removeCover).toHaveBeenCalledTimes(1);
    expect(removeCover).toHaveBeenCalledWith(W, 1, 1, `${W}:1:1`);
    expect(deleteMany).toHaveBeenCalledWith({ worldId: W, ownerId: DEF });
  });

  it('no tower tiles → removeCover never called', async () => {
    const { svc, removeCover } = makeSvc({ playerDoc: pw({ accountId: DEF }), towerTiles: [], spot: null });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(removeCover).not.toHaveBeenCalled();
  });

  it('no legal empty tile found (spot=null) → unsets mainBaseTile + sends the breach mail, skips baseTileDocs', async () => {
    const { svc, pwUpdateOne, sendSystemMail } = makeSvc({ playerDoc: pw({ accountId: DEF }), spot: null });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(pwUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: `${W}:${DEF}` }),
      expect.objectContaining({ $unset: { mainBaseTile: '' } }),
    );
    expect(sendSystemMail).toHaveBeenCalledTimes(1);
  });

  it('a legal spot is found → writes the new base footprint, mainBaseTile, pushes tile + observers, sends mail', async () => {
    const spot = { x: 9, y: 9, level: 1 };
    const after = tile({ _id: `${W}:9:9`, x: 9, y: 9, ownerId: DEF });
    const { svc, tilesUpdateOne, pwUpdateOne, pushTile, pushTileToObservers, sendSystemMail } = makeSvc({
      playerDoc: pw({ accountId: DEF, familyId: 'f1' }),
      spot,
      afterTile: after,
    });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(tilesUpdateOne).toHaveBeenCalled();
    expect(pwUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: `${W}:${DEF}` }),
      expect.objectContaining({ $set: expect.objectContaining({ mainBaseTile: `${W}:9:9` }) }),
    );
    expect(pushTile).toHaveBeenCalledTimes(1);
    expect(pushTileToObservers).toHaveBeenCalledTimes(1);
    expect(sendSystemMail).toHaveBeenCalledTimes(1);
  });

  it('a legal spot carries a resType → the new base footprint request includes it', async () => {
    const spot = { x: 4, y: 4, level: 1, resType: 'ink' };
    const { svc, baseTileDocs } = makeSvc({
      playerDoc: pw({ accountId: DEF, familyId: 'f1' }),
      spot,
      afterTile: tile({ _id: `${W}:4:4` }),
    });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(baseTileDocs).toHaveBeenCalledWith(
      W, 4, 4, DEF,
      expect.objectContaining({ resType: 'ink', familyId: 'f1' }),
    );
  });

  it('a legal spot is found but the post-write re-fetch comes back null → skips push/observer calls', async () => {
    const { svc, pushTile, pushTileToObservers } = makeSvc({
      playerDoc: pw({ accountId: DEF }),
      spot: { x: 3, y: 3, level: 1 },
      afterTile: null,
    });
    await svc.passiveRelocate(W, DEF, 1_000);
    expect(pushTile).not.toHaveBeenCalled();
    expect(pushTileToObservers).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
