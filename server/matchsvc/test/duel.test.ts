// Direct unit tests for DuelService (matchsvc/duel.ts) covering the one defensive guard reachable
// through its public API: expireDuel()'s "invite already gone" no-op (duel.ts line 103). Hit by feeding
// hydrateAll() two persisted rows that share the same inviteId (can't happen with real Redis data — each
// invite's key is a randomUUID() — but hydrateAll has no way to know that, and this is the only way, short
// of reaching into private state, to make the SECOND of two independently-scheduled timers for one
// inviteId find the entry already removed by the first).
//
// cancelDuel()'s twin guard (duel.ts line 114) is NOT covered here and is left uncovered deliberately:
// every write path (duelInvite/hydrateAll) inserts into `duelInvites` and `pendingDuelByAccount` together
// for the same inviteId, and every removal path (duelRespond/expireDuel/cancelDuel) deletes both together
// keyed off the SAME invite's own `from.accountId` — so `pendingDuelByAccount` can never hold an accountId
// pointing at an inviteId that's absent from `duelInvites` (traced through every call site; the duplicate-
// inviteId trick above only reproduces that for expireDuel because expireDuel's *own* removal is what
// leaves the second timer's lookup empty). Reaching the cancelDuel guard would require directly mutating
// the class's private maps, which is out of scope for a black-box test — true defensive dead code.
import { describe, it, expect, vi } from 'vitest';
import { DuelService } from '../src/matchsvc/duel';
import type { DuelPlayer, MatchStarterPort, PushMsg, QueueLookupPort, RoomLookupPort } from '../src/matchsvc/types';
import type { PersistedDuelInvite } from '../src/persist';

function setup(now: () => number) {
  const pushed: { acc: string; msg: PushMsg }[] = [];
  const rooms: RoomLookupPort = { hasRoom: () => false };
  const queue: QueueLookupPort = { hasQueued: () => false };
  const matchStarter: MatchStarterPort = { start: () => {} };
  const duel = new DuelService({
    push: (acc, msg) => pushed.push({ acc, msg }),
    redis: null,
    now,
    matchStarter,
    rooms,
    queue,
  });
  return { duel, pushed };
}

describe('DuelService.expireDuel: invite already removed by the time the timer fires is a silent no-op (duel.ts line 103)', () => {
  it('two persisted rows sharing one inviteId (data corruption) -> the second timer to fire finds it already gone, does not double-push', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const { duel, pushed } = setup(() => now);
      const from: DuelPlayer = { accountId: 'a', name: 'Alice', publicId: '1', equippedTitle: '', avatarId: '', equippedSkins: [], deck: [] };
      const sameId = 'dup-invite';
      const rows: PersistedDuelInvite[] = [
        { inviteId: sameId, from, toAccountId: 'b', expiresAt: 10 }, // fires first (remaining=10 at now=0)
        { inviteId: sameId, from, toAccountId: 'b', expiresAt: 20 }, // fires second, but by then the entry it points at is gone
      ];

      duel.hydrateAll(rows); // schedules two independent setTimeouts for the same inviteId

      // Let the first timer (10ms out) fire: expireDuel(sameId) finds the entry (whichever hydrateAll's
      // second `.set()` left behind) and tears it down -> one duel_cancelled{reason:timeout} to the inviter.
      vi.advanceTimersByTime(10);
      expect(pushed.filter((p) => p.msg.kind === 'duel_cancelled')).toHaveLength(1);

      // Now let the second timer (20ms out) fire too: expireDuel(sameId) again, but `duelInvites` no
      // longer has `sameId` -> hits the "invite not found" guard and returns without pushing again.
      vi.advanceTimersByTime(10);
      expect(pushed.filter((p) => p.msg.kind === 'duel_cancelled')).toHaveLength(1); // still just one push, not two
    } finally {
      vi.useRealTimers();
    }
  });
});
