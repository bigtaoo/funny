// Branch-coverage backfill for src/service/liveops/retention.ts + src/service/liveops/helpers.ts
// (2026-09-03 branch-coverage task, group E). test/liveops-retention-unit.test.ts already drives every
// check-in / daily / weekly-chest happy path and the main "claim recorded, delivery failed, retry
// resumes it" resilience loops through fastify; this file only adds the arms it cannot reach:
//
//  * the REV_CONFLICT tail of all three claim handlers (mutateSave burning its 4 attempts): what the
//    player gets when the save document is under contention — a 409 with nothing claimed and nothing
//    granted, never a partial reward. A wrapped saves collection whose findOneAndUpdate never matches
//    forces it (same idiom as test/economy-service-unit.test.ts / test/cards-fuse-unit.test.ts).
//  * the *unrecoverable* recovery branches: an ALREADY_CLAIMED(_TODAY) retry whose re-delivery fails
//    again (502, still retryable) and a genuine month-exhausted 409 on a day that was NOT claimed today
//    (the MONTH_FULL-vs-already-claimed-today disambiguation, from the other side than the unit test's).
//  * the daily reward's commercial gate (503) and its retry-grant-also-failed 409.
//  * check-in reward kinds the shipped 30-slot table no longer contains ('coins', 'stamina' — see
//    CHECKIN_REWARDS' comment: stamina "stays a valid kind for old save snapshots"), by temporarily
//    swapping one slot of that table. Their delivery code is live and reachable the moment the table or
//    an old save carries one, and it is what decides whether such a slot pays out at all.
//  * helpers.ts's "lost the insert race AND the read-back came back empty" refusal.
//
// FakeCollection-backed, no real Mongo (same rationale as test/liveops-retention-unit.test.ts: every
// Mongo call reachable here is findOne/findOneAndUpdate/updateOne with $set/$setOnInsert). Handlers are
// called as plain functions with a hand-built request/reply and a directly-constructed MetaCore — the
// seeded retention states below (a 30/30 calendar, a claimed-but-undelivered tier) are otherwise only
// reachable by replaying a whole month of requests.
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  makeNewSave, makeDayKey, makeMonthKey, makeWeekKey, CHECKIN_REWARDS,
  type CheckinReward, type Collections, type SaveData,
} from '@nw/shared';
import type { CommercialClient } from '../src/commercialClient.js';
import { MetaCore, type ServiceDeps } from '../src/service/base.js';
import { AccountCache } from '../src/accountCache.js';
import { claimCheckinHandler, claimDailyRewardHandler, claimWeeklyChestHandler } from '../src/service/liveops/retention.js';
import { deliverRetentionReward } from '../src/service/liveops/helpers.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway } from './helpers/fakeClients.js';

const jwt = { secret: 'test-secret' };
const NOW = new Date('2026-03-15T12:00:00Z').getTime();
const YESTERDAY_KEY = makeDayKey(NOW - 24 * 3600 * 1000);
const ACC = 'acc-grpE-retention';

interface FakeSaveDoc {
  _id: string;
  save: SaveData;
  rev: number;
}

/** Commercial double whose grant can be made to fail for a given orderId, any number of times. */
function makeCommercial(opts: { available?: boolean; failOrderIds?: string[] } = {}) {
  const state = {
    coins: 0,
    grants: [] as string[],
    /** orderIds that fail on EVERY attempt (the "the coin service is still down on your retry" case). */
    failOrderIds: new Set(opts.failOrderIds ?? []),
    delivered: new Set<string>(),
  };
  const client = {
    available: opts.available ?? true,
    async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
      state.grants.push(a.orderId);
      if (state.failOrderIds.has(a.orderId)) return { ok: false as const, error: 'injected failure' };
      if (!state.delivered.has(a.orderId)) {
        state.delivered.add(a.orderId);
        state.coins += a.amount;
      }
      return { ok: true as const, coinsAfter: state.coins };
    },
  } as unknown as CommercialClient;
  return { state, client };
}

function makeCols(save: SaveData) {
  const saves = new FakeCollection<FakeSaveDoc>().seed({ _id: ACC, save, rev: save.rev });
  const equipmentIdem = new FakeCollection<{ _id: string; accountId: string; op: string; result: unknown; committed: boolean }>();
  const cols = {
    saves,
    accounts: new FakeCollection<{ _id: string }>(),
    equipmentInstances: new FakeCollection<{ _id: string }>(),
    cardInstances: new FakeCollection<{ _id: string }>(),
    materialInstances: new FakeCollection<{ _id: string }>(),
    equipmentIdem,
  } as unknown as Collections;
  return { cols, saves, equipmentIdem };
}

function makeDeps(cols: Collections, commercial: CommercialClient): ServiceDeps {
  return {
    cols, jwt, now: () => NOW, commercial,
    gatewayPublicUrl: null, gateway: fakeGateway(), authRateLimit: 0,
    flags: null, wordlists: null, region: null, lokiPushUrl: null,
    socialsvc: null, redis: null, accountCache: new AccountCache(),
  } as ServiceDeps;
}

/** Wraps a saves handle so every findOneAndUpdate misses -> mutateSave reports REV_CONFLICT. */
function alwaysLosingSaves(saves: FakeCollection<FakeSaveDoc>) {
  return { findOne: saves.findOne.bind(saves), updateOne: saves.updateOne.bind(saves), findOneAndUpdate: async () => null };
}

/** Wraps a saves handle so only the writes that change `field` miss — used to fail a card/equipment
 *  grant's own inventory-count bump while letting the claim recording itself commit. */
function failGrantWrites(saves: FakeCollection<FakeSaveDoc>, field: 'cardInvCount' | 'equipmentInvCount') {
  return {
    findOne: saves.findOne.bind(saves),
    updateOne: saves.updateOne.bind(saves),
    findOneAndUpdate: async (
      filter: Record<string, unknown>,
      update: Record<string, Record<string, unknown>>,
      opts?: { returnDocument?: 'before' | 'after' },
    ) => {
      const current = await saves.findOne(filter);
      const incoming = update.$set?.save as Partial<SaveData> | undefined;
      if (current && incoming && incoming[field] !== current.save[field]) return null;
      return saves.findOneAndUpdate(filter, update, opts);
    },
  };
}

function makeReply() {
  const sent: { code?: number; payload?: unknown } = {};
  const reply = {
    code(c: number) { sent.code = c; return reply; },
    send(p: unknown) { sent.payload = p; return reply; },
  };
  return { sent, reply: reply as unknown as FastifyReply };
}

const req = (body: unknown = {}) => ({ accountId: ACC, body, headers: {}, log: { warn() {} } }) as unknown as FastifyRequest;
const errOf = (payload: unknown) => (payload as { error: { code: string; message: string } }).error;

/** A save with a hand-seeded check-in calendar (skips replaying a month of requests). */
function saveWithCheckin(claimedDays: number[], lastClaimedDayKey: string): SaveData {
  return {
    ...makeNewSave(ACC, NOW),
    retention: { checkin: { monthKey: makeMonthKey(NOW), claimedDays, lastClaimedDayKey } },
  };
}

function saveWithDaily(taskPoints: number, rewardClaimed: boolean): SaveData {
  return {
    ...makeNewSave(ACC, NOW),
    retention: { daily: { dayKey: makeDayKey(NOW), taskPoints, completedTasks: { 'pve.clear': 1, 'pvp.match': 1, 'gacha.draw': 1 }, rewardClaimed } },
  };
}

function saveWithWeekly(points: number, claimedTiers: number[]): SaveData {
  return {
    ...makeNewSave(ACC, NOW),
    retention: { weekly: { weekKey: makeWeekKey(NOW), points, claimedTiers } },
  };
}

/** Runs `fn` with CHECKIN_REWARDS slot 1 replaced. The 30-slot table is materials + 4 milestones today
 *  (no 'coins'/'stamina' slot), but retention.ts still implements both kinds — for old save snapshots
 *  and for any future table that uses them. Restored immediately afterwards. */
async function withCheckinSlot1(reward: CheckinReward, fn: () => Promise<void>): Promise<void> {
  const original = CHECKIN_REWARDS[0]!;
  CHECKIN_REWARDS[0] = reward;
  try {
    await fn();
  } finally {
    CHECKIN_REWARDS[0] = original;
  }
}

describe('retention.ts + liveops/helpers.ts branch backfill (group E)', () => {
  // ── POST /retention/checkin ───────────────────────────────────────────────────────────────────
  describe('claimCheckinHandler', () => {
    it('a coins-kind slot pays out through commercial and mirrors the new balance into the save', async () => {
      await withCheckinSlot1({ kind: 'coins', count: 25 }, async () => {
        const { cols } = makeCols(makeNewSave(ACC, NOW));
        const comm = makeCommercial();
        const core = new MetaCore(makeDeps(cols, comm.client));
        const { sent, reply } = makeReply();
        const out = (await claimCheckinHandler(core, req(), reply)) as { data: { day: number; save: SaveData } };
        expect(sent.code).toBeUndefined();
        expect(out.data.day).toBe(1);
        expect(comm.state.grants).toEqual([`checkin:${ACC}:${makeMonthKey(NOW)}:1`]);
        expect(out.data.save.wallet.coins).toBe(25);
      });
    });

    it('a coins-kind slot whose grant fails -> 502, retryable (the day stays claimed, nothing else is written)', async () => {
      const orderId = `checkin:${ACC}:${makeMonthKey(NOW)}:1`;
      await withCheckinSlot1({ kind: 'coins', count: 25 }, async () => {
        const { cols, saves } = makeCols(makeNewSave(ACC, NOW));
        const core = new MetaCore(makeDeps(cols, makeCommercial({ failOrderIds: [orderId] }).client));
        const { sent, reply } = makeReply();
        await claimCheckinHandler(core, req(), reply);
        expect(sent.code).toBe(502);
        expect(errOf(sent.payload).message).toBe('coins grant failed, retry');
        expect((await saves.findOne({ _id: ACC }))?.save.wallet.coins).toBe(0);
      });
    });

    it('a stamina-kind slot is applied inside the claim write itself and recorded in the material ledger', async () => {
      await withCheckinSlot1({ kind: 'stamina', count: 5 }, async () => {
        const { cols } = makeCols(makeNewSave(ACC, NOW));
        const core = new MetaCore(makeDeps(cols, makeCommercial().client));
        const { sent, reply } = makeReply();
        const out = (await claimCheckinHandler(core, req(), reply)) as { data: { save: SaveData } };
        expect(sent.code).toBeUndefined();
        expect(out.data.save.materials['stamina']).toBe(5);
        const ledger = await (cols.materialInstances as unknown as FakeCollection<{ _id: string }>).findOne({});
        expect(ledger).not.toBeNull(); // provenance row keyed by (account, month, day)
      });
    });

    it('day 14 card milestone whose grantCard fails -> 502 and no card in the roster (claim recorded, delivery retryable)', async () => {
      const { cols, saves } = makeCols(saveWithCheckin([...Array(13).keys()].map((i) => i + 1), YESTERDAY_KEY));
      const core = new MetaCore(makeDeps({ ...cols, saves: failGrantWrites(saves, 'cardInvCount') } as unknown as Collections, makeCommercial().client));
      const { sent, reply } = makeReply();
      await claimCheckinHandler(core, req(), reply);
      expect(sent.code).toBe(502);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      const after = (await saves.findOne({ _id: ACC }))!.save;
      expect(after.retention?.checkin?.claimedDays).toContain(14);
      // The roster count never moved, so the card is genuinely undelivered (grantCard is idempotent by
      // instance id, so the retry that follows re-delivers this same pick rather than a second one).
      expect(after.cardInvCount).toBe(0);
    });

    it('month fully claimed on a day that was NOT claimed today -> plain 409 "month fully claimed", no recovery attempt', async () => {
      // The other side of the MONTH_FULL disambiguation test/liveops-retention-unit.test.ts covers:
      // claimedDays is already 30 but the last claim was yesterday, so there is nothing to re-deliver
      // and the 409 is the genuine "come back next month" refusal.
      const { cols } = makeCols(saveWithCheckin([...Array(30).keys()].map((i) => i + 1), YESTERDAY_KEY));
      const comm = makeCommercial();
      const core = new MetaCore(makeDeps(cols, comm.client));
      const { sent, reply } = makeReply();
      await claimCheckinHandler(core, req(), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).message).toBe('month fully claimed');
      expect(comm.state.grants).toEqual([]); // no bonus re-delivery was even attempted
    });

    it('already-claimed-today retry whose bonus re-delivery fails again -> 502 (still retryable, never a silent loss)', async () => {
      const orderId = `checkin:bonus:${ACC}:${makeMonthKey(NOW)}:7`;
      const { cols } = makeCols(saveWithCheckin([1, 2, 3, 4, 5, 6, 7], makeDayKey(NOW)));
      const comm = makeCommercial({ failOrderIds: [orderId] });
      const core = new MetaCore(makeDeps(cols, comm.client));
      const { sent, reply } = makeReply();
      await claimCheckinHandler(core, req(), reply);
      expect(sent.code).toBe(502);
      expect(errOf(sent.payload).message).toBe('bonus coins grant failed, retry');
      expect(comm.state.grants).toEqual([orderId]); // the recovery branch did re-attempt the same order
    });

    it('check-in that loses every rev race -> 409 REV_CONFLICT with nothing claimed', async () => {
      const { cols, saves } = makeCols(makeNewSave(ACC, NOW));
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as unknown as Collections, makeCommercial().client));
      const { sent, reply } = makeReply();
      await claimCheckinHandler(core, req(), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      expect((await saves.findOne({ _id: ACC }))?.save.retention).toBeUndefined();
    });
  });

  // ── POST /retention/daily/claim ───────────────────────────────────────────────────────────────
  describe('claimDailyRewardHandler', () => {
    it('commercial not configured -> 503 before any state is read', async () => {
      const { cols } = makeCols(saveWithDaily(3, false));
      const core = new MetaCore(makeDeps(cols, makeCommercial({ available: false }).client));
      const { sent, reply } = makeReply();
      await claimDailyRewardHandler(core, req(), reply);
      expect(sent.code).toBe(503);
      expect(errOf(sent.payload).code).toBe('NOT_IMPLEMENTED');
    });

    it('already-claimed retry whose grant fails again -> 409 (the claim flag stays set, coins still undelivered)', async () => {
      const orderId = `daily:${ACC}:${makeDayKey(NOW)}`;
      const { cols } = makeCols(saveWithDaily(3, true));
      const comm = makeCommercial({ failOrderIds: [orderId] });
      const core = new MetaCore(makeDeps(cols, comm.client));
      const { sent, reply } = makeReply();
      await claimDailyRewardHandler(core, req(), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).message).toBe('daily reward already claimed');
      expect(comm.state.grants).toEqual([orderId]); // the same deterministic order was retried, not a new one
      expect(comm.state.coins).toBe(0);
    });

    it('daily claim that loses every rev race -> 409 REV_CONFLICT, no coins granted', async () => {
      const { cols, saves } = makeCols(saveWithDaily(3, false));
      const comm = makeCommercial();
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as unknown as Collections, comm.client));
      const { sent, reply } = makeReply();
      await claimDailyRewardHandler(core, req(), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      expect(comm.state.grants).toEqual([]);
      expect((await saves.findOne({ _id: ACC }))?.save.retention?.daily?.rewardClaimed).toBe(false);
    });
  });

  // ── POST /retention/weekly/claim ──────────────────────────────────────────────────────────────
  describe('claimWeeklyChestHandler', () => {
    it('already-claimed equipment tier whose re-delivery fails again -> 502 (tier stays claimed, item still owed)', async () => {
      const { cols, saves } = makeCols(saveWithWeekly(15, [15]));
      const core = new MetaCore(makeDeps({ ...cols, saves: failGrantWrites(saves, 'equipmentInvCount') } as unknown as Collections, makeCommercial().client));
      const { sent, reply } = makeReply();
      await claimWeeklyChestHandler(core, req({ threshold: 15 }), reply);
      expect(sent.code).toBe(502);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      expect((await saves.findOne({ _id: ACC }))?.save.equipmentInvCount).toBe(0); // slot never reserved -> item still owed
      // The pick itself is persisted uncommitted, so the next retry delivers the SAME item.
      const idem = await (cols.equipmentIdem as unknown as FakeCollection<{ _id: string; committed: boolean }>).findOne({});
      expect(idem?.committed).toBe(false);
    });

    it('weekly-chest claim that loses every rev race -> 409 REV_CONFLICT, tier not marked claimed', async () => {
      const { cols, saves } = makeCols(saveWithWeekly(9, []));
      const core = new MetaCore(makeDeps({ ...cols, saves: alwaysLosingSaves(saves) } as unknown as Collections, makeCommercial().client));
      const { sent, reply } = makeReply();
      await claimWeeklyChestHandler(core, req({ threshold: 9 }), reply);
      expect(sent.code).toBe(409);
      expect(errOf(sent.payload).code).toBe('REV_CONFLICT');
      expect((await saves.findOne({ _id: ACC }))?.save.retention?.weekly?.claimedTiers).toEqual([]);
    });
  });

  // ── helpers.ts: deliverRetentionReward ────────────────────────────────────────────────────────
  describe('deliverRetentionReward', () => {
    it('lost the insert race and the read-back still comes back empty -> refuses with a retryable error, never delivers a blind pick', async () => {
      // The concurrent winner's doc is not visible to us (a read against a lagging secondary, or the
      // TTL sweeper removing it in between). Delivering our own pick here would hand out a second,
      // different item for one claim — so the caller must get a retryable refusal instead.
      const { cols } = makeCols(makeNewSave(ACC, NOW));
      const raceIdem = {
        findOne: async () => null,
        updateOne: async () => ({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }),
        insertOne: async () => {
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        },
      };
      const deps = makeDeps({ ...cols, equipmentIdem: raceIdem } as unknown as Collections, makeCommercial().client);
      const r = await deliverRetentionReward(deps, ACC, 'order-lost-race', 'weekly_chest', () => ({
        kind: 'card', defId: 'card_x',
        instance: { id: 'inst-x', defId: 'card_x', level: 1, gear: {}, locked: false },
      }));
      expect(r).toEqual({ error: 'reward grant failed, retry', code: 'REV_CONFLICT' });
      expect((cols.cardInstances as unknown as FakeCollection<{ _id: string }>).docs.size).toBe(0);
    });
  });
});
