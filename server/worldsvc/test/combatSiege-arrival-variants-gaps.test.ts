// Unit tests (fake WorldCore + fake SiegeCtx, no Mongo — same style as combatSiege-ctx-wiring.test.ts
// / occupation-battle.test.ts) targeting the branch-coverage gaps in the five siege-arrival variant
// modules: combatSiege/arrival/{crossingSiege,strongholdSiege,sweep,landSiege,baseSiege}.ts.
// Each free function only takes `core: WorldCore` + `ctx: SiegeCtx` (a handful of bound methods,
// see ctx.ts) plus its own args — every dependency is stubbed directly. Outcomes are steered
// deterministically through the CHEAP linear formula (resolveSiege) by exploiting
// shouldUseCheapSiege's board-overflow guard (garrison/army sizes chosen above
// SIEGE_SYNTH_ARMY_MAX_TROOPS, or an overwhelming ratio) — same technique as
// siege-cheap-fallback.test.ts / occupation-battle.test.ts — so the real headless engine never runs.
// NOTE on resolveSiege's cheap formula: the LOSING side's survivors are always 0 (see
// src/siegeEngine.ts / @nw/shared resolveSiege) — real non-zero survivors-on-defeat only ever come
// out of the actual headless engine. Tests below that need a "loser still sends something home"
// branch therefore use a CARD army (whose `hasCardArmy || survivors>0` gate is satisfied by
// hasCardArmy alone) rather than trying to fabricate flat survivors on a loss.
import { describe, expect, it, vi } from 'vitest';
import {
  proceduralTile,
  passageGarrison,
  strongholdGarrison,
  npcGarrison,
  MARCH_MORALE_MAX,
  STRONGHOLD_LOOT_PER_LEVEL,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  type ProceduralTile,
  type SiegeResolution,
} from '@nw/shared';
import { applyCrossingSiege } from '../src/combatSiege/arrival/crossingSiege';
import { applyStrongholdSiege } from '../src/combatSiege/arrival/strongholdSiege';
import { applySweep } from '../src/combatSiege/arrival/sweep';
import { landSiege } from '../src/combatSiege/arrival/landSiege';
import { applyBaseSiege } from '../src/combatSiege/arrival/baseSiege';
import { emptyResources } from '../src/core';
import type { WorldCore } from '../src/core';
import type { SiegeCtx } from '../src/combatSiege/ctx';
import type { MarchDoc, PlayerWorldDoc, TileDoc } from '../src/db';

const W = 's1';
const ATK = 'atk-1';
const DEF = 'def-1';
const TILE = `${W}:5:5`;
const CARD_DEF_ID = 'lichuang'; // a real @nw/shared CARD_DEFS entry (unitType: infantry)

function cardInv(id: string) {
  return { [id]: { id, defId: CARD_DEF_ID, level: 1, gear: {}, locked: false } };
}
function saveFieldsWithCard(id: string) {
  return { cardInv: cardInv(id), equipmentInv: {} };
}

function march(overrides: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: ATK, fromTile: `${W}:0:0`, toTile: TILE,
    kind: 'attack', troops: 100, morale: MARCH_MORALE_MAX, departAt: 0, arriveAt: 0,
    path: [], stepIndex: 0, nextStepAt: 0, status: 'marching', rev: 0,
    ...overrides,
  } as unknown as MarchDoc;
}

function pw(overrides: Partial<PlayerWorldDoc> = {}): PlayerWorldDoc {
  return {
    _id: `${W}:${overrides.accountId ?? ATK}`, worldId: W, accountId: ATK,
    troops: 0, troopCap: 999_999, resources: emptyResources(), yieldRate: emptyResources(),
    lastTickAt: 0, rev: 0,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return {
    _id: TILE, worldId: W, x: 5, y: 5, type: 'territory', level: 1, garrison: 0, rev: 0,
    ...overrides,
  } as unknown as TileDoc;
}

function fakeCtx(): SiegeCtx & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recordSiege: vi.fn(async (..._args: unknown[]) => ({ _id: 'siege-1' })),
    transferLoot: vi.fn(async (..._args: unknown[]) => emptyResources()),
    applySectLeaderPenalty: vi.fn(async (..._args: unknown[]) => {}),
    passiveRelocate: vi.fn(async (..._args: unknown[]) => {}),
    writeContestedHold: vi.fn(async (..._args: unknown[]) => {}),
    startOccupationHold: vi.fn(async (..._args: unknown[]) => {}),
  } as unknown as SiegeCtx & Record<string, ReturnType<typeof vi.fn>>;
}

/** Generic fake WorldCore covering every method the five arrival variants touch. Each collection
 * defaults to a permissive no-op so a test only needs to override what it actually exercises.
 * `tilesFindOne` is called by call-index (1-based) since some flows (stronghold capture) call
 * `cols.tiles.findOne` twice — once to re-validate on arrival, once again afterward to push the
 * captured tile to observers — and the two calls must see different tile states. */
function makeCore(opts: {
  tilesFindOne?: (call: number) => TileDoc | null;
  pwById?: Record<string, PlayerWorldDoc | null>;
  pwUpdateOne?: ReturnType<typeof vi.fn>;
  tilesUpdateOne?: ReturnType<typeof vi.fn>;
  getSaveFields?: ReturnType<typeof vi.fn>;
  grantMaterial?: ReturnType<typeof vi.fn>;
} = {}) {
  const pwById = opts.pwById ?? {};
  const pwUpdateOne = opts.pwUpdateOne ?? vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1 }));
  const tilesUpdateOne = opts.tilesUpdateOne ?? vi.fn(async (..._args: unknown[]) => ({}));
  const pushMarch = vi.fn(async (..._args: unknown[]) => {});
  const pushSiege = vi.fn(async (..._args: unknown[]) => {});
  const pushTile = vi.fn(async (..._args: unknown[]) => {});
  const pushTileToObservers = vi.fn(async (..._args: unknown[]) => {});
  const bumpFamilyActivity = vi.fn(async (..._args: unknown[]) => {});
  const setOccupancy = vi.fn(async (..._args: unknown[]) => {});
  const stationedUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
  const getSaveFields = opts.getSaveFields ?? vi.fn(async (..._args: unknown[]) => null);
  const grantMaterial = opts.grantMaterial ?? vi.fn(async (..._args: unknown[]) => {});
  let tilesFindOneCall = 0;

  const core = {
    deps: {
      cols: {
        tiles: {
          findOne: async () => {
            tilesFindOneCall++;
            return opts.tilesFindOne ? opts.tilesFindOne(tilesFindOneCall) : null;
          },
          updateOne: tilesUpdateOne,
        },
        playerWorld: {
          findOne: async ({ _id }: { _id: string }) => pwById[_id] ?? null,
          updateOne: pwUpdateOne,
        },
        stationed: { updateOne: stationedUpdateOne },
        marches: { insertOne: vi.fn(async (..._args: unknown[]) => ({})) },
      },
    },
    coordX: (tid: string) => Number(tid.split(':')[1]),
    coordY: (tid: string) => Number(tid.split(':')[2]),
    settle: (doc: PlayerWorldDoc) => ({ ...doc.resources }),
    marchSeq: 0,
    marchView: (m: MarchDoc) => m as unknown as never,
    pushMarch,
    pushSiege,
    pushTile,
    pushTileToObservers,
    bumpFamilyActivity,
    setOccupancy,
    removeCover: vi.fn(async (..._args: unknown[]) => {}),
    recomputeYield: vi.fn(async (..._args: unknown[]) => emptyResources()),
    meta: { getSaveFields, grantMaterial },
  } as unknown as WorldCore;

  return { core, pwUpdateOne, tilesUpdateOne, pushMarch, pushSiege, pushTile, pushTileToObservers, bumpFamilyActivity, setOccupancy, stationedUpdateOne, getSaveFields, grantMaterial };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// crossingSiege.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyCrossingSiege', () => {
  const proc: ProceduralTile = { type: 'bridge', level: 1 };

  it('already captured on arrival (occ.ownerId set) + team-dispatched → parks in place, no refund', async () => {
    const { core, pwUpdateOne, pushMarch, setOccupancy, stationedUpdateOne } = makeCore({
      tilesFindOne: () => tile({ ownerId: 'someone-else' }),
    });
    const ctx = fakeCtx();
    await applyCrossingSiege(core, ctx, march({ teamId: 't1' }), pw(), 1_000, proc);
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect(stationedUpdateOne).toHaveBeenCalledTimes(1);
    expect(setOccupancy).toHaveBeenCalledTimes(1);
    expect(pushMarch).toHaveBeenCalledTimes(1);
  });

  it('already captured, no team, no card army → refunds troops instead of parking', async () => {
    const { core, pwUpdateOne, pushMarch } = makeCore({
      tilesFindOne: () => tile({ ownerId: 'someone-else' }),
      pwById: { [`${W}:${ATK}`]: pw() },
    });
    const ctx = fakeCtx();
    await applyCrossingSiege(core, ctx, march(), pw(), 1_000, proc);
    expect(pwUpdateOne).toHaveBeenCalledTimes(1); // refundTroops write
    expect(pushMarch).toHaveBeenCalledTimes(1);
  });

  it('already captured, no team, HAS a card army → skips the flat-troop refund (nothing was deducted)', async () => {
    const { core, pwUpdateOne, pushMarch } = makeCore({ tilesFindOne: () => tile({ ownerId: 'someone-else' }) });
    const ctx = fakeCtx();
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    await applyCrossingSiege(core, ctx, m, pw(), 1_000, proc);
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect(pushMarch).toHaveBeenCalledTimes(1);
  });

  it('not yet captured, attacker overwhelms the NPC garrison → startOccupationHold with survivors, no defenderId', async () => {
    const garrisonLevel = 9; // passageGarrison(9) = 1150*9 = 10350, over board capacity → forces the cheap path
    const troops = passageGarrison(garrisonLevel) + 500; // still > garrison → attacker_win
    const { core } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    await applyCrossingSiege(core, ctx, march({ troops }), pw(), 1_000, { type: 'bridge', level: garrisonLevel });
    expect(ctx.startOccupationHold).toHaveBeenCalledTimes(1);
    const args = (ctx.startOccupationHold as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args[3]).toBe(5); // x
    expect(args[4]).toBe(5); // y
    expect(args[5]).toBe(troops - passageGarrison(garrisonLevel)); // survivors
  });

  it('a card army wins → writeOccupyCardState runs before startOccupationHold (persists cardState)', async () => {
    const garrisonLevel = 9;
    const troops = passageGarrison(garrisonLevel) + 500;
    const getSaveFields = vi.fn(async (..._args: unknown[]) => saveFieldsWithCard('c1'));
    const { core, pwUpdateOne } = makeCore({ tilesFindOne: () => null, getSaveFields });
    const ctx = fakeCtx();
    const m = march({ troops, army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    const p = pw({ cardState: { c1: { currentTroops: troops } } as never });
    await applyCrossingSiege(core, ctx, m, p, 1_000, { type: 'bridge', level: garrisonLevel });
    expect(pwUpdateOne).toHaveBeenCalledTimes(1); // writeOccupyCardState's cardState write
    expect(ctx.startOccupationHold).toHaveBeenCalledTimes(1);
  });

  it('a card army loses to the garrison → still retreats home (hasCardArmy alone satisfies the return-leg gate)', async () => {
    const garrisonLevel = 9; // garrison overwhelms this weak 1-troop card
    const getSaveFields = vi.fn(async (..._args: unknown[]) => saveFieldsWithCard('c1'));
    const { core, pwUpdateOne } = makeCore({
      tilesFindOne: () => null,
      getSaveFields,
      pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) },
    });
    const ctx = fakeCtx();
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    const p = pw({ cardState: { c1: { currentTroops: 1 } } as never });
    await applyCrossingSiege(core, ctx, m, p, 1_000, { type: 'bridge', level: garrisonLevel });
    expect(ctx.recordSiege).toHaveBeenCalledWith(expect.anything(), undefined, 'defender_win', 1_000, expect.anything());
    // writeOccupyCardState's cardState write + startReturnMarch's refund-fallback write (no mainBaseTile).
    expect(pwUpdateOne.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('attacker fully wiped (no card army, 0 survivors) → no return leg is spawned at all', async () => {
    const garrisonLevel = 9;
    const { core, pwUpdateOne } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    // troops=0 vs any positive garrison → resolveSiege → defender_win, attackerSurvivors always 0.
    await applyCrossingSiege(core, ctx, march({ troops: 0 }), pw(), 1_000, { type: 'bridge', level: garrisonLevel });
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect(ctx.recordSiege).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// strongholdSiege.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyStrongholdSiege', () => {
  it('already captured on arrival + team-dispatched → parks in place', async () => {
    const { core, stationedUpdateOne } = makeCore({ tilesFindOne: () => tile({ ownerId: 'someone-else' }) });
    const ctx = fakeCtx();
    await applyStrongholdSiege(core, ctx, march({ teamId: 't1' }), pw(), 1_000, { type: 'stronghold', level: 1 });
    expect(stationedUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('already captured on arrival, no team, HAS a card army → skips the flat-troop refund entirely', async () => {
    const { core, pwUpdateOne, pushMarch } = makeCore({ tilesFindOne: () => tile({ ownerId: 'someone-else' }) });
    const ctx = fakeCtx();
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    await applyStrongholdSiege(core, ctx, m, pw(), 1_000, { type: 'stronghold', level: 1 });
    expect(pwUpdateOne).not.toHaveBeenCalled();
    expect(pushMarch).toHaveBeenCalledTimes(1);
  });

  it('victory: writeContestedHold + one-time resource reward capped at RESOURCE_CAP + material drop + push', async () => {
    const level = 9; // strongholdGarrison(9)=1180*9=10620, forces cheap path
    const garrison = strongholdGarrison(level);
    const troops = garrison + 1000;
    const { core, pwUpdateOne, grantMaterial, pushTile, pushTileToObservers } = makeCore({
      // call 1 = the arrival re-validate (must be unowned!); call 2 = the post-capture "after" re-fetch.
      tilesFindOne: (call) => (call === 1 ? null : tile({ ownerId: ATK })),
      pwById: { [`${W}:${ATK}`]: pw({ resources: emptyResources(), rev: 0 }) },
    });
    const ctx = fakeCtx();
    await applyStrongholdSiege(core, ctx, march({ troops }), pw(), 1_000, { type: 'stronghold', level, resType: 'ink' });
    expect(ctx.writeContestedHold).toHaveBeenCalledTimes(1);
    expect(pwUpdateOne).toHaveBeenCalledTimes(1);
    const [, updateArgs] = pwUpdateOne.mock.calls[0]!;
    const reward = (updateArgs as { $set: { resources: Record<string, number> } }).$set.resources;
    expect(reward.ink).toBe(Math.min(RESOURCE_CAP, STRONGHOLD_LOOT_PER_LEVEL * level));
    expect(grantMaterial).toHaveBeenCalledTimes(1);
    expect(pushTile).toHaveBeenCalledTimes(1);
    expect(pushTileToObservers).toHaveBeenCalledTimes(1);
  });

  it('victory reward defaults to "ink" when the stronghold has no resType', async () => {
    const level = 9;
    const troops = strongholdGarrison(level) + 1000;
    const { core, pwUpdateOne } = makeCore({
      tilesFindOne: (call) => (call === 1 ? null : tile({ ownerId: ATK })),
      pwById: { [`${W}:${ATK}`]: pw() },
    });
    const ctx = fakeCtx();
    await applyStrongholdSiege(core, ctx, march({ troops }), pw(), 1_000, { type: 'stronghold', level });
    const [, updateArgs] = pwUpdateOne.mock.calls[0]!;
    const reward = (updateArgs as { $set: { resources: Record<string, number> } }).$set.resources;
    expect(reward.ink).toBeGreaterThan(0);
  });

  it('victory reward write exhausts every rev-conflict retry attempt → logs and gives up (capture itself is unaffected)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const level = 9;
    const troops = strongholdGarrison(level) + 1000;
    const pwUpdateOne = vi.fn(async (..._args: unknown[]) => ({ matchedCount: 0 }));
    const { core } = makeCore({
      tilesFindOne: (call) => (call === 1 ? null : tile({ ownerId: ATK })),
      pwById: { [`${W}:${ATK}`]: pw() },
      pwUpdateOne,
    });
    const ctx = fakeCtx();
    await applyStrongholdSiege(core, ctx, march({ troops }), pw(), 1_000, { type: 'stronghold', level, resType: 'ink' });
    expect(ctx.writeContestedHold).toHaveBeenCalledTimes(1); // capture itself still lands
    expect(errSpy).toHaveBeenCalledWith(
      '[worldsvc] stronghold capture reward: giving up after rev-conflict retries',
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it('defeat: a card army still retreats home, recordSiege(defender_win, defenderId=undefined)', async () => {
    const level = 9;
    const getSaveFields = vi.fn(async (..._args: unknown[]) => saveFieldsWithCard('c1'));
    const { core, pwUpdateOne } = makeCore({
      tilesFindOne: () => null,
      getSaveFields,
      pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) },
    });
    const ctx = fakeCtx();
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    const p = pw({ cardState: { c1: { currentTroops: 1 } } as never });
    await applyStrongholdSiege(core, ctx, m, p, 1_000, { type: 'stronghold', level });
    expect(ctx.recordSiege).toHaveBeenCalledWith(expect.anything(), undefined, 'defender_win', 1_000, expect.anything());
    expect(pwUpdateOne.mock.calls.length).toBeGreaterThanOrEqual(2); // cardState write + return-march refund fallback
  });

  it('defeat with 0 survivors (no card army) → no return leg spawned', async () => {
    const level = 9;
    const { core, pwUpdateOne } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    await applyStrongholdSiege(core, ctx, march({ troops: 0 }), pw(), 1_000, { type: 'stronghold', level });
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// sweep.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applySweep', () => {
  it('tile already owned on arrival + team-dispatched → parks in place', async () => {
    const { core, stationedUpdateOne } = makeCore({ tilesFindOne: () => tile({ ownerId: 'someone-else' }) });
    const ctx = fakeCtx();
    await applySweep(core, ctx, march({ teamId: 't1' }), pw(), 1_000);
    expect(stationedUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('tile already owned, no team → refunds troops (miss)', async () => {
    const { core, pwUpdateOne } = makeCore({ tilesFindOne: () => tile({ ownerId: 'someone-else' }) });
    const ctx = fakeCtx();
    await applySweep(core, ctx, march(), pw(), 1_000);
    expect(pwUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('victory sweep: loots the procedural resource type, refunds 0 troops + loot, survivors return home', async () => {
    const proc = proceduralTile(W, 5, 5);
    const garrison = npcGarrison(proc.level);
    const { core, pwUpdateOne } = makeCore({
      tilesFindOne: () => null,
      pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) },
    });
    const ctx = fakeCtx();
    await applySweep(core, ctx, march({ troops: garrison + 1000 }), pw(), 1_000);
    expect(pwUpdateOne.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lootCall = pwUpdateOne.mock.calls[0]!;
    const resources = (lootCall[1] as { $set: { resources: Record<string, number> } }).$set.resources;
    const rt = proc.resType ?? 'ink';
    expect(resources[rt]).toBe(SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level));
    expect(ctx.recordSiege).toHaveBeenCalledWith(expect.anything(), undefined, 'attacker_win', 1_000, expect.anything());
  });

  it('defeat sweep: no loot, no attacker_win outcome, recordSiege still called', async () => {
    const proc = proceduralTile(W, 5, 5);
    const garrison = npcGarrison(proc.level);
    const { core } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    await applySweep(core, ctx, march({ troops: 0 }), pw(), 1_000);
    expect(garrison).toBeGreaterThanOrEqual(0);
    expect(ctx.recordSiege).toHaveBeenCalledWith(expect.anything(), undefined, 'defender_win', 1_000, expect.anything());
  });

  it('victory sweep on a tile with no procedural resType (e.g. an obstacle) → loot defaults to "ink"', async () => {
    // (315,0) is a procedurally-generated 'obstacle' tile for worldId 's1' — no resType at all.
    const toTile = `${W}:315:0`;
    const proc = proceduralTile(W, 315, 0);
    expect(proc.resType).toBeUndefined();
    const garrison = npcGarrison(proc.level);
    const { core, pwUpdateOne } = makeCore({
      tilesFindOne: () => null,
      pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) },
    });
    const ctx = fakeCtx();
    await applySweep(core, ctx, march({ toTile, troops: garrison + 1000 }), pw(), 1_000);
    const resources = (pwUpdateOne.mock.calls[0]![1] as { $set: { resources: Record<string, number> } }).$set.resources;
    expect(resources.ink).toBe(SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level));
  });

  it('morale omitted on the march → falls back to MARCH_MORALE_MAX (full strength) instead of throwing', async () => {
    const proc = proceduralTile(W, 5, 5);
    const garrison = npcGarrison(proc.level);
    const { core } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    const m = march({ troops: garrison + 1000 });
    delete (m as { morale?: number }).morale;
    await expect(applySweep(core, ctx, m, pw(), 1_000)).resolves.toBeUndefined();
    expect(ctx.recordSiege).toHaveBeenCalledWith(expect.anything(), undefined, 'attacker_win', 1_000, expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// landSiege.ts — takes a pre-computed SiegeResolution directly, no need to steer the engine.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('landSiege', () => {
  const winRes = (survivors: number): SiegeResolution => ({ outcome: 'attacker_win', attackerSurvivors: survivors, defenderSurvivors: 0, attackerDeployed: survivors, defenderDeployed: 0 });
  const loseRes = (defSurvivors: number): SiegeResolution => ({ outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: defSurvivors, attackerDeployed: 0, defenderDeployed: defSurvivors });

  it('attacker_win on a main base: loots, sends survivors home, applies sect-leader penalty + passive relocation', async () => {
    const { core } = makeCore({ pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) } });
    const ctx = fakeCtx();
    const target = tile({ type: 'base', ownerId: DEF });
    const defender = pw({ accountId: DEF });
    await landSiege(core, ctx, march(), pw(), target, DEF, defender, winRes(5), 1_000, null);
    expect(ctx.transferLoot).toHaveBeenCalledTimes(1);
    expect(ctx.applySectLeaderPenalty).toHaveBeenCalledWith(W, DEF, 1_000);
    expect(ctx.passiveRelocate).toHaveBeenCalledWith(W, DEF, 1_000);
  });

  it('attacker_win, no defender doc resolved → skips transferLoot entirely (nothing to loot)', async () => {
    const { core } = makeCore();
    const ctx = fakeCtx();
    const target = tile({ type: 'base', ownerId: DEF });
    await landSiege(core, ctx, march(), pw(), target, DEF, null, winRes(0), 1_000, null);
    expect(ctx.transferLoot).not.toHaveBeenCalled();
  });

  it('attacker_win against a structure with remaining HP: chips the structure, tile does NOT change hands', async () => {
    const { core, tilesUpdateOne } = makeCore({ pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) } });
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF, structure: { kind: 'arrowTower', level: 1, hp: 100, hpMax: 100, ownerId: DEF, builtAt: 0 } as never });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), winRes(30), 1_000, null);
    // 2026-08-24: the chip and the garrison wipe are persisted as deltas now (a reinforce landing in the
    // window must survive), so the 100 → 70 arithmetic reads as "subtract the 30 surviving attackers".
    //
    // 2026-09-04 (garrison regen, SLG_DESIGN §5.6): the delta is now the LIVE garrison rather than the
    // stored one, and the write stamps the heal clock. It is still 0 here — not because the heal was
    // skipped, but because this fixture's `t` is 1_000ms: the tile's absent checkpoint reads as epoch, so
    // only 1s of the 5-minute window has elapsed and floor() of a 0.4-troop heal is 0. That makes this
    // case a clean check of the timestamp alone; the heal arithmetic itself is pinned against realistic
    // clocks in core-helpers-gaps.test.ts and shared/test/garrison.test.ts.
    expect(tilesUpdateOne).toHaveBeenCalledWith({ _id: TILE }, [
      {
        $set: {
          'structure.hp': { $subtract: [{ $ifNull: ['$structure.hp', 100] }, 30] },
          garrison: { $max: [0, { $subtract: [{ $ifNull: ['$garrison', 0] }, 0] }] },
          garrisonRegenAt: 1_000,
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);
    expect(ctx.writeContestedHold).not.toHaveBeenCalled();
  });

  it('attacker_win against a structure reduced to <= 0 HP: falls through to the tile-hand-off branch instead', async () => {
    const { core } = makeCore({ pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) } });
    const ctx = fakeCtx();
    const target = tile({
      type: 'territory', ownerId: DEF, x: 5, y: 5,
      structure: { kind: 'arrowTower', level: 1, hp: 10, hpMax: 10, ownerId: DEF, builtAt: 0 } as never,
    });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), winRes(20), 1_000, null);
    expect(ctx.writeContestedHold).toHaveBeenCalledTimes(1);
    expect(core.removeCover).toHaveBeenCalledWith(W, 5, 5, TILE);
  });

  it("attacker_win, plain territory (no structure): writeContestedHold with the tile's current type/level/resType", async () => {
    const { core } = makeCore({ pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) } });
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF, level: 3, resType: 'ink' });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), winRes(10), 1_000, null);
    expect(ctx.writeContestedHold).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      { type: 'territory', level: 3, resType: 'ink' },
      5, 5, 10, 1_000, DEF,
    );
  });

  it('defender_win: garrison reduced to defender survivors; a card-army attacker still retreats home', async () => {
    const { core, tilesUpdateOne, pwUpdateOne } = makeCore({ pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) } });
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF });
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    const attacker = pw({ cardState: { c1: { currentTroops: 40 } } as never });
    const res: SiegeResolution = { outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: 12, attackerDeployed: 0, defenderDeployed: 12 };
    await landSiege(core, ctx, m, attacker, target, DEF, pw({ accountId: DEF }), res, 1_000, null);
    // 2026-08-24: persisted as casualties rather than "set to survivors", so a reinforce arriving in the
    // same processDueArrivals tick is no longer erased.
    //
    // 2026-09-04 (garrison regen, SLG_DESIGN §5.6): the loss basis is the LIVE garrison now, and the write
    // stamps the heal clock. The clamped loss stays 0 — the fixture's `t` is 1_000ms, so barely any of the
    // 5-minute heal window has elapsed against the tile's absent (epoch) checkpoint, and 12 survivors
    // already exceed what stood. Realistic-clock heal arithmetic is pinned elsewhere (see the structure
    // case above for the full note).
    expect(tilesUpdateOne).toHaveBeenCalledWith({ _id: TILE }, [
      {
        $set: {
          garrison: { $max: [0, { $subtract: [{ $ifNull: ['$garrison', 0] }, 0] }] },
          garrisonRegenAt: 1_000,
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);
    // hasCardArmy alone (attackerSurvivors=0) still triggers the return leg → playerWorld touched at least once.
    expect(pwUpdateOne.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('defender_win with 0 attacker survivors and no card army → no return leg at all', async () => {
    const { core, pwUpdateOne } = makeCore();
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), loseRes(20), 1_000, null);
    expect(pwUpdateOne).not.toHaveBeenCalled();
  });

  it('a card-army march writes post-battle cardState (currentTroops/injuredUntil) instead of the troop pool', async () => {
    const { core, pwUpdateOne } = makeCore();
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF });
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 0 }] as never });
    const attacker = pw({ cardState: { c1: { currentTroops: 50 } } as never });
    await landSiege(core, ctx, m, attacker, target, DEF, pw({ accountId: DEF }), winRes(50), 1_000, null);
    // 2026-08-24: cardState settlements are delta pipelines, so the dotted paths live in stage 0's $set.
    const cardWrite = pwUpdateOne.mock.calls.find(([, args]) => {
      const stage = Array.isArray(args) ? (args as { $set?: Record<string, unknown> }[])[0] : (args as { $set?: Record<string, unknown> });
      return Object.keys(stage?.$set ?? {}).some((k) => k.startsWith('cardState.'));
    });
    expect(cardWrite).toBeDefined();
  });

  it('the post-settlement tile re-fetch resolves → pushes the tile to both sides + observers', async () => {
    const after = tile({ type: 'territory', ownerId: ATK });
    const { core, pushTile, pushTileToObservers } = makeCore({
      pwById: { [`${W}:${ATK}`]: pw({ mainBaseTile: undefined }) },
      tilesFindOne: () => after,
    });
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), winRes(10), 1_000, null);
    expect(pushTile).toHaveBeenCalledTimes(2); // attacker + defender
    expect(pushTileToObservers).toHaveBeenCalledWith(after, new Set([ATK, DEF]));
  });

  it('the post-settlement tile re-fetch resolves to null (gone) → skips every push entirely', async () => {
    const { core, pushTile, pushTileToObservers } = makeCore({ tilesFindOne: () => null });
    const ctx = fakeCtx();
    const target = tile({ type: 'territory', ownerId: DEF });
    await landSiege(core, ctx, march(), pw(), target, DEF, pw({ accountId: DEF }), loseRes(5), 1_000, null);
    expect(pushTile).not.toHaveBeenCalled();
    expect(pushTileToObservers).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// baseSiege.ts — ADR-026 in-base wave defense. Defender teams are CC-3 card armies (ArmyEntry
// requires cardInstanceId — a flat {unitType,col,row,initialHp} entry has none and is silently
// dropped by resolveCardArmy), so every "a real defending team actually fights" scenario below
// wires a cardInv (via `defenderSave`) + matching `cardState.currentTroops`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('applyBaseSiege', () => {
  function makeBaseCore(opts: { marches?: unknown[]; pwUpdateOne?: ReturnType<typeof vi.fn> } = {}) {
    const marchesToArray = vi.fn(async (..._args: unknown[]) => opts.marches ?? []);
    const pwUpdateOne = opts.pwUpdateOne ?? vi.fn(async (..._args: unknown[]) => ({}));
    const siegeDamageUpdateOne = vi.fn(async (..._args: unknown[]) => ({}));
    const { core, ...rest } = makeCore({ pwUpdateOne });
    (core as unknown as { deps: { cols: Record<string, unknown> } }).deps.cols.marches = {
      find: () => ({ toArray: marchesToArray }),
    };
    (core as unknown as { deps: { cols: Record<string, unknown> } }).deps.cols.siegeDamage = {
      updateOne: siegeDamageUpdateOne,
    };
    return { ...rest, core, marchesToArray, pwUpdateOne, siegeDamageUpdateOne };
  }

  const baseTile = () => tile({ type: 'base', level: 1 });
  /** A real, resolvable card-based defender team (`currentTroops` on the given account's cardState). */
  const cardTeam = (id: string) => [{ id, name: id, army: [{ cardInstanceId: `card-${id}`, col: 0, row: 15 }] }] as never;

  it('no defender teams present at all → cleared=true (garrison win), schedules a delayed SiegeDamageDoc', async () => {
    const { core, siegeDamageUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({ accountId: DEF, teams: [] });
    await applyBaseSiege(
      core, ctx, march({ troops: 100 }), pw(), baseTile(), DEF, defender, false,
      [{ unitType: 0, col: 0, row: 1, initialHp: 100 }] as never,
      undefined, undefined, undefined, {}, {}, true, 1_000, null,
    );
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1);
    const [, args] = siegeDamageUpdateOne.mock.calls[0]!;
    expect((args as { $setOnInsert: { isBase: boolean } }).$setOnInsert.isBase).toBe(true);
  });

  it('a team out on an active march is skipped as a defender (still counts as "no defenders")', async () => {
    const { core, siegeDamageUpdateOne, marchesToArray } = makeBaseCore({
      marches: [{ teamId: 't1' }],
    });
    const ctx = fakeCtx();
    const defender = pw({ accountId: DEF, teams: cardTeam('t1') });
    await applyBaseSiege(
      core, ctx, march({ troops: 100 }), pw(), baseTile(), DEF, defender, false,
      [{ unitType: 0, col: 0, row: 1, initialHp: 100 }] as never,
      undefined, undefined, undefined, {}, {}, true, 1_000, null,
    );
    expect(marchesToArray).toHaveBeenCalled();
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1); // t1 excluded → no live defenders → cleared
  });

  it('an injured team (still under injuredUntil) is skipped as a defender', async () => {
    const { core, siegeDamageUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({
      accountId: DEF,
      teams: cardTeam('t1'),
      teamState: { t1: { injuredUntil: 5_000 } },
    });
    await applyBaseSiege(
      core, ctx, march({ troops: 100 }), pw(), baseTile(), DEF, defender, false,
      [{ unitType: 0, col: 0, row: 1, initialHp: 100 }] as never,
      undefined, undefined, undefined, {}, {}, true, 1_000, null,
    );
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1); // injured team excluded → cleared
  });

  it('a defending team with an empty resolved army (stale cardState / no cardInv) is treated as already cleared, no battle', async () => {
    const { core, siegeDamageUpdateOne, pwUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({
      accountId: DEF,
      teams: cardTeam('t1'),
      cardState: {}, // 'card-t1' resolves to no cardInv entry (defenderSave=null below) → empty defArmy
    });
    await applyBaseSiege(
      core, ctx, march({ troops: 100 }), pw(), baseTile(), DEF, defender, false,
      [{ unitType: 0, col: 0, row: 1, initialHp: 100 }] as never,
      undefined, undefined, undefined, {}, {}, true, 1_000, null,
    );
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1);
    // Team injury bookkeeping still runs for the "cleared" (defeated) empty team.
    expect(pwUpdateOne).toHaveBeenCalled();
  });

  it('attacker overwhelms a real defending team (cheap path via ratio) → wave cleared, team marked injured', async () => {
    const { core, siegeDamageUpdateOne, pwUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({
      accountId: DEF,
      teams: cardTeam('t1'),
      cardState: { 'card-t1': { currentTroops: 10 } } as never,
    });
    // Overwhelming attacker HP vs a 10-troop defender team: ratio (5000/10=500) far beyond SIEGE_CHEAP_RATIO.
    const attackerArmy = [{ unitType: 0, col: 0, row: 1, initialHp: 5000 }] as never;
    await applyBaseSiege(
      core, ctx, march({ troops: 5000 }), pw(), baseTile(), DEF, defender, false,
      attackerArmy, undefined, undefined, undefined, {}, {}, true, 1_000, saveFieldsWithCard('card-t1'),
    );
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1);
    const injuryCall = pwUpdateOne.mock.calls.find(([, args]) =>
      Object.keys((args as { $set: Record<string, unknown> }).$set).some((k) => k.includes('injuredUntil')));
    expect(injuryCall).toBeDefined();
  });

  it('nation defense bonus (inOwnNation=true) scales the defending team\'s HP — exercised via a repelled wave', async () => {
    const { core, siegeDamageUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({
      accountId: DEF,
      teams: cardTeam('t1'),
      cardState: { 'card-t1': { currentTroops: 5000 } } as never,
    });
    // Weak attacker overflow-forced into the cheap path but far too weak to beat even the unscaled 5000-troop
    // team — inOwnNation=true's scaleArmyHp bonus runs regardless of the eventual outcome (branch coverage
    // goal), and here the defender repels as expected.
    const attackerArmy = [{ unitType: 0, col: 0, row: 1, initialHp: 20_000 }] as never;
    await applyBaseSiege(
      core, ctx, march({ troops: 20_000 }), pw(), baseTile(), DEF, defender, true,
      attackerArmy, undefined, undefined, undefined, {}, {}, true, 1_000, saveFieldsWithCard('card-t1'),
    );
    // Overwhelming attacker (20000) still clears the (nation-boosted) 5000-troop team.
    expect(siegeDamageUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('attacker repelled (defender wins the only wave, forced cheap via attacker overflow) → not cleared, no SiegeDamageDoc', async () => {
    const { core, siegeDamageUpdateOne } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({
      accountId: DEF,
      teams: cardTeam('t1'),
      cardState: { 'card-t1': { currentTroops: 20_000 } } as never, // far stronger than the attacker
    });
    // attackerSynthesized + troops over SIEGE_SYNTH_ARMY_MAX_TROOPS (9600) forces the cheap path
    // regardless of the actual matchup (unlike the ratio rule, overflow doesn't care who's stronger).
    const attackerArmy = [{ unitType: 0, col: 0, row: 1, initialHp: 10_000 }] as never;
    await applyBaseSiege(
      core, ctx, march({ troops: 10_000 }), pw(), baseTile(), DEF, defender, false,
      attackerArmy, undefined, undefined, undefined, {}, {}, true, 1_000, saveFieldsWithCard('card-t1'),
    );
    expect(siegeDamageUpdateOne).not.toHaveBeenCalled(); // defender_win → not cleared → no delayed-damage doc
  });

  it('a card-army attacker writes post-battle cardState instead of the troop pool', async () => {
    const { core } = makeBaseCore();
    const ctx = fakeCtx();
    const defender = pw({ accountId: DEF, teams: [] });
    const m = march({ army: [{ cardInstanceId: 'c1', col: 0, row: 1 }] as never });
    const attacker = pw({ cardState: { c1: { currentTroops: 100 } } as never });
    await expect(applyBaseSiege(
      core, ctx, m, attacker, baseTile(), DEF, defender, false,
      [{ unitType: 0, col: 0, row: 1, initialHp: 100 }] as never,
      undefined, undefined, undefined, {}, {}, true, 1_000, null,
    )).resolves.toBeUndefined();
  });
});
