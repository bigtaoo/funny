// Unit-style coverage backfill for src/anticheatAudit.ts (2026-08-14 test-coverage task). The business
// logic here is already exercised end-to-end by test/anticheat-audit.e2e.test.ts, but that file imports
// `auditOnce`/`buildApp` from '../dist/*.js' (compiled output) — vitest's v8 coverage provider only
// attributes execution to src/*.ts when the module was loaded through vitest's own transform, so running
// the compiled dist through Node's loader records zero coverage against src/anticheatAudit.ts even though
// the same logic runs. This file imports `auditOnce` directly from '../src/anticheatAudit.js' and
// re-exercises the same scenarios (backed by FakeCollection — this module's Mongo usage is plain
// findOne/updateOne/findOneAndUpdate/insertOne/deleteOne + a sort/limit cursor, all of which
// test/helpers/fakeCollection.ts supports, so no real Mongo is needed), plus the branches the e2e
// happy-path suite didn't reach: replayRef→replayBlobs fallback, no-replay-at-all skip, malformed judge
// statsJson, a duplicate-review-lock replay (idempotent-lock hit), a rollback-write failure, and the
// per-match/mark-audited best-effort catch branches.
import { describe, it, expect } from 'vitest';
import type { Collections, MatchDoc, MatchReplayDoc, SaveData, AntiCheatReviewDoc, ReplayBlobDoc } from '@nw/shared';
import { compressReplayDoc, makeNewSave } from '@nw/shared';
import type { GatewayClient, JudgeReq, JudgeRes } from '../src/gatewayClient.js';
import { auditOnce } from '../src/anticheatAudit.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const now = () => 1000;

class FakeGateway implements GatewayClient {
  available = true;
  next: JudgeRes = { ok: true, statsJson: '{}', judgeAccountId: 'judge-1' };
  last?: JudgeReq;
  async judge(req: JudgeReq): Promise<JudgeRes> {
    this.last = req;
    return this.next;
  }
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
  if (statSuspicion) save.antiCheat = { statSuspicion };
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
  opts: { accounts?: [string, string]; ts?: number; noReplay?: boolean; replayRef?: string } = {},
): void {
  const accounts = opts.accounts ?? ['acctA', 'acctB'];
  const replayField = opts.replayRef
    ? { replayRef: opts.replayRef }
    : opts.noReplay
      ? {}
      : { replayGz: embeddedReplay() };
  matches.seed({
    _id: roomId,
    roomId,
    mode: 'ranked',
    seed: '12345',
    players: [
      { side: 0, accountId: accounts[0]!, publicId: '100000001' },
      { side: 1, accountId: accounts[1]!, publicId: '100000002' },
    ],
    winner: 0,
    reason: 'base',
    hashOk: true,
    ...replayField,
    reportedStats,
    ts: opts.ts ?? 1,
  } as MatchDoc & { _id: string });
}

describe('auditOnce (src import, coverage backfill)', () => {
  const deps = (cols: Collections, gateway: GatewayClient, over?: Record<string, unknown>) => ({
    cols, gateway, now, rand: () => 0, ...over,
  });

  it('no judge available: all zeros returned, match stays unaudited', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.available = false;

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ examined: 0, audited: 0, flagged: 0, skipped: 0 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited).toBeUndefined();
  });

  it('overclaim: rollback excess + statSuspicion=1 + lastFlaggedTs + review record + overclaim marker', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}', judgeAccountId: 'judge-1' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ examined: 1, audited: 1, flagged: 1, skipped: 0 });

    const a = await saves.findOne({ _id: 'acctA' });
    expect(a?.save.stats?.['kill.archer']).toBe(10);
    expect(a?.save.antiCheat?.statSuspicion).toBe(1);
    expect(a?.save.antiCheat?.lastFlaggedTs).toBe(1000);

    const reviews = await antiCheatReviews.find({ accountId: 'acctA' }).toArray();
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.overclaim).toEqual({ 'kill.archer': 40 });
    expect(reviews[0]!.rolledBack).toEqual({ 'kill.archer': 40 });
    expect(reviews[0]!.suspicionAfter).toBe(1);
    expect(reviews[0]!.status).toBe('open');
    expect(reviews[0]!.judgeAccountId).toBe('judge-1');

    const match = await matches.findOne({ _id: 'r1' });
    expect(match?.audited?.verdict).toBe('overclaim');
    expect(match?.audited?.overclaim).toEqual({ '0': { 'kill.archer': 40 } });
  });

  it('idempotent rerun: already-audited match is not re-processed', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    await auditOnce(deps(cols, gateway));
    const res2 = await auditOnce(deps(cols, gateway));
    expect(res2).toMatchObject({ examined: 0, flagged: 0 });
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(10);
    expect((await antiCheatReviews.find({ accountId: 'acctA' }).toArray()).length).toBe(1);
  });

  it('clean: report matches recompute → no review, no suspicion increase, marked clean', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 10 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 10 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 0 });
    expect((await saves.findOne({ _id: 'acctA' }))?.save.antiCheat).toBeUndefined();
    expect((await antiCheatReviews.find({ accountId: 'acctA' }).toArray()).length).toBe(0);
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('judge failure (ok:false) → marked skipped, no rollback or suspicion increase', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: false };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 1 });
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(50);
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('skipped');
  });

  it('judge ok but statsJson is malformed JSON → parsePerSideStats null → marked skipped', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: 'not json{{{' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, flagged: 0, skipped: 1 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('skipped');
  });

  it('judge ok but statsJson is a JSON scalar (not an object) → parsePerSideStats null → skipped', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '42' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res.skipped).toBe(1);
  });

  it('judge ok with statsJson undefined → parsePerSideStats short-circuits null → skipped', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true }; // no statsJson at all

    const res = await auditOnce(deps(cols, gateway));
    expect(res.skipped).toBe(1);
  });

  it('underreport: player reported < recomputed → clean (no retroactive credit)', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 5 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 5 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":20},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ flagged: 0 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('suspicion-weighted sampling: clean account match skipped, flagged account match sampled', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'cleanA');
    seedSave(saves, 'cleanB');
    seedMatch(matches, 'rc', { '0': {}, '1': {} }, { accounts: ['cleanA', 'cleanB'], ts: 1 });
    seedSave(saves, 'acctF', { 'kill.archer': 50 }, 1);
    seedSave(saves, 'acctG');
    seedMatch(matches, 'rf', { '0': { 'kill.archer': 50 }, '1': {} }, { accounts: ['acctF', 'acctG'], ts: 2 });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway, { rand: () => 0.1, sampleLimit: 10 }));
    expect(res.examined).toBe(2);
    expect(res.audited).toBe(1);
    expect((await matches.findOne({ _id: 'rc' }))?.audited).toBeUndefined();
    expect((await matches.findOne({ _id: 'rf' }))?.audited?.verdict).toBe('overclaim');
  });

  it('rollback floor at 0: overclaim of 40 but current stat only 20 → clamped to 0, rolledBack=20', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 20 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 60 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":20},"1":{}}' };

    await auditOnce(deps(cols, gateway));
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(0);
    const reviews = await antiCheatReviews.find({ accountId: 'acctA' }).toArray();
    expect(reviews[0]!.overclaim).toEqual({ 'kill.archer': 40 });
    expect(reviews[0]!.rolledBack).toEqual({ 'kill.archer': 20 });
  });

  it('replayGz absent but replayRef set → falls back to replayBlobs collection', async () => {
    const { cols, saves, matches, replayBlobs } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} }, { replayRef: 'blob-1' });
    replayBlobs.seed({ _id: 'blob-1', replayGz: embeddedReplay(), ts: 1 });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, flagged: 1 });
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('overclaim');
  });

  it('no replay at all (no replayGz, no replayRef, no blob) → marked skipped without calling the judge', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} }, { noReplay: true });
    const gateway = new FakeGateway();
    let judgeCalled = false;
    gateway.judge = async () => { judgeCalled = true; return { ok: true, statsJson: '{}' }; };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, skipped: 1 });
    expect(judgeCalled).toBe(false);
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('skipped');
  });

  it('replayRef set but the referenced blob is missing → treated as no replay → skipped', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} }, { replayRef: 'missing-blob' });
    const gateway = new FakeGateway();

    const res = await auditOnce(deps(cols, gateway));
    expect(res.skipped).toBe(1);
  });

  it('review-first idempotent lock: a pre-existing review record for this room+account short-circuits flagOverclaim (no double rollback)', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    // Pre-seed the review row this run would otherwise insert (simulates a prior round's rollback already having happened).
    antiCheatReviews.seed({
      _id: 'r1:acctA', roomId: 'r1', accountId: 'acctA', side: 0,
      reported: {}, authoritative: {}, overclaim: {}, rolledBack: { 'kill.archer': 40 },
      suspicionAfter: 1, status: 'open', ts: 500,
    });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    // flagOverclaim returns null (duplicate lock) → not counted as flagged, and the save is untouched.
    expect(res.flagged).toBe(0);
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(50);
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('rollback write fails (rev conflict exhausted): flagOverclaim releases the lock (deletes the just-inserted review) and is not counted as flagged', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    // Force every findOneAndUpdate on saves to report "not found" (simulating rev-conflict exhaustion across all 3 retries).
    saves.findOneAndUpdate = async () => null;
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res.flagged).toBe(0);
    // The review lock row must have been deleted again (not left stranded).
    expect(await antiCheatReviews.findOne({ _id: 'r1:acctA' })).toBeNull();
    expect((await matches.findOne({ _id: 'r1' }))?.audited?.verdict).toBe('clean');
  });

  it('review backfill write throws → best-effort caught, does not fail the batch (rolledBack/suspicionAfter stay at the just-inserted seed values)', async () => {
    const { cols, saves, matches, antiCheatReviews } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 50 }, '1': {} });
    antiCheatReviews.updateOne = async () => { throw new Error('injected backfill failure'); };
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    expect(res).toMatchObject({ audited: 1, flagged: 1 });
    expect((await saves.findOne({ _id: 'acctA' }))?.save.stats?.['kill.archer']).toBe(10); // rollback itself still happened
  });

  it('markAudited write throws → caught and logged, does not fail the batch or rethrow', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 10 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 10 }, '1': {} });
    matches.updateOne = async () => { throw new Error('injected mark-audited failure'); };
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway));
    // The mark write threw and was swallowed by markAudited's own .catch — auditMatch still completes normally.
    expect(res).toMatchObject({ examined: 1, audited: 1 });
  });

  it('per-match exception (e.g. saves.findOne throws mid-match) is caught by auditOnce\'s outer loop and does not abort remaining candidates', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 50 });
    seedSave(saves, 'acctB');
    seedSave(saves, 'acctC', { 'kill.archer': 10 });
    seedSave(saves, 'acctD');
    seedMatch(matches, 'bad', { '0': { 'kill.archer': 50 }, '1': {} }, { accounts: ['acctA', 'acctB'], ts: 1 });
    seedMatch(matches, 'good', { '0': { 'kill.archer': 10 }, '1': {} }, { accounts: ['acctC', 'acctD'], ts: 2 });

    const realFindOne = saves.findOne.bind(saves);
    let calls = 0;
    saves.findOne = async (q: Record<string, unknown>) => {
      calls++;
      if (q._id === 'acctA') throw new Error('injected read failure');
      return realFindOne(q);
    };
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' };

    const res = await auditOnce(deps(cols, gateway, { sampleLimit: 10 }));
    expect(res.examined).toBe(2);
    // 'bad' failed and is left unmarked (re-sample eligible); 'good' still got processed.
    expect((await matches.findOne({ _id: 'bad' }))?.audited).toBeUndefined();
    expect((await matches.findOne({ _id: 'good' }))?.audited?.verdict).toBe('clean');
    expect(calls).toBeGreaterThan(0);
  });

  it('judge verdict without judgeAccountId: the audited mark omits the field (optional-spread branch)', async () => {
    const { cols, saves, matches } = makeCols();
    seedSave(saves, 'acctA', { 'kill.archer': 10 });
    seedSave(saves, 'acctB');
    seedMatch(matches, 'r1', { '0': { 'kill.archer': 10 }, '1': {} });
    const gateway = new FakeGateway();
    gateway.next = { ok: true, statsJson: '{"0":{"kill.archer":10},"1":{}}' }; // no judgeAccountId

    await auditOnce(deps(cols, gateway));
    const match = await matches.findOne({ _id: 'r1' });
    expect(match?.audited?.verdict).toBe('clean');
    expect(match?.audited && 'judgeAccountId' in match.audited).toBe(false);
  });

  it('sampleLimit bounds the candidate batch (only the oldest N are examined)', async () => {
    const { cols, saves, matches } = makeCols();
    for (let i = 0; i < 3; i++) {
      seedSave(saves, `acct${i}`);
      seedSave(saves, `acct${i}b`);
      seedMatch(matches, `m${i}`, { '0': {}, '1': {} }, { accounts: [`acct${i}`, `acct${i}b`], ts: i });
    }
    const gateway = new FakeGateway();
    const res = await auditOnce(deps(cols, gateway, { sampleLimit: 2 }));
    expect(res.examined).toBe(2);
  });
});
