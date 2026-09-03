// Unit tests (hand-built fake WorldCore, no Mongo — same style as occupation-battle.test.ts /
// combatSiege-damage-helpers-gaps.test.ts) targeting the branch-coverage gaps in city/training.ts
// (CityTrainingService, 69.7% branch at 100% LINE coverage — every gap is an untaken `else`, a `??`
// fallback, or an unhit half of a compound condition on a line the e2e suites already execute) and
// city/buildings.ts (CityBuildingsService, 74.0% branch).
//
// Both classes only ever touch `this.core` — `deps.cols` / `deps.now`, `settle`, `settleExpr`,
// `recomputeYield`, `commercial.spend`, `getMe` — so all of it is stubbed directly and the tests run
// without a database. The paths that matter here are precisely the ones a Mongo e2e cannot reach
// cheaply: a document that vanishes between the read and the retry, a rev-guarded write that loses its
// race five times in a row, a legacy document missing `buildings` / `buildQueue` / `trainingQueue`
// entirely, and a tile with no `durability` yet.
//
// Real @nw/shared pure functions (troopTrainCost / drillTrainMult / trainQueueMaxFor / buildCost /
// buildTimeSec / troopCapFor / baseDurabilityMax / regenDurability) are imported unmocked and the
// expected values are computed with the same formula the source uses, so these assertions stay true
// if a constant is re-tuned — the convention occupation-battle.test.ts established.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ErrorCode,
  SlgError,
  RESOURCE_TYPES,
  TROOP_TRAIN_TIME_SEC,
  TROOP_SPEEDUP_SECS_PER_COIN,
  BUILD_SPEEDUP_SECS_PER_COIN,
  TRAIN_SPEEDUP_BUFF_MULT,
  troopTrainCost,
  drillTrainMult,
  buildCost,
  buildTimeSec,
  troopCapFor,
  baseDurabilityMax,
  regenDurability,
  type BuildingKey,
  type ResourceType,
} from '@nw/shared';
import { CityTrainingService } from '../src/city/training';
import { CityBuildingsService } from '../src/city/buildings';
import type { WorldCore } from '../src/core';
import type { PlayerWorldDoc, TileDoc, TrainingEntry, BuildQueueEntry } from '../src/db';

const W = 's1';
const ACC = 'acc-1';
const PW_ID = `${W}:${ACC}`;
/** Sentinel returned by the fake `getMe` — every happy path funnels through it. */
const ME = { worldId: W, accountId: ACC } as never;

/** A resource bag that may deliberately be MISSING keys — the shape that exercises the `?? 0` fallbacks. */
type PartialRes = Partial<Record<ResourceType, number>>;

/** Every resource at the same generous level (enough for any single batch/upgrade in this file). */
function richRes(amount = 10_000_000): PartialRes {
  return Object.fromEntries(RESOURCE_TYPES.map((rt) => [rt, amount])) as PartialRes;
}

function pwDoc(overrides: Omit<Partial<PlayerWorldDoc>, 'resources'> & { resources?: PartialRes } = {}): PlayerWorldDoc {
  return {
    _id: PW_ID,
    worldId: W,
    accountId: ACC,
    troops: 0,
    troopCap: 20_000,
    resources: richRes(),
    yieldRate: {},
    lastTickAt: 0,
    rev: 7,
    ...overrides,
  } as unknown as PlayerWorldDoc;
}

const trainEntry = (qty: number, startAt: number, completeAt: number): TrainingEntry =>
  ({ qty, inkCost: 0, startAt, completeAt });

const buildEntry = (key: BuildingKey, toLevel: number, startAt: number, completeAt: number): BuildQueueEntry =>
  ({ key, toLevel, startAt, completeAt });

interface RecordedUpdate {
  filter: Record<string, unknown>;
  update: Record<string, unknown> | Record<string, unknown>[];
}

/**
 * Fake WorldCore covering exactly the surface city/training.ts + city/buildings.ts touch.
 *
 * `pwFindOne` / `tilesFindOne` are called with a 1-based call counter so a test can drive the
 * read → retry → applyDueBuilds re-read sequence with a different document each time (a doc that
 * disappears mid-flight, a queue that was drained by someone else, …). `pwUpdates` / `tileUpdates`
 * record every write for assertion; `pwUpdateResult` / `tileUpdateResult` decide whether the
 * rev-guarded write "matched", which is how the conflict paths are driven.
 */
function makeCore(opts: {
  now?: number;
  pwFindOne?: (call: number) => PlayerWorldDoc | null;
  pwFind?: (query: Record<string, unknown>) => unknown[];
  pwUpdateResult?: (call: number) => { matchedCount: number };
  tilesFindOne?: (call: number) => TileDoc | null;
  tileUpdateResult?: (call: number) => { matchedCount: number };
  settle?: (doc: PlayerWorldDoc) => PartialRes;
} = {}) {
  const now = opts.now ?? 1_000_000;
  const pwUpdates: RecordedUpdate[] = [];
  const tileUpdates: RecordedUpdate[] = [];
  const pwFindQueries: Record<string, unknown>[] = [];
  const spend = vi.fn(async (..._args: unknown[]) => {});
  const recomputeYield = vi.fn(async (..._args: unknown[]) => ({}));
  const getMe = vi.fn(async (..._args: unknown[]) => ME);
  let pwFindOneCalls = 0;
  let pwUpdateCalls = 0;
  let tilesFindOneCalls = 0;
  let tileUpdateCalls = 0;

  const core = {
    deps: {
      now: () => now,
      cols: {
        playerWorld: {
          findOne: async () => {
            pwFindOneCalls++;
            return opts.pwFindOne ? opts.pwFindOne(pwFindOneCalls) : null;
          },
          find: (query: Record<string, unknown>) => {
            pwFindQueries.push(query);
            const docs = opts.pwFind ? opts.pwFind(query) : [];
            return { project: () => ({ toArray: async () => docs }) };
          },
          updateOne: async (filter: Record<string, unknown>, update: RecordedUpdate['update']) => {
            pwUpdateCalls++;
            pwUpdates.push({ filter, update });
            return opts.pwUpdateResult ? opts.pwUpdateResult(pwUpdateCalls) : { matchedCount: 1 };
          },
        },
        tiles: {
          findOne: async () => {
            tilesFindOneCalls++;
            return opts.tilesFindOne ? opts.tilesFindOne(tilesFindOneCalls) : null;
          },
          updateOne: async (filter: Record<string, unknown>, update: RecordedUpdate['update']) => {
            tileUpdateCalls++;
            tileUpdates.push({ filter, update });
            return opts.tileUpdateResult ? opts.tileUpdateResult(tileUpdateCalls) : { matchedCount: 1 };
          },
        },
      },
    },
    commercial: { spend },
    settle: (doc: PlayerWorldDoc) => (opts.settle ? opts.settle(doc) : { ...doc.resources }),
    // The persisted settle in applyDueBuilds is an aggregation expression evaluated by Mongo against the
    // live document, never a value computed here — an empty object is all the call site needs offline.
    settleExpr: () => ({}),
    recomputeYield,
    getMe,
  } as unknown as WorldCore;

  return {
    core, now, pwUpdates, tileUpdates, pwFindQueries, spend, recomputeYield, getMe,
    counts: () => ({ tilesFindOne: tilesFindOneCalls, pwFindOne: pwFindOneCalls }),
  };
}

/** Assert a rejection is a SlgError carrying exactly `code` — not merely "something threw". */
async function expectSlgCode(p: Promise<unknown>, code: keyof typeof ErrorCode, message?: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(SlgError);
  const err = await p.then(() => null, (e: unknown) => e as InstanceType<typeof SlgError>);
  expect(err?.code).toBe(ErrorCode[code]);
  if (message !== undefined) expect(err?.message).toBe(message);
}

/** `$set` fragment of a recorded (non-pipeline) update. */
function setOf(u: RecordedUpdate): Record<string, unknown> {
  return (u.update as Record<string, Record<string, unknown>>).$set!;
}

// ───────────────────────────── CityTrainingService.trainTroops ─────────────────────────────

describe('CityTrainingService.trainTroops', () => {
  it('a player who never joined the world is rejected with TILE_NOT_OWNED, before any write', async () => {
    const { core, pwUpdates } = makeCore({ pwFindOne: () => null });
    await expectSlgCode(new CityTrainingService(core).trainTroops(W, ACC, 10), 'TILE_NOT_OWNED');
    expect(pwUpdates).toHaveLength(0);
  });

  it('a batch already due at enqueue time is collected into `troops` and dropped from the queue, not left as a phantom slot', async () => {
    // The S8-8 scenario documented in the source: the 2s scheduler tick lagged, so a finished batch is
    // still sitting in the persisted queue. It must count toward troops (and free its slot) here.
    const now = 1_000_000;
    const stale = trainEntry(7, 0, now - 1); // completeAt <= t
    const { core, pwUpdates } = makeCore({
      now,
      pwFindOne: () => pwDoc({ troops: 100, trainingQueue: [stale] }),
    });
    await new CityTrainingService(core).trainTroops(W, ACC, 10);

    const set = setOf(pwUpdates[0]!);
    expect(set.troops).toBe(107); // 100 + the 7 troops the stale batch had already finished
    // The stale entry is gone and only the freshly queued batch remains — had it survived, the single
    // default slot would have been full and this call would have thrown "Training queue is full".
    expect(set.trainingQueue).toHaveLength(1);
    expect((set.trainingQueue as TrainingEntry[])[0]!.qty).toBe(10);
  });

  it('a batch that is NOT yet due survives the filter and still counts toward the troop cap', async () => {
    // The other half of the same filter: nothing is credited early, and the in-flight quantity is what
    // makes the cap check reject the new batch (drillYard 10 so the extra slots are not the limit here).
    const now = 1_000_000;
    const { core, pwUpdates } = makeCore({
      now,
      pwFindOne: () => pwDoc({
        buildings: { desk: 10, drillYard: 10 },
        troops: 100,
        troopCap: 1000,
        trainingQueue: [trainEntry(800, 0, now + 50_000)],
      }),
    });
    await expectSlgCode(
      new CityTrainingService(core).trainTroops(W, ACC, 200),
      'TROOP_CAP_REACHED',
      'Troops after training would exceed the cap',
    );
    expect(pwUpdates).toHaveLength(0);
  });

  it('a resource key MISSING from the settled bag reads as 0, not undefined → INSUFFICIENT_RESOURCES naming that resource', async () => {
    // Legacy documents predate a resource type; `resources[rt] ?? 0` is what keeps the comparison
    // numeric instead of `undefined < n` (always false — i.e. silently free troops).
    const { core, pwUpdates } = makeCore({
      pwFindOne: () => pwDoc(),
      settle: () => {
        const bag = richRes();
        delete bag.ink;
        return bag;
      },
    });
    await expectSlgCode(
      new CityTrainingService(core).trainTroops(W, ACC, 10),
      'INSUFFICIENT_RESOURCES',
      'Insufficient ink',
    );
    expect(pwUpdates).toHaveLength(0);
  });

  it('resources are debited by exactly troopTrainCost(qty)', async () => {
    const start = 500_000;
    const { core, pwUpdates } = makeCore({ pwFindOne: () => pwDoc({ resources: richRes(start) }) });
    await new CityTrainingService(core).trainTroops(W, ACC, 10);
    const cost = troopTrainCost(10);
    const expected = Object.fromEntries(RESOURCE_TYPES.map((rt) => [rt, start - (cost[rt] ?? 0)]));
    expect(setOf(pwUpdates[0]!).resources).toEqual(expected);
  });

  it('battle pass (×0.8) and drillYard (×drillTrainMult) both shorten the batch duration, multiplicatively', async () => {
    const now = 1_000_000;
    const qty = 10;
    const buildings = { desk: 10, drillYard: 3 };
    const run = async (hasBattlePass: boolean) => {
      const { core, pwUpdates } = makeCore({ now, pwFindOne: () => pwDoc({ buildings, hasBattlePass }) });
      await new CityTrainingService(core).trainTroops(W, ACC, qty);
      const entry = (setOf(pwUpdates[0]!).trainingQueue as TrainingEntry[])[0]!;
      expect(entry.startAt).toBe(now); // ADR-079: the batch starts NOW, it does not chain behind the queue
      return entry.completeAt - entry.startAt;
    };
    const base = qty * TROOP_TRAIN_TIME_SEC * 1000 * drillTrainMult(buildings);
    expect(await run(false)).toBe(Math.round(base));
    expect(await run(true)).toBe(Math.round(base * 0.8));
    expect(drillTrainMult(buildings)).toBeLessThan(1); // sanity: the drillYard levels really do bite
  });

  it('the rev guard losing its race throws REV_CONFLICT rather than silently double-spending', async () => {
    const { core } = makeCore({
      pwFindOne: () => pwDoc(),
      pwUpdateResult: () => ({ matchedCount: 0 }),
    });
    await expectSlgCode(new CityTrainingService(core).trainTroops(W, ACC, 10), 'REV_CONFLICT');
  });
});

// ──────────────────────────── CityTrainingService.speedupTraining ───────────────────────────

describe('CityTrainingService.speedupTraining', () => {
  it('a player who never joined the world is rejected with TILE_NOT_OWNED, and no coins are spent', async () => {
    const { core, spend } = makeCore({ pwFindOne: () => null });
    await expectSlgCode(new CityTrainingService(core).speedupTraining(W, ACC, 3), 'TILE_NOT_OWNED');
    expect(spend).not.toHaveBeenCalled();
  });

  it('a document with NO trainingQueue field reads as an empty queue → BAD_REQUEST before the spend', async () => {
    const { core, spend } = makeCore({ pwFindOne: () => pwDoc() }); // no trainingQueue key at all
    await expectSlgCode(
      new CityTrainingService(core).speedupTraining(W, ACC, 3),
      'BAD_REQUEST',
      'No training queue in progress',
    );
    expect(spend).not.toHaveBeenCalled();
  });

  it('battle pass buys 1/0.85 more seconds per coin; the coins are spent through commercial with a traceable orderId', async () => {
    const now = 1_000_000;
    const completeAt = now + 10_000_000; // far enough out that the coins only compress, never drain
    const run = async (hasBattlePass: boolean) => {
      const doc = pwDoc({ hasBattlePass, trainingQueue: [trainEntry(5, 0, completeAt)] });
      const { core, pwUpdates, spend } = makeCore({ now, pwFindOne: () => doc });
      await new CityTrainingService(core).speedupTraining(W, ACC, 2, 'web');
      expect(spend).toHaveBeenCalledWith(ACC, 2, `slg_speedup:${W}:${ACC}:${now}`, 'web');
      return (setOf(pwUpdates[0]!).trainingQueue as TrainingEntry[])[0]!.completeAt;
    };
    const plainSecs = 2 * TROOP_SPEEDUP_SECS_PER_COIN;
    expect(await run(false)).toBe(completeAt - plainSecs * 1000);
    expect(await run(true)).toBe(completeAt - (plainSecs / 0.85) * 1000);
  });

  it('the document disappearing between the spend and the finalize write returns the view instead of writing', async () => {
    // Coins are already gone at this point; there is nothing left to credit them to, so the retry loop
    // bails out rather than resurrecting a deleted document.
    const { core, pwUpdates, getMe } = makeCore({
      pwFindOne: (call) => (call === 1 ? pwDoc({ trainingQueue: [trainEntry(5, 0, 9_000_000)] }) : null),
    });
    await expect(new CityTrainingService(core).speedupTraining(W, ACC, 1)).resolves.toBe(ME);
    expect(pwUpdates).toHaveLength(0);
    expect(getMe).toHaveBeenCalledWith(W, ACC);
  });

  it('a queue drained by someone else between the read and the retry writes an empty queue and $unsets the due-scan mirror', async () => {
    // `fresh.trainingQueue ?? []` — the concurrent writer removed the field outright (that is what
    // trainingQueueOps' $unset does), so the re-read document has no queue at all.
    const now = 1_000_000;
    const { core, pwUpdates } = makeCore({
      now,
      pwFindOne: (call) =>
        call === 1
          ? pwDoc({ troops: 40, trainingQueue: [trainEntry(5, 0, now + 9_000_000)] })
          : pwDoc({ troops: 40, rev: 9 }), // no trainingQueue field on the re-read
    });
    await new CityTrainingService(core).speedupTraining(W, ACC, 1);

    expect(pwUpdates).toHaveLength(1);
    const u = pwUpdates[0]!;
    expect(u.filter).toEqual({ _id: PW_ID, rev: 9 }); // guarded on the FRESH rev, not the stale first read
    expect(setOf(u).trainingQueue).toEqual([]);
    expect(setOf(u).troops).toBe(40); // nothing was drained here, so no troops are credited
    expect((u.update as Record<string, unknown>).$unset).toEqual({ nextTrainingCompleteAt: '' });
  });
});

// ─────────────────────── CityTrainingService.processCompletedTraining ────────────────────────

describe('CityTrainingService.processCompletedTraining — buff catch-up pass', () => {
  const now = 1_000_000;

  it('watermark guard: absent speedupSettledAt guards on $exists:false, a present one on its exact value; a no-op catch-up writes nothing', async () => {
    const active = trainEntry(50, 0, now + 500_000);
    const buffed = [
      // ① never touched by the buff bookkeeping and carrying no queue field — `speedupSettledAt ?? t`
      //    and `trainingQueue ?? []` both fall back, and the guard must be the "field is absent" form.
      { _id: 'a', speedupUntil: now + 100_000 },
      // ② mid-buff, watermark 10s behind → a real catch-up, guarded on the exact watermark value.
      { _id: 'b', speedupUntil: now + 100_000, speedupSettledAt: now - 10_000, trainingQueue: [active] },
      // ③ buff already over before the window opened → same array reference back → `continue`, no write.
      { _id: 'c', speedupUntil: now - 20_000, speedupSettledAt: now - 10_000, trainingQueue: [active] },
    ];
    const { core, pwUpdates } = makeCore({
      now,
      pwFind: (q) => ('speedupUntil' in q ? buffed : []),
    });
    const n = await new CityTrainingService(core).processCompletedTraining(now);
    expect(n).toBe(0); // the due-scan found nothing; this pass only persists catch-up

    expect(pwUpdates.map((u) => u.filter._id)).toEqual(['a', 'b']); // 'c' was skipped entirely
    expect(pwUpdates[0]!.filter).toEqual({ _id: 'a', speedupSettledAt: { $exists: false } });
    expect(setOf(pwUpdates[0]!)).toMatchObject({ trainingQueue: [], speedupSettledAt: now });

    expect(pwUpdates[1]!.filter).toEqual({ _id: 'b', speedupSettledAt: now - 10_000 });
    const extra = 10_000 * (TRAIN_SPEEDUP_BUFF_MULT - 1);
    const caught = setOf(pwUpdates[1]!).trainingQueue as TrainingEntry[];
    expect(caught[0]!.completeAt).toBe(active.completeAt - extra);
    expect(setOf(pwUpdates[1]!).nextTrainingCompleteAt).toBe(active.completeAt - extra);
  });

  it('due-scan: a document with no trainingQueue field is skipped, one with due batches is credited and counted', async () => {
    const due = [trainEntry(3, 0, now - 1), trainEntry(4, 0, now)];
    const docs = [
      { _id: 'x', troops: 0, troopCap: 100 }, // mirror stale, array gone — `trainingQueue ?? []` → nothing due
      { _id: 'y', troops: 10, troopCap: 100, trainingQueue: [...due, trainEntry(9, 0, now + 5_000)] },
    ];
    const { core, pwUpdates } = makeCore({
      now,
      pwFind: (q) => ('speedupUntil' in q ? [] : docs),
    });
    const n = await new CityTrainingService(core).processCompletedTraining(now);
    expect(n).toBe(2); // both due entries of 'y'; 'x' contributed nothing

    expect(pwUpdates).toHaveLength(1);
    expect(pwUpdates[0]!.filter).toEqual({ _id: 'y' });
    // Credit + dequeue is one aggregation pipeline computed from the LIVE document (2026-08-24
    // troop-duplication fix) — no absolute troop count derived from the snapshot above.
    expect(Array.isArray(pwUpdates[0]!.update)).toBe(true);
    const stages = pwUpdates[0]!.update as Record<string, Record<string, unknown>>[];
    expect(stages).toHaveLength(2);
    expect(Object.keys(stages[0]!.$set!)).toEqual(['troops', 'trainingQueue']);
    expect(stages[1]!.$set!.nextTrainingCompleteAt).toBeTruthy();
  });
});

// ──────────────────────── CityBuildingsService.upgradeBuilding ───────────────────────────────

describe('CityBuildingsService.upgradeBuilding', () => {
  it('a player who never joined the world is rejected with TILE_NOT_OWNED', async () => {
    const { core, pwUpdates } = makeCore({ pwFindOne: () => null });
    await expectSlgCode(new CityBuildingsService(core).upgradeBuilding(W, ACC, 'inkPot'), 'TILE_NOT_OWNED');
    expect(pwUpdates).toHaveLength(0);
  });

  it('a document with NO buildings field is treated as { desk: 1 }, so a first L1 upgrade still passes the desk gate', async () => {
    const now = 1_000_000;
    const { core, pwUpdates } = makeCore({ now, pwFindOne: () => pwDoc() }); // no buildings key
    await new CityBuildingsService(core).upgradeBuilding(W, ACC, 'inkPot');

    const u = pwUpdates[0]!;
    const pushed = (u.update as Record<string, Record<string, unknown>>).$push!.buildQueue as BuildQueueEntry;
    // toLevel 1 only comes out right if the missing `buildings` defaulted to { desk: 1 }: buildingLevel
    // of an absent inkPot is 0, and the gate needs deskLevel >= 1 (an empty {} default would still give
    // desk 1 via buildingLevel, but a wrong default of {} for the *level* lookup would not).
    expect(pushed.toLevel).toBe(1);
    expect(pushed.key).toBe('inkPot');
    // Empty queue → the build starts now rather than chaining behind anything.
    expect(pushed.startAt).toBe(now);
    expect(pushed.completeAt).toBe(now + buildTimeSec('inkPot', 1) * 1000);
    expect(setOf(u).nextBuildCompleteAt).toBe(pushed.completeAt);
  });

  it('resource keys absent from the settled bag read as 0 on BOTH the sufficiency check and the debit', async () => {
    // paperTray costs graphite only, so a bag holding nothing but graphite must pass the check (0 < 0 is
    // false for every other type) and come out of the debit with explicit zeroes, not NaN/undefined.
    const { core, pwUpdates } = makeCore({
      pwFindOne: () => pwDoc({ buildings: { desk: 2 } }),
      settle: () => ({ graphite: 5000 }),
    });
    await new CityBuildingsService(core).upgradeBuilding(W, ACC, 'paperTray');

    const cost = buildCost('paperTray', 1);
    expect(cost.ink).toBeUndefined(); // sanity: buildCost really omits the untouched types
    expect(setOf(pwUpdates[0]!).resources).toEqual({
      ink: 0, paper: 0, metal: 0, sticker: 0,
      graphite: 5000 - (cost.graphite ?? 0),
    });
  });

  it('a shortfall in a resource the upgrade actually needs throws INSUFFICIENT_RESOURCES naming it', async () => {
    const { core, pwUpdates } = makeCore({
      pwFindOne: () => pwDoc({ buildings: { desk: 2 } }),
      settle: () => ({ graphite: 1 }),
    });
    await expectSlgCode(
      new CityBuildingsService(core).upgradeBuilding(W, ACC, 'paperTray'),
      'INSUFFICIENT_RESOURCES',
      'Insufficient graphite',
    );
    expect(pwUpdates).toHaveLength(0);
  });

  it('the desk gate rejects a building whose target level exceeds the desk level, with the gate reason as the message', async () => {
    const { core } = makeCore({ pwFindOne: () => pwDoc({ buildings: { desk: 1, inkPot: 1 } }) });
    await expectSlgCode(
      new CityBuildingsService(core).upgradeBuilding(W, ACC, 'inkPot'),
      'BAD_REQUEST',
      'desk level too low',
    );
  });
});

// ───────────────────────── CityBuildingsService.speedupBuild ─────────────────────────────────

describe('CityBuildingsService.speedupBuild', () => {
  const now = 1_000_000;

  it('a player who never joined the world is rejected with TILE_NOT_OWNED, and no coins are spent', async () => {
    const { core, spend } = makeCore({ pwFindOne: () => null });
    await expectSlgCode(new CityBuildingsService(core).speedupBuild(W, ACC, 2), 'TILE_NOT_OWNED');
    expect(spend).not.toHaveBeenCalled();
  });

  it('both "no buildQueue field" and "empty buildQueue" are rejected as BAD_REQUEST before the spend', async () => {
    const missing = makeCore({ pwFindOne: () => pwDoc() });
    await expectSlgCode(
      new CityBuildingsService(missing.core).speedupBuild(W, ACC, 2),
      'BAD_REQUEST',
      'No build queue in progress',
    );
    expect(missing.spend).not.toHaveBeenCalled();

    const empty = makeCore({ pwFindOne: () => pwDoc({ buildQueue: [] }) });
    await expectSlgCode(
      new CityBuildingsService(empty.core).speedupBuild(W, ACC, 2),
      'BAD_REQUEST',
      'No build queue in progress',
    );
    expect(empty.spend).not.toHaveBeenCalled();
  });

  it('battle pass buys 1/0.85 more seconds per coin off the build clock', async () => {
    const completeAt = now + 10_000_000;
    const run = async (hasBattlePass: boolean) => {
      const doc = pwDoc({ hasBattlePass, buildQueue: [buildEntry('inkPot', 1, 0, completeAt)] });
      const { core, pwUpdates, spend } = makeCore({ now, pwFindOne: () => doc });
      await new CityBuildingsService(core).speedupBuild(W, ACC, 2, 'ios');
      expect(spend).toHaveBeenCalledWith(ACC, 2, `slg_build_speedup:${W}:${ACC}:${now}`, 'ios');
      return (setOf(pwUpdates[0]!).buildQueue as BuildQueueEntry[])[0]!.completeAt;
    };
    const plainSecs = 2 * BUILD_SPEEDUP_SECS_PER_COIN;
    expect(await run(false)).toBe(completeAt - plainSecs * 1000);
    expect(await run(true)).toBe(completeAt - (plainSecs / 0.85) * 1000);
  });

  it('draining the head cascades the follower back onto it, preserving the follower own duration', async () => {
    // Two queued builds is not reachable through upgradeBuilding today (BUILD_QUEUE_SLOTS === 1), but the
    // cascade loop is the forward-compatible half of the paid-second-slot design — pinned here directly.
    const coinMs = BUILD_SPEEDUP_SECS_PER_COIN * 1000;
    const head = buildEntry('inkPot', 1, now - 10_000, now + coinMs); // exactly one coin's worth left
    const followerDur = 200_000;
    const follower = buildEntry('wall', 1, head.completeAt, head.completeAt + followerDur);
    const { core, pwUpdates } = makeCore({
      now,
      // 3rd read is applyDueBuilds': the document is gone by then, so it is a clean no-op.
      pwFindOne: (call) => (call <= 2 ? pwDoc({ buildQueue: [head, follower] }) : null),
    });
    await new CityBuildingsService(core).speedupBuild(W, ACC, 1);

    const q = setOf(pwUpdates[0]!).buildQueue as BuildQueueEntry[];
    expect(q[0]!.completeAt).toBe(now); // head marked due-now; applyDueBuilds finalizes it
    expect(q[1]!.startAt).toBe(now); // cascaded onto the compressed head
    expect(q[1]!.completeAt).toBe(now + followerDur); // its own duration is preserved, not the absolute time
    expect(setOf(pwUpdates[0]!).nextBuildCompleteAt).toBe(now);
  });

  it('a queue drained by someone else between read and retry writes an empty queue and $unsets the mirror', async () => {
    const { core, pwUpdates } = makeCore({
      now,
      pwFindOne: (call) =>
        call === 1
          ? pwDoc({ buildQueue: [buildEntry('inkPot', 1, 0, now + 9_000_000)] })
          : pwDoc({ rev: 11 }), // no buildQueue field on the re-read (and none for applyDueBuilds either)
    });
    await new CityBuildingsService(core).speedupBuild(W, ACC, 1);

    expect(pwUpdates).toHaveLength(1); // applyDueBuilds found nothing due and wrote nothing
    expect(pwUpdates[0]!.filter).toEqual({ _id: PW_ID, rev: 11 });
    expect(setOf(pwUpdates[0]!).buildQueue).toEqual([]);
    expect((pwUpdates[0]!.update as Record<string, unknown>).$unset).toEqual({ nextBuildCompleteAt: '' });
  });
});

// ──────────────────── CityBuildingsService.processCompletedBuilds / applyDueBuilds ───────────

describe('CityBuildingsService.processCompletedBuilds', () => {
  const now = 1_000_000;
  const dueDocs = [{ _id: PW_ID, worldId: W, accountId: ACC }];

  afterEach(() => { vi.restoreAllMocks(); });

  it('a document with no buildQueue field applies nothing and writes nothing', async () => {
    const { core, pwUpdates } = makeCore({ now, pwFind: () => dueDocs, pwFindOne: () => pwDoc() });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(0);
    expect(pwUpdates).toHaveLength(0);
  });

  it('a document that vanished between the due-scan and the apply read is a clean no-op', async () => {
    const { core, pwUpdates } = makeCore({ now, pwFind: () => dueDocs, pwFindOne: () => null });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(0);
    expect(pwUpdates).toHaveLength(0);
  });

  it('applies onto a { desk: 1 } default when the document has no buildings map, and $$REMOVEs the mirror once the queue drains', async () => {
    const { core, pwUpdates, recomputeYield } = makeCore({
      now,
      pwFind: () => dueDocs,
      pwFindOne: () => pwDoc({ buildQueue: [buildEntry('drillYard', 1, 0, now)] }), // no buildings key
    });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(1);

    expect(pwUpdates).toHaveLength(1);
    const stages = pwUpdates[0]!.update as Record<string, Record<string, unknown>>[];
    const set = stages[0]!.$set!;
    expect(set.buildings).toEqual({ desk: 1, drillYard: 1 });
    expect(set.buildQueue).toEqual([]);
    // The queue drained, so buildQueueOps asked for an $unset — inside a pipeline that is spelled $$REMOVE.
    expect(set.nextBuildCompleteAt).toBe('$$REMOVE');
    expect(set.troopCap).toBe(troopCapFor({ desk: 1, drillYard: 1 }));
    // The post-upgrade yield is computed from the NEW levels, which are not persisted yet.
    expect(recomputeYield).toHaveBeenCalledWith(W, ACC, { desk: 1, drillYard: 1 }, undefined);
  });

  it('a still-pending build keeps the mirror pointing at it, and a completed desk mirrors its level onto the base tile', async () => {
    // Leftover-entry half of the mirror branch: the queue did NOT drain, so buildQueueOps emits a plain
    // $set instead of the $$REMOVE, and the follower's completeAt is what the due-scan keeps watching.
    const leftover = buildEntry('inkPot', 1, now, now + 100_000);
    const tileId = `${W}:5:5`;
    const { core, pwUpdates, tileUpdates } = makeCore({
      now,
      pwFind: () => dueDocs,
      pwFindOne: () => pwDoc({
        buildings: { desk: 1 }, mainBaseTile: tileId,
        buildQueue: [buildEntry('desk', 2, 0, now), leftover],
      }),
    });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(1);

    const set = (pwUpdates[0]!.update as Record<string, Record<string, unknown>>[])[0]!.$set!;
    expect(set.buildings).toEqual({ desk: 2 });
    expect(set.buildQueue).toEqual([leftover]);
    expect(set.nextBuildCompleteAt).toBe(leftover.completeAt); // a real value, not '$$REMOVE'
    // TileDoc.deskLevel drives the playerbase_l{n} art frame on the world map.
    expect(tileUpdates).toHaveLength(1);
    expect(tileUpdates[0]!.filter).toEqual({ _id: tileId });
    expect(setOf(tileUpdates[0]!)).toEqual({ deskLevel: 2 });
  });

  it('a completed wall upgrade rebases durability on a tile that has never been damaged (no durability / regenAt fields yet)', async () => {
    const buildings = { desk: 10, wall: 1 };
    const tile = { _id: `${W}:5:5`, worldId: W, rev: 3 } as unknown as TileDoc; // no durability, no durabilityRegenAt
    const { core, tileUpdates } = makeCore({
      now,
      pwFind: () => dueDocs,
      pwFindOne: () => pwDoc({ buildings, mainBaseTile: tile._id, buildQueue: [buildEntry('wall', 2, 0, now)] }),
      tilesFindOne: () => tile,
    });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(1);

    const oldMax = baseDurabilityMax(1);
    const newMax = baseDurabilityMax(2);
    expect(newMax).toBeGreaterThan(oldMax); // sanity: the wall level really does raise the cap
    const expected = Math.min(newMax, regenDurability(oldMax, oldMax, now, now) + (newMax - oldMax));
    expect(tileUpdates).toHaveLength(1);
    expect(tileUpdates[0]!.filter).toEqual({ _id: tile._id, rev: 3 });
    expect(setOf(tileUpdates[0]!)).toEqual({ durability: expected, durabilityMax: newMax, durabilityRegenAt: now });
  });

  it('a wall upgrade whose base tile is missing skips the rebase instead of writing a tile that is not there', async () => {
    const { core, tileUpdates, counts } = makeCore({
      now,
      pwFind: () => dueDocs,
      pwFindOne: () => pwDoc({
        buildings: { desk: 10, wall: 1 }, mainBaseTile: `${W}:5:5`,
        buildQueue: [buildEntry('wall', 2, 0, now)],
      }),
      tilesFindOne: () => null,
    });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(1);
    expect(tileUpdates).toHaveLength(0);
    expect(counts().tilesFindOne).toBe(1); // broke out of the retry loop, did not burn all 5 attempts
  });

  it('losing the tile rev race five times logs and moves on — the build itself still counts as applied', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tile = { _id: `${W}:5:5`, worldId: W, rev: 3, durability: 120 } as unknown as TileDoc;
    const { core, tileUpdates, counts } = makeCore({
      now,
      pwFind: () => dueDocs,
      pwFindOne: () => pwDoc({
        buildings: { desk: 10, wall: 1 }, mainBaseTile: tile._id,
        buildQueue: [buildEntry('wall', 2, 0, now)],
      }),
      tilesFindOne: () => tile,
      tileUpdateResult: () => ({ matchedCount: 0 }),
    });
    expect(await new CityBuildingsService(core).processCompletedBuilds(now)).toBe(1);

    expect(tileUpdates).toHaveLength(5); // MAX_TILE_ATTEMPTS
    expect(counts().tilesFindOne).toBe(5); // re-read every attempt, not reusing the stale snapshot
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toContain('wall durability rebase lost the rev race');
  });
});
