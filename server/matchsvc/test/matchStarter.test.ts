// Direct unit tests for MatchStarter (matchsvc/matchStarter.ts) covering the best-effort
// setActiveMatch-failure paths not exercised by matchsvc.test.ts's happy-path
// "login-reconnect-prompt" tests (which always resolve successfully). Same fake-deps style as
// test/matchsvc.test.ts's own redis fake (`{ set: vi.fn()... }`), just failing instead of succeeding.
import { describe, it, expect, vi } from 'vitest';
import { verifyTicket, type RedisLike } from '@nw/shared';
import { MatchStarter } from '../src/matchsvc/matchStarter';
import { GameRegistry } from '../src/GameRegistry';
import type { PushMsg, StartMatchPlayer } from '../src/matchsvc/types';

const KEY = 'test-internal-key';
const GAME_URL = 'ws://game:8081/ws';

const player = (accountId: string, name: string, publicId: string): StartMatchPlayer => ({
  accountId, name, publicId, equippedTitle: '', avatarId: '', equippedSkins: [], deck: [],
});

describe('MatchStarter.start: setActiveMatch failures are caught, logged, and never block the match (matchStarter.ts 82-87)', () => {
  it('redis.set rejecting for both sides is swallowed by the .catch — match_found still reaches both players', async () => {
    const pushed: { acc: string; msg: PushMsg }[] = [];
    const games = new GameRegistry(() => 0, GAME_URL);
    const redis = { set: vi.fn().mockRejectedValue(new Error('redis unreachable')) };
    const starter = new MatchStarter({
      push: (acc, msg) => pushed.push({ acc, msg }),
      games,
      internalKey: KEY,
      ticketTtlSec: 30,
      redis: redis as unknown as RedisLike, // SET is the only command setActiveMatch issues
    });

    starter.start('friendly', player('a', 'Alice', '1'), player('b', 'Bob', '2'));
    // setActiveMatch is fire-and-forget (`void setActiveMatch(...).catch(...)`) — flush a macrotask so
    // both rejected promises' .catch handlers (matchStarter.ts lines 83 and 86) actually run.
    await new Promise((r) => setTimeout(r, 0));

    expect(redis.set).toHaveBeenCalledTimes(2); // one attempt per side, both failing
    const fa = pushed.find((p) => p.acc === 'a' && p.msg.kind === 'match_found');
    const fb = pushed.find((p) => p.acc === 'b' && p.msg.kind === 'match_found');
    if (fa?.msg.kind !== 'match_found' || fb?.msg.kind !== 'match_found') throw new Error('no match_found');
    const ta = verifyTicket(fa.msg.ticket, { key: KEY });
    const tb = verifyTicket(fb.msg.ticket, { key: KEY });
    expect(ta.roomId).toBe(tb.roomId); // match still started normally despite both redis writes failing
  });
});
