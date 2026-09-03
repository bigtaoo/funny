// Branch-coverage backfill for src/internal/matchReport/reportRoute.ts (2026-09-03).
// The existing HTTP tests all send a well-formed, authenticated, small-replay report against healthy
// dependencies, so what was left unexercised is exactly the set of degraded shapes an operator meets
// in production: an unauthenticated/malformed report, a reservation whose TTL fired mid-settlement, a
// settlement or peer judge that threw, a replay too big to inline, and a report for accounts that do
// (or do not) have an identity snapshot to freeze into match history. Each test asserts what actually
// lands in `matches` — that document is the whole audit trail for a disputed or unsettled match.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { compressReplayDoc, makeNewSave, type Collections, type MatchReplayDoc, type SaveDoc } from '@nw/shared';
import { registerReportRoute } from '../src/internal/matchReport/reportRoute.js';
import { REPLAY_INLINE_MAX_BYTES, MATCH_SETTLING_TAKEOVER_MS, type ReportBody } from '../src/internal/matchReport/types.js';
import type { InternalCtx } from '../src/internal/context.js';
import type { AccountCache } from '../src/accountCache.js';
import type { GatewayClient, JudgeRes } from '../src/gatewayClient.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeGateway, fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

const KEY = 'test-internal-key';
const NOW = 1_700_000_000_000;

interface MatchRec extends Record<string, unknown> { roomId: string }

/**
 * Purpose-built `matches` double. FakeCollection cannot express this flow: it keys every document by
 * `_id`, and both the reservation placeholder and the final MatchDoc are addressed by `roomId` only
 * (a MatchDoc has no `_id` at all). This also needs a *guarded, non-upserting* takeover update and a
 * one-shot findOne miss, which is how the reservation's last-resort TTL firing mid-settlement is
 * simulated deterministically.
 */
class FakeMatches {
  docs: MatchRec[] = [];
  /** Makes the next findOne miss, as if the placeholder's TTL had just expired. */
  hideNextFindOne = false;

  private hit(q: Record<string, unknown>): MatchRec | undefined {
    return this.docs.find((d) =>
      Object.entries(q).every(([k, v]) => {
        if (v !== null && typeof v === 'object' && '$lt' in (v as object)) {
          return (d[k] as number) < (v as { $lt: number }).$lt;
        }
        return d[k] === v;
      }),
    );
  }

  async findOne(q: Record<string, unknown>): Promise<MatchRec | null> {
    if (this.hideNextFindOne) {
      this.hideNextFindOne = false;
      return null;
    }
    return this.hit(q) ?? null;
  }

  async updateOne(
    q: Record<string, unknown>,
    u: { $setOnInsert?: Record<string, unknown>; $set?: Record<string, unknown> },
    opts?: { upsert?: boolean },
  ) {
    const hit = this.hit(q);
    if (hit) {
      if (u.$set) Object.assign(hit, u.$set);
      return { matchedCount: 1, modifiedCount: u.$set ? 1 : 0, upsertedCount: 0 };
    }
    if (opts?.upsert && !this.docs.some((d) => d.roomId === q.roomId)) {
      this.docs.push({ ...(u.$setOnInsert ?? {}) } as MatchRec);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async replaceOne(q: Record<string, unknown>, doc: MatchRec, opts?: { upsert?: boolean }) {
    const i = this.docs.findIndex((d) => d.roomId === q.roomId);
    if (i >= 0) {
      this.docs[i] = doc;
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (opts?.upsert) {
      this.docs.push(doc);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
}

interface AccountRec extends Record<string, unknown> { _id: string }

function build(opts: { gateway?: GatewayClient; accounts?: AccountRec[]; saves?: SaveDoc[] } = {}) {
  const matches = new FakeMatches();
  const accounts = new FakeCollection<AccountRec>().seed(...(opts.accounts ?? []));
  const saves = new FakeCollection<SaveDoc>().seed(...(opts.saves ?? []));
  const replayBlobs = new FakeCollection<{ _id: string }>();
  const cols = {
    matches,
    accounts,
    saves,
    replayBlobs,
    events: new FakeCollection<{ _id: string }>(),
    eventParticipants: new FakeCollection<{ _id: string }>(),
    ladderSeasons: new FakeCollection<{ _id: string }>(),
  } as unknown as Collections;
  const commercial = fakeCommercial(false);
  const ctx: InternalCtx = {
    cols,
    now: () => NOW,
    gateway: opts.gateway ?? fakeGateway(),
    commercial,
    socialsvc: new FakeSocialsvc(),
    authed: (h) => h['x-internal-key'] === KEY,
    redis: null,
    accountCache: {} as AccountCache,
  };
  const app = Fastify();
  registerReportRoute(app, ctx);
  return { app, matches, saves, replayBlobs };
}

function replayGz(doc?: Partial<MatchReplayDoc>): string {
  const full: MatchReplayDoc = {
    engineVersion: 0, mode: 'netplay', seed: '1', endFrame: 0, frames: [], meta: { recordedAt: 0, winner: 0 }, ...doc,
  };
  return compressReplayDoc(full).toString('base64');
}

function report(over: Partial<ReportBody> = {}): ReportBody {
  return {
    room_id: 'R1',
    seed: '1',
    mode: 'ranked',
    reason: 'base',
    winner_side: 0,
    hash_ok: true,
    players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
    results: [{ side: 0, state_hash: 'H', winner_side: 0 }, { side: 1, state_hash: 'H', winner_side: 0 }],
    replay_gz: replayGz(),
    ...over,
  };
}

function post(app: ReturnType<typeof build>['app'], payload: unknown, key: string | null = KEY) {
  return app.inject({
    method: 'POST',
    url: '/internal/match/report',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) },
    payload: JSON.stringify(payload),
  });
}

/** Reads the archived doc for a roomId back out of the double, narrowed to the fields under assertion. */
function archived<T>(matches: FakeMatches, roomId = 'R1'): T {
  const doc = matches.docs.find((d) => d.roomId === roomId);
  if (!doc) throw new Error(`no archived match for ${roomId}`);
  return doc as unknown as T;
}

/** A pair of fresh ranked save docs, so a ranked report can actually settle through the route. */
function rankedSaves(): SaveDoc[] {
  return ['a', 'b'].map((id) => {
    const save = makeNewSave(id, NOW);
    return { _id: id, save, rev: save.rev };
  });
}

describe('reportRoute branch backfill', () => {
  // Only gameserver may report a match result. Without the internal key the request must be rejected
  // before the reservation is taken — otherwise an unauthenticated caller could park a placeholder on
  // a roomId and block the real report from ever settling.
  it('rejects an unauthenticated report without reserving the roomId', async () => {
    const { app, matches } = build();
    const res = await post(app, report(), null);
    expect(res.statusCode).toBe(401);
    expect(matches.docs).toHaveLength(0);
    await app.close();
  });

  // A body that parsed to null (empty/`null` payload) and a body with no room_id are both unusable:
  // roomId is the idempotency key, so without it there is nothing to reserve or dedupe against.
  it('rejects a null body and a body with no room_id', async () => {
    const { app, matches } = build();
    expect((await post(app, null)).statusCode).toBe(400);
    expect((await post(app, { seed: '1', mode: 'ranked' })).statusCode).toBe(400);
    expect(matches.docs).toHaveLength(0);
    await app.close();
  });

  // Reservation race: the upsert reports "already exists", but by the time we read it back the
  // placeholder is gone (its last-resort 1h TTL fired, or an admin purged it). There is nothing left
  // to take over and no way to tell whether the original settlement finished, so the retry must be a
  // plain idempotent ok — never a second settlement.
  it('returns ok without settling when the reservation vanishes before the read-back', async () => {
    const { app, matches, saves } = build();
    // Pre-existing reservation so the upsert matches instead of inserting...
    matches.docs.push({ roomId: 'R1', mode: '__settling__', settling: true, settlingAt: NOW });
    matches.hideNextFindOne = true; // ...but it is gone by the read-back
    const res = await post(app, report());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(saves.docs.size).toBe(0); // no ELO settlement ran
    expect(matches.docs[0]!.mode).toBe('__settling__'); // placeholder untouched, no archive written
    await app.close();
  });

  // Happy ranked path through the route (the counterpart of the throwing case below): the settlement
  // result is both returned to gameserver and frozen onto each archived player row, which is what
  // match history renders as the per-match ELO change.
  it('settles a ranked report and stamps eloDelta on both archived players', async () => {
    const { app, matches } = build({ saves: rankedSaves() });
    const res = await post(app, report());
    expect(res.json()).toEqual({ ok: true, elo: { 0: { delta: 16, after: 1016, rankAfter: 'bronze' }, 1: { delta: -16, after: 984, rankAfter: 'bronze' } } });
    const doc = archived<{ players: { side: number; eloDelta?: number; eloAfter?: number }[] }>(matches);
    expect(doc.players.map((p) => [p.eloDelta, p.eloAfter])).toEqual([[16, 1016], [-16, 984]]);
    await app.close();
  });

  // A gameserver retry arriving while the first attempt is still inside settleElo: the takeover guard
  // refuses (the reservation is young), so the retry returns a bare ok. Settling twice here would
  // double-credit ELO and victory coins — the exact bug the reservation was added for.
  it('dedupes a duplicate report while a settlement is still in flight', async () => {
    const { app, matches, saves } = build({ saves: rankedSaves() });
    matches.docs.push({ roomId: 'R1', mode: '__settling__', settling: true, settlingAt: NOW });
    const res = await post(app, report());
    expect(res.json()).toEqual({ ok: true });
    expect(saves.docs.get('a')!.save.pvp.elo).toBe(1000); // untouched — no second settlement
    expect(matches.docs[0]!.mode).toBe('__settling__');
    await app.close();
  });

  // A stale reservation (previous owner presumably crashed mid-settle) is taken over and settled.
  // Included here because it is the counterpart of the case above: the same "reservation exists"
  // branch, with the takeover guard succeeding rather than being skipped.
  it('takes over a stale reservation and archives the match', async () => {
    const { app, matches } = build();
    matches.docs.push({
      roomId: 'R1', mode: '__settling__', settling: true,
      settlingAt: NOW - MATCH_SETTLING_TAKEOVER_MS - 1,
    });
    const res = await post(app, report({ mode: 'friendly', winner_side: -1 }));
    expect(res.statusCode).toBe(200);
    expect(matches.docs).toHaveLength(1);
    expect(matches.docs[0]!.mode).toBe('friendly'); // placeholder replaced by the real archive doc
    await app.close();
  });

  // Settlement threw (Mongo unavailable mid-settle). The match must still be archived — losing the
  // report entirely would leave the roomId reserved and the match invisible in history — but with no
  // elo in the response and no eloDelta on either player, which is how ops spot an unsettled ranked match.
  it('archives the match with no elo when the ELO settlement throws', async () => {
    const { app, matches, saves } = build();
    saves.findOne = async () => { throw new Error('mongo unavailable'); };
    const res = await post(app, report());
    expect(res.json()).toEqual({ ok: true }); // no `elo` key
    const doc = archived<{ players: Record<string, unknown>[]; mode: string }>(matches);
    expect(doc.mode).toBe('ranked');
    expect(doc.players.every((p) => p.eloDelta === undefined)).toBe(true);
    await app.close();
  });

  // Peer judge convicted a side, but the gateway did not name the judging account. The conviction is
  // still archived (winner flipped to the honest side, `cheat` recorded) with judgeAccountId omitted
  // rather than written as undefined, and the match is NOT flagged hashMismatch — it was adjudicated.
  it('archives an anonymous peer-judge conviction and flips the winner', async () => {
    const verdict: JudgeRes = { ok: true, stateHash: 'HB' }; // matches side 1 → side 0 is the cheater
    const { app, matches } = build({ gateway: fakeGateway({ available: true, res: verdict }) });
    const res = await post(app, report({
      reason: 'mismatch',
      hash_ok: false,
      winner_side: 0,
      results: [{ side: 0, state_hash: 'HA', winner_side: 0 }, { side: 1, state_hash: 'HB', winner_side: 1 }],
    }));
    expect(res.statusCode).toBe(200);
    const doc = archived<{ winner: number; cheat: Record<string, unknown>; hashMismatch?: boolean; expireAt?: Date }>(matches);
    expect(doc.winner).toBe(1); // the honest side wins, regardless of the reported winner_side
    expect(doc.cheat).toEqual({ side: 0, accountId: 'a' });
    expect('judgeAccountId' in doc.cheat).toBe(false);
    expect(doc.hashMismatch).toBeUndefined();
    expect(doc.expireAt).toBeUndefined(); // disputed matches are kept indefinitely for the audit trail
    await app.close();
  });

  // Named judge: the adjudicating account is recorded on the conviction so an appeal can be traced
  // back to who re-computed the match.
  it('records the judging account on a peer-judge conviction', async () => {
    const verdict: JudgeRes = { ok: true, stateHash: 'HA', judgeAccountId: 'judge-1' };
    const { app, matches } = build({ gateway: fakeGateway({ available: true, res: verdict }) });
    await post(app, report({
      reason: 'mismatch',
      hash_ok: false,
      results: [{ side: 0, state_hash: 'HA', winner_side: 0 }, { side: 1, state_hash: 'HB', winner_side: 1 }],
    }));
    const doc = archived<{ winner: number; cheat: Record<string, unknown> }>(matches);
    expect(doc.cheat).toEqual({ side: 1, accountId: 'b', judgeAccountId: 'judge-1' });
    expect(doc.winner).toBe(0);
    await app.close();
  });

  // The peer-judge block threw (here: an undecompressable replay blob). The match must still archive,
  // flagged hashMismatch so it surfaces in /admin/mismatches, with no cheat verdict attached.
  it('flags an unresolved hash mismatch when the peer judge throws', async () => {
    const { app, matches } = build({ gateway: fakeGateway({ available: true, res: { ok: true, stateHash: 'HA' } }) });
    const res = await post(app, report({ reason: 'mismatch', hash_ok: false, replay_gz: 'bm90LWd6aXA=' }));
    expect(res.statusCode).toBe(200);
    const doc = archived<{ hashMismatch?: boolean; cheat?: unknown; expireAt?: Date }>(matches);
    expect(doc.hashMismatch).toBe(true);
    expect(doc.cheat).toBeUndefined();
    expect(doc.expireAt).toBeUndefined();
    await app.close();
  });

  // Identity snapshot: match history shows the name as of archive time, so displayName/publicId must be
  // frozen into the doc when the account has them (the previously covered case was the opposite — a
  // profile lookup that failed and produced neither field).
  it('freezes displayName and publicId into the archived player snapshot', async () => {
    const { app, matches } = build({
      accounts: [
        { _id: 'a', displayName: 'Alice', publicId: '100000001' },
        { _id: 'b', displayName: 'Bob', publicId: '100000002' },
      ],
    });
    await post(app, report({ mode: 'friendly', winner_side: -1 }));
    const doc = archived<{ players: { accountId: string; displayName?: string; publicId?: string }[] }>(matches);
    expect(doc.players).toEqual([
      { side: 0, accountId: 'a', displayName: 'Alice', publicId: '100000001' },
      { side: 1, accountId: 'b', displayName: 'Bob', publicId: '100000002' },
    ]);
    await app.close();
  });

  // Replay larger than REPLAY_INLINE_MAX_BYTES *after* compression: the blob goes to replayBlobs and the
  // match document only keeps a replayRef pointer, so `matches` stays compact. Both collections must
  // carry the same TTL, otherwise the pointer outlives the blob (or vice versa).
  it('stores an oversized replay externally and keeps only a replayRef in the match doc', async () => {
    const { app, matches, replayBlobs } = build();
    // Incompressible random bytes so the base64 payload really exceeds the inline cap post-"compression"
    // (it is sent verbatim; this path never decodes it). winner_side -1 keeps the card-stats accrual off.
    const big = Buffer.alloc(REPLAY_INLINE_MAX_BYTES + 1024, 0);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
    const res = await post(app, report({ mode: 'friendly', winner_side: -1, replay_gz: big.toString('base64') }));
    expect(res.statusCode).toBe(200);
    const doc = archived<{ replayRef?: string; replayGz?: Buffer; expireAt?: Date }>(matches);
    expect(doc.replayRef).toBe('R1');
    expect(doc.replayGz).toBeUndefined();
    const blob = replayBlobs.docs.get('R1') as unknown as { replayGz: Buffer; expireAt?: Date } | undefined;
    expect(blob?.replayGz.byteLength).toBe(big.byteLength);
    expect(blob?.expireAt).toEqual(doc.expireAt);

    // Same size, but disputed (unresolved hash mismatch): neither the match doc nor the external blob
    // may carry a TTL, or the audit trail would expire out from under /admin/mismatches.
    await post(app, report({ room_id: 'R2', mode: 'friendly', winner_side: -1, hash_ok: false, replay_gz: big.toString('base64') }));
    const disputed = archived<{ replayRef?: string; expireAt?: Date }>(matches, 'R2');
    expect(disputed.replayRef).toBe('R2');
    expect(disputed.expireAt).toBeUndefined();
    expect((replayBlobs.docs.get('R2') as unknown as { expireAt?: Date }).expireAt).toBeUndefined();
    await app.close();
  });
});
