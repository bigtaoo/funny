// Branch-coverage backfill for the four audit/enforcement modules (group D, 2026-09-03):
// src/anticheatAudit.ts, src/coinAnomalyAudit.ts, src/moderation.ts, src/reputationDecay.ts.
//
// Every branch here decides what the ONE durable record of an operator / anti-cheat action says. The
// existing unit suites cover the happy paths and most failure paths; what is left is the set where the
// record could end up asserting something that did not happen — a review row claiming a rollback that
// was never written, a "skipped" verdict that forgets which peer judge produced it, an escalation
// computed from an account document that has no moderation flags at all.
import { describe, it, expect } from 'vitest';
import type {
  Collections, MatchDoc, MatchReplayDoc, SaveData, AntiCheatReviewDoc, ReplayBlobDoc,
} from '@nw/shared';
import { compressReplayDoc, makeNewSave } from '@nw/shared';
import type { GatewayClient, JudgeRes } from '../src/gatewayClient.js';
import { auditOnce } from '../src/anticheatAudit.js';
import { auditCoinAnomaliesOnce } from '../src/coinAnomalyAudit.js';
import { applyPenalty } from '../src/moderation.js';
import { decayReputationOnce } from '../src/reputationDecay.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial } from './helpers/fakeClients.js';

const now = () => 1000;

class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, statsJson: '{}' };
  async judge(): Promise<JudgeRes> { return this.next; }
  async push(): Promise<void> {}
}

interface SaveDoc { _id: string; save: SaveData; rev: number }

function makeCols() {
  const saves = new FakeCollection<SaveDoc>();
  const matches = new FakeCollection<MatchDoc & { _id: string }>();
  const replayBlobs = new FakeCollection<ReplayBlobDoc & { _id: string }>();
  const antiCheatReviews = new FakeCollection<AntiCheatReviewDoc>();
  const cols = { saves, matches, replayBlobs, antiCheatReviews } as unknown as Collections;
  return { cols, saves, matches, replayBlobs, antiCheatReviews };
}

function seedSave(saves: FakeCollection<SaveDoc>, accountId: string, stats?: SaveData['stats'], statSuspicion?: number): void {
  const save = makeNewSave(accountId, now());
  if (stats) save.stats = stats;
  if (statSuspicion !== undefined) save.antiCheat = { statSuspicion };
  saves.seed({ _id: accountId, save, rev: save.rev });
}

function embeddedReplay(): Buffer {
  const replay: MatchReplayDoc = {
    engineVersion: 1, mode: 'ranked', seed: '12345', endFrame: 1, frames: [], meta: { recordedAt: 1, winner: 0 },
  };
  return compressReplayDoc(replay);
}

function seedMatch(
  matches: FakeCollection<MatchDoc & { _id: string }>,
  roomId: string,
  reportedStats: MatchDoc['reportedStats'],
  opts: { accounts?: [string, string]; publicIds?: boolean } = {},
): void {
  const accounts = opts.accounts ?? ['acctA', 'acctB'];
  const withPublicIds = opts.publicIds ?? true;
  matches.seed({
    _id: roomId, roomId, mode: 'ranked', seed: '12345',
    players: [
      { side: 0, accountId: accounts[0]!, ...(withPublicIds ? { publicId: '100000001' } : {}) },
      { side: 1, accountId: accounts[1]!, ...(withPublicIds ? { publicId: '100000002' } : {}) },
    ],
    winner: 0, reason: 'base', hashOk: true,
    replayGz: embeddedReplay(),
    reportedStats, ts: 1,
  } as MatchDoc & { _id: string });
}

describe('anticheatAudit: what the durable review record says when the conviction cannot complete', () => {
  const deps = (cols: Collections, gateway: GatewayClient, over?: Record<string, unknown>) => ({
    cols, gateway, now, rand: () => 0, ...over,
  });

  it('the flagged account has no save document at all → review row is withdrawn, verdict is not "overclaim"', async () => {
    // A deleted/never-created save makes the rollback impossible. The record must not survive claiming a
    // rollback happened, and the match must not be marked as a confirmed overclaim on that basis — it is
    // left as clean so a later round can re-decide with real data.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ examined: 1, audited: 1, flagged: 0 });
    expect(await antiCheatReviews.findOne({ _id: 'r1:acctA' })).toBeNull();
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('no rand injected → Math.random is used (p0:1 makes that deterministic)', async () => {
    // The production default path: deps.rand exists only so tests can pin sampling. Nothing exercised
    // the default, so a regression that made the fallback undefined would have thrown only in prod.
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 10 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 10 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce({ cols, gateway, now, p0: 1 });
    expect(res).toMatchObject({ examined: 1, audited: 1, skipped: 0 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('a skipped verdict still records WHICH peer judge produced it', async () => {
    // Without judgeAccountId on the skip, a peer that fails every re-computation it is handed is
    // indistinguishable from a corpus of broken replays — the exact question ops asks when skips spike.
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: false, judgeAccountId: 'judge-flaky' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, skipped: 1 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited).toMatchObject({ verdict: 'skipped', judgeAccountId: 'judge-flaky' });
  });

  it('the judge returned no stats for the flagged side → the review records an empty authoritative map', async () => {
    // "Recomputed to nothing" is a different claim from "recomputed to a lower number", and the review
    // row is the only place a human ever sees which one it was.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"1":{}}' }; // side 0 missing entirely

    const res = await auditOnce(deps(cols, gateway));
    expect(res.flagged).toBe(1);
    const review = await antiCheatReviews.findOne({ _id: 'r1:acctA' });
    expect(review?.authoritative).toEqual({});
    expect(review?.overclaim).toEqual({ 'kill.archer': 50 });
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(0);
  });

  it('a player row with no publicId files a review keyed on accountId only (no `publicId: undefined`)', async () => {
    // Ops search the queue by publicId; an explicit undefined would break that index rather than simply
    // being absent for the handful of rows that predate publicId being recorded on match players.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} }, { publicIds: false });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps(cols, gateway));
    const review = await antiCheatReviews.findOne({ _id: 'r1:acctA' });
    expect(review).toBeTruthy();
    expect('publicId' in review!).toBe(false);
  });

  it('a review insert failing for any reason other than the dup-key lock aborts the match, leaving it re-sampleable', async () => {
    // 11000 means "already handled"; anything else (e.g. Mongo unreachable) must NOT be swallowed as
    // "already handled", or the match would be marked audited with no record of the conviction.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    antiCheatReviews.insertOne = async () => {
      throw Object.assign(new Error('not primary'), { code: 10107 });
    };
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ examined: 1, audited: 0, flagged: 0 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited).toBeUndefined();
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(50); // untouched
  });

  it('a side that reported nothing is NOT convicted when the judge returns a NEGATIVE stat for it', async () => {
    // The judge is an arbitrary online peer. Before compareAudit clamped its inputs (2026-09-03), it
    // computed reported(0) - authoritative(-5) = an "overclaim" of 5 against a player who reported
    // nothing at all — landing as a real stat rollback, a statSuspicion increment, and an open OPS
    // review row a human then had to un-pick. One malicious judge, one innocent player, per match.
    // Also the clean-verdict path for `doc.reportedStats?.[side] ?? {}`: side 0 is absent from the map.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 7 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '1': {} }); // side 0 reported nothing
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":-5},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res.flagged).toBe(0);
    expect(await antiCheatReviews.findOne({ _id: 'r1:acctA' })).toBeNull();
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(7); // untouched
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it("a side missing from the judge's own stats map is treated as zeros, not as a conviction", async () => {
    // `parsed[side] ?? {}`: the judge answered for side 1 only. A side it said nothing about must fall
    // through as "authoritative 0 for everything" — which for a side that also reported nothing is
    // clean, and for one that reported 40 is the full overclaim (covered by the next test).
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA');
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': {}, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"1":{}}' }; // side 0 entirely absent

    const res = await auditOnce(deps(cols, gateway));
    expect(res.flagged).toBe(0);
    expect(await antiCheatReviews.findOne({ _id: 'r1:acctA' })).toBeNull();
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('convicting an account that has no stats to roll back records rolledBack:{} and leaves stats absent', async () => {
    // applyRollback returns the previous stats object untouched when there is nothing to deduct — for a
    // save that never accrued any stats that is `undefined`, and the spread guard is what stops an empty
    // `stats: undefined` from being written over the save. The review row is then honest about it: a
    // confirmed overclaim of 40 with a rollback of nothing, which is what tells ops the deduction still
    // has to be applied somewhere else (or that the report was against a wiped account).
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA'); // no stats at all
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res.flagged).toBe(1);
    const review = await antiCheatReviews.findOne({ _id: 'r1:acctA' });
    expect(review?.overclaim).toEqual({ 'kill.archer': 40 });
    expect(review?.rolledBack).toEqual({});
    const save = (await saves.findOne({ _id: 'acctA' }))?.save;
    expect(save?.stats).toBeUndefined();
    expect(save?.antiCheat?.statSuspicion).toBe(1); // the escalation still lands
  });

  it('an antiCheat sub-document with no statSuspicion escalates from 0, not to NaN', async () => {
    // `?? 0` on a legacy/partial antiCheat shape. `undefined + 1` would write NaN, and NaN > 0 is false
    // — the account would silently drop back to the base sampling tier, i.e. a confirmed cheater would
    // stop being sampled more often, which is the exact opposite of what the escalation is for.
    const { cols, saves, matches } = makeCols();
    const save = makeNewSave('acctA', now());
    save.stats = { 'kill.archer': 50 };
    save.antiCheat = { lastFlaggedTs: 500 } as unknown as SaveData['antiCheat'];
    saves.seed({ _id: 'acctA', save, rev: save.rev });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps(cols, gateway));
    expect((await saves.findOne({ _id: 'acctA' }))?.save.antiCheat?.statSuspicion).toBe(1);
  });

  it('a repeat offender escalates on top of the existing statSuspicion instead of resetting it', async () => {
    // statSuspicion is what raises this account's future sampling rate; resetting it to 1 on every new
    // conviction would quietly demote a serial cheater back to the first-offence tier.
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 }, 2);
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps(cols, gateway));
    expect((await saves.findOne({ _id: 'acctA' }))?.save.antiCheat?.statSuspicion).toBe(3);
    expect((await antiCheatReviews.findOne({ _id: 'r1:acctA' }))?.suspicionAfter).toBe(3);
  });
});

// ── coinAnomalyAudit: one unfileable row must not swallow the rest of the day's batch ──────────────
interface AccountRow { _id: string; createdAt: number; publicId?: string }

describe('coinAnomalyAudit insert failures', () => {
  it('a non-dup insert error is logged and the remaining flagged accounts are still filed', async () => {
    // The daily sweep is the only thing that puts coin anomalies in front of a human. A transient write
    // failure on one account must not cost the rest of the day's findings — they would never be
    // re-scanned, since the sweep only ever looks at yesterday.
    const accounts = new FakeCollection<AccountRow>().seed(
      { _id: 'acc-bad', createdAt: 0, publicId: '100000001' },
      { _id: 'acc-good', createdAt: 0 },
    );
    const antiCheatReviews = new FakeCollection<AntiCheatReviewDoc>();
    const realInsert = antiCheatReviews.insertOne.bind(antiCheatReviews);
    antiCheatReviews.insertOne = async (doc: AntiCheatReviewDoc) => {
      if (doc.accountId === 'acc-bad') throw Object.assign(new Error('not primary'), { code: 10107 });
      return realInsert(doc);
    };
    const cols = { accounts, antiCheatReviews } as unknown as Collections;
    const commercial = fakeCommercial();
    const NOW = Date.UTC(2026, 8, 3, 12);
    const dayKey = '2026-09-02';
    commercial.coinGainsByDay.set(dayKey, [
      { accountId: 'acc-bad', nonRechargeGain: 99_999 },
      { accountId: 'acc-good', nonRechargeGain: 88_888 },
    ]);

    const res = await auditCoinAnomaliesOnce({ cols, commercial, now: () => NOW, threshold: 1000 });
    expect(res).toEqual({ dayKey, scanned: 2, flagged: 1 });
    expect(await antiCheatReviews.findOne({ _id: `coin:acc-good:${dayKey}` })).toMatchObject({
      kind: 'coin_anomaly', nonRechargeGain: 88_888, threshold: 1000, status: 'open',
    });
    expect(await antiCheatReviews.findOne({ _id: `coin:acc-bad:${dayKey}` })).toBeNull();
  });
});

// ── moderation / reputationDecay: an account document with no moderation flags yet ─────────────────
interface ModAccountDoc {
  _id: string;
  createdAt: number;
  flags?: {
    reputationScore?: number;
    reputationDecayAt?: number;
    moderationRev?: number;
    banned?: boolean;
    bannedUntil?: number;
    mutedUntil?: number;
  };
}

/**
 * FakeCollection matches with strict `===`, but both modules' CAS filter is
 * `{'flags.moderationRev': doc.flags?.moderationRev ?? null}` — and on a real Mongo document that has
 * never had moderation flags written, that `null` clause legitimately matches the missing field. This
 * wrapper reproduces exactly that one Mongo semantic (null also matches absent) on the fake, which is
 * what lets the "account with no flags at all" case below be a unit test instead of needing real Mongo.
 */
function makeModCols(seed: ModAccountDoc[] = []): { cols: Collections; accounts: FakeCollection<ModAccountDoc> } {
  const accounts = new FakeCollection<ModAccountDoc>();
  if (seed.length) accounts.seed(...seed);
  const realUpdateOne = accounts.updateOne.bind(accounts);
  accounts.updateOne = async (filter, update, opts) => {
    const relaxed = { ...filter };
    if (relaxed['flags.moderationRev'] === null) delete relaxed['flags.moderationRev'];
    return realUpdateOne(relaxed, update, opts);
  };
  return { cols: { accounts } as unknown as Collections, accounts };
}

describe('applyPenalty on an account that has never carried moderation flags', () => {
  it('a first-ever penalty starts from score 100 / rev 0 and writes both, plus the decay clock', async () => {
    // This is EVERY account's first penalty: `flags` does not exist yet, so both the score baseline and
    // the optimistic-lock revision come from the `?? 100` / `?? 0` fallbacks. Getting the baseline wrong
    // here would put a first-time offender straight into a harsher tier than §4.2 prescribes.
    const { cols, accounts } = makeModCols([{ _id: 'fresh', createdAt: 0 }]);
    const res = await applyPenalty(cols, 'fresh', -45, 5_000);
    expect(res).toEqual({ reputationScore: 55, action: 'mute', mutedUntil: 5_000 + 24 * 3_600_000 });
    const doc = await accounts.findOne({ _id: 'fresh' });
    expect(doc?.flags?.moderationRev).toBe(1);
    expect(doc?.flags?.reputationScore).toBe(55);
    expect(doc?.flags?.reputationDecayAt).toBe(5_000 + 30 * 24 * 3_600_000);
  });
});

describe('decayReputationOnce edge documents', () => {
  it('the account disappears between the sweep scan and its own re-read → not healed, no write', async () => {
    // A batch is scanned first and processed one by one, so an account deleted mid-sweep is normal. The
    // per-account re-read is what keeps the sweep from resurrecting flags on a deleted account.
    const { cols, accounts } = makeModCols([{ _id: 'vanishing', createdAt: 0, flags: { reputationScore: 60, reputationDecayAt: 1000 } }]);
    accounts.findOne = async () => null;
    const res = await decayReputationOnce({ cols, now: () => 2000 });
    expect(res).toEqual({ scanned: 1, healed: 0 });
  });

  it('a due account with only reputationDecayAt set heals from the default 100 and clears its clock', async () => {
    // Reachable when reputationDecayAt was written by a path that never wrote a score (or the score was
    // cleared by an appeal): the account is treated as unpenalized, healed to the 100 cap, and taken out
    // of the scan set entirely rather than being re-visited every 30 days forever.
    const { cols, accounts } = makeModCols([{ _id: 'clockonly', createdAt: 0, flags: { reputationDecayAt: 1000 } }]);
    const res = await decayReputationOnce({ cols, now: () => 2000 });
    expect(res).toEqual({ scanned: 1, healed: 1 });
    const doc = await accounts.findOne({ _id: 'clockonly' });
    expect(doc?.flags?.reputationScore).toBe(100);
    expect(doc?.flags?.moderationRev).toBe(1); // rev advanced from the `?? 0` baseline
    expect(doc?.flags?.reputationDecayAt).toBeUndefined();
  });
});
