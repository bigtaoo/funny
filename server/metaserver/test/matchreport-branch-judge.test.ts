// Branch-coverage backfill for src/internal/matchReport/peerJudge.ts (2026-09-03).
// Phase C adjudication only runs on a hash-mismatched ranked match with a reachable gateway, so the
// HTTP-level tests only ever drive the happy verdict. Every *refusal* path — the ones that decide a
// disputed match is voided rather than someone being convicted of cheating — was unexercised. Each
// test below asserts both the null verdict and whether the judge round-trip was even attempted,
// since that is what an operator sees in /admin/mismatches (unresolved vs. adjudicated).
import { describe, it, expect } from 'vitest';
import type { MatchReplayDoc } from '@nw/shared';
import { judgeMismatch } from '../src/internal/matchReport/peerJudge.js';
import type { ReportBody } from '../src/internal/matchReport/types.js';
import { fakeGateway } from './helpers/fakeClients.js';
import type { GatewayClient, JudgeRes } from '../src/gatewayClient.js';

const REPLAY: MatchReplayDoc = {
  engineVersion: 0,
  mode: 'netplay',
  seed: '1',
  endFrame: 120,
  frames: [{ frame: 30, cmds: [{ side: 0, commands: 'AA==' }] }],
  meta: { recordedAt: 0, winner: 0 },
  // Loadout-gated match: the deck list is forwarded so the judge re-computes with the same card pool
  // (omit it and the judge would simulate the default pool and never reproduce either side's hash).
  decks: { top: ['infantry_1'], bottom: ['archer_1'] },
};

/** Same replay as archived for a non-loadout-gated match (no `decks` field at all). */
const REPLAY_NO_DECKS: MatchReplayDoc = { ...REPLAY, decks: undefined };

/** fakeGateway plus a record of the judge requests actually issued (the fake itself keeps none). */
function recordingGateway(res: JudgeRes): { gateway: GatewayClient; calls: unknown[] } {
  const gateway = fakeGateway({ available: true, res });
  const calls: unknown[] = [];
  const inner = gateway.judge.bind(gateway);
  gateway.judge = async (req) => {
    calls.push(req);
    return inner(req);
  };
  return { gateway, calls };
}

function body(over: Partial<ReportBody> = {}): ReportBody {
  return {
    room_id: 'R1',
    seed: '1',
    mode: 'ranked',
    reason: 'mismatch',
    winner_side: 0,
    hash_ok: false,
    players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
    results: [
      { side: 0, state_hash: 'HA', winner_side: 0 },
      { side: 1, state_hash: 'HB', winner_side: 1 },
    ],
    replay_gz: '',
    ...over,
  };
}

describe('peerJudge branch backfill', () => {
  // Only one side ever reported (the other client died before sending its hash). With nothing to
  // compare against there is no cheater to identify, so the judge is not even asked — the match is
  // voided and stays flagged for admin review instead of costing an innocent player their ELO.
  it('refuses to adjudicate without exactly two reported results', async () => {
    const { gateway, calls } = recordingGateway({ ok: true, stateHash: 'HA', judgeAccountId: 'j' });
    const verdict = await judgeMismatch(gateway, body({ results: [{ side: 0, state_hash: 'HA', winner_side: 0 }] }), REPLAY);
    expect(verdict).toBeNull();
    expect(calls).toHaveLength(0); // no third-party client was burned on an unadjudicable match
  });

  // The judge client answered but produced no state hash (re-computation crashed / engine-version skew).
  // ok:true alone must not be treated as a verdict — without a hash there is nothing to compare.
  it('refuses a verdict that carries no state hash', async () => {
    const { gateway, calls } = recordingGateway({ ok: true, judgeAccountId: 'j' });
    expect(await judgeMismatch(gateway, body(), REPLAY)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  // The judge re-computed successfully but its hash matches neither side (its own engine build /
  // card pool diverged). Nobody can be convicted on that, so the match is voided.
  it('refuses when the judge hash matches neither reported side', async () => {
    const { gateway } = recordingGateway({ ok: true, stateHash: 'HZ', judgeAccountId: 'j' });
    expect(await judgeMismatch(gateway, body(), REPLAY_NO_DECKS)).toBeNull();
  });

  // The judge's hash matches a side that is not in `players` (malformed report: results and players
  // disagree on which sides played). Refuse rather than convict whoever happens to be left.
  it('refuses when the matched result side is absent from players', async () => {
    const { gateway } = recordingGateway({ ok: true, stateHash: 'HA' });
    const verdict = await judgeMismatch(
      gateway,
      body({ players: [{ side: 3, accountId: 'a' }, { side: 4, accountId: 'b' }] }),
      REPLAY,
    );
    expect(verdict).toBeNull();
  });

  // Happy path with an identified judge: the judge's accountId is carried into the verdict so the
  // archived `cheat` record names who adjudicated (audit trail for a conviction).
  it('names the judge account when the gateway reports one', async () => {
    const { gateway, calls } = recordingGateway({ ok: true, stateHash: 'HB', judgeAccountId: 'judge-1' });
    const verdict = await judgeMismatch(gateway, body(), REPLAY);
    expect(verdict).toEqual({
      honest: { side: 1, accountId: 'b' },
      cheater: { side: 0, accountId: 'a' },
      judgeAccountId: 'judge-1',
    });
    // Both players are excluded from judge selection, and the replay is forwarded still base64-encoded.
    expect((calls[0] as { exclude: string[] }).exclude).toEqual(['a', 'b']);
    expect((calls[0] as { frames: unknown[] }).frames).toEqual(REPLAY.frames);
    expect((calls[0] as { decks?: unknown }).decks).toEqual(REPLAY.decks);
  });

  // Same verdict from an anonymous judge (older gateway build / judge id withheld): the conviction
  // still stands, the field is simply omitted rather than written as `undefined`.
  it('omits judgeAccountId entirely when the gateway does not report one', async () => {
    const { gateway } = recordingGateway({ ok: true, stateHash: 'HA' });
    const verdict = await judgeMismatch(gateway, body(), REPLAY);
    expect(verdict).toEqual({ honest: { side: 0, accountId: 'a' }, cheater: { side: 1, accountId: 'b' } });
    expect(verdict && 'judgeAccountId' in verdict).toBe(false);
  });
});
