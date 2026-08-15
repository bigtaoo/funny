// Direct unit tests for RankedQueue (matchsvc/queue.ts) covering the one branch matchsvc.test.ts's
// bot-fallback suite never exercises: entry.platform being falsy ('') when the flag-eval context is
// built (queue.ts's onQueueTimeout, line 88's `...(entry.platform ? {platform} : {})` spread). Every
// existing bot-fallback test always passes a truthy platform ('web'/'wechat'); this covers the other side.
import { describe, it, expect, vi } from 'vitest';
import { FeatureFlagCache } from '@nw/shared';
import { RankedQueue } from '../src/matchsvc/queue';
import type { MatchStarterPort, PushMsg, RoomLookupPort } from '../src/matchsvc/types';

async function makeCache(docs: unknown[]): Promise<FeatureFlagCache> {
  const cache = new FeatureFlagCache({ fetchAll: async () => docs });
  await cache.refresh();
  return cache;
}

describe('RankedQueue bot-fallback: platform omitted (default "") is left out of the flag-eval context (queue.ts line 88)', () => {
  it('enqueue with no platform arg -> isOn is called without a platform key, and fallback still fires on timeout', async () => {
    vi.useFakeTimers();
    try {
      const cache = await makeCache([{ _id: 'match_bot_fallback', enabled: true, rollout: { pct: 100 } }]);
      const isOnSpy = vi.spyOn(cache, 'isOn');
      const pushed: { acc: string; msg: PushMsg }[] = [];
      const rooms: RoomLookupPort = { hasRoom: () => false };
      const matchStarter: MatchStarterPort = { start: () => {} };
      const rq = new RankedQueue({
        push: (acc, msg) => pushed.push({ acc, msg }),
        rooms,
        matchStarter,
        redis: null,
        flags: cache,
        botFallbackMs: 30_000,
      });

      await rq.enqueue('lonely', 'L', '1', 1000); // platform not passed -> defaults to ''
      await vi.advanceTimersByTimeAsync(31_000);

      expect(pushed.some((p) => p.acc === 'lonely' && p.msg.kind === 'match_bot')).toBe(true);
      const call = isOnSpy.mock.calls.find((c) => c[0] === 'match_bot_fallback');
      expect(call?.[1]).toEqual({ accountId: 'lonely' }); // no `platform` key present
    } finally {
      vi.useRealTimers();
    }
  });
});
