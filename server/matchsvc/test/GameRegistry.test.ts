// GameRegistry load-balancing algorithm (M17): every existing test constructs this class with zero
// registered instances (`new GameRegistry(() => 0, FALLBACK_URL)`), so only the "no instances → use
// the fallback address" branch was ever exercised — register()/heartbeat()/pick()'s actual
// least-loaded-ratio selection, staleness eviction, and capacity-exhaustion skip had zero coverage.
// All tests use an injected clock so lastSeen/staleness is deterministic.
import { describe, it, expect } from 'vitest';
import { GameRegistry } from '../src/GameRegistry';

describe('GameRegistry.register + pick — basic selection', () => {
  it('a single registered instance is picked, and pick() optimistically bumps its load by 1', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('g1', 'ws://g1/ws', 10);
    expect(reg.stats()).toEqual({ instances: 1, load: 0 });

    expect(reg.pick()).toBe('ws://g1/ws');
    expect(reg.stats()).toEqual({ instances: 1, load: 1 }); // optimistic reservation visible in stats
  });

  it('picks by load/capacity RATIO, not absolute load — a busier-but-bigger instance can still win', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('small', 'ws://small/ws', 10);
    reg.heartbeat('small', 5, 0); // ratio 0.5
    reg.register('big', 'ws://big/ws', 20);
    reg.heartbeat('big', 6, 0); // ratio 0.3 — lower ratio despite higher absolute load

    expect(reg.pick()).toBe('ws://big/ws');
  });

  it('among several instances, the lowest-ratio one is chosen regardless of registration order', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('a', 'ws://a/ws', 100);
    reg.heartbeat('a', 90, 0); // ratio 0.9
    reg.register('b', 'ws://b/ws', 100);
    reg.heartbeat('b', 10, 0); // ratio 0.1 — winner
    reg.register('c', 'ws://c/ws', 100);
    reg.heartbeat('c', 50, 0); // ratio 0.5

    expect(reg.pick()).toBe('ws://b/ws');
  });
});

describe('GameRegistry.heartbeat — load changes the pick outcome', () => {
  it('re-heartbeating an instance to a higher load can flip pick() to a different instance', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('a', 'ws://a/ws', 10);
    reg.register('b', 'ws://b/ws', 10);
    reg.heartbeat('a', 1, 0); // a: ratio 0.1 — currently the best
    reg.heartbeat('b', 5, 0); // b: ratio 0.5
    expect(reg.pick()).toBe('ws://a/ws');

    // a gets busier than b — pick() must now favor b.
    reg.heartbeat('a', 9, 0); // a: ratio 0.9 (note: previous pick() already bumped a's load to 2,
    // but heartbeat() is an authoritative overwrite, not additive, so 9 replaces it outright)
    expect(reg.pick()).toBe('ws://b/ws');
  });

  it('heartbeat clamps a negative load to 0 (defensive against a malformed gameserver report)', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('a', 'ws://a/ws', 10);
    reg.heartbeat('a', -5, 0);
    expect(reg.stats()).toEqual({ instances: 1, load: 0 });
  });

  it('heartbeat for an unregistered gameId is a silent no-op (no throw, no phantom instance)', () => {
    const reg = new GameRegistry(() => 0, null);
    expect(() => reg.heartbeat('ghost', 5, 0)).not.toThrow();
    expect(reg.stats()).toEqual({ instances: 0, load: 0 });
    expect(reg.pick()).toBeNull();
  });

  it('heartbeat refreshes lastSeen, keeping an instance alive past what its registration-time staleness window would have been', () => {
    let now = 0;
    const reg = new GameRegistry(() => now, null);
    reg.register('a', 'ws://a/ws', 10);
    now = 20_000; // 20s later — still within STALE_MS(30s) of the last heartbeat
    reg.heartbeat('a', 1, 0);
    now = 45_000; // 25s after that heartbeat — still fresh relative to it, though 45s past registration
    expect(reg.pick()).toBe('ws://a/ws');
  });
});

describe('GameRegistry — staleness eviction (STALE_MS = 30s)', () => {
  it('an instance that never heartbeats past 30s since registration is excluded from pick()', () => {
    let now = 0;
    const reg = new GameRegistry(() => now, null);
    reg.register('a', 'ws://a/ws', 10);
    now = 30_001;
    expect(reg.pick()).toBeNull();
    expect(reg.stats()).toEqual({ instances: 0, load: 0 }); // stale instances excluded from stats too
  });

  it('exactly at the 30s boundary is still considered healthy (strict > comparison)', () => {
    let now = 0;
    const reg = new GameRegistry(() => now, null);
    reg.register('a', 'ws://a/ws', 10);
    now = 30_000; // t - lastSeen === STALE_MS, not >
    expect(reg.pick()).toBe('ws://a/ws');
  });

  it('a stale instance is skipped in favor of a healthy one, even if the stale one is less loaded', () => {
    let now = 0;
    const reg = new GameRegistry(() => now, null);
    reg.register('stale', 'ws://stale/ws', 10); // lastSeen=0, load 0 (would otherwise win on ratio)
    now = 10_000;
    reg.register('fresh', 'ws://fresh/ws', 10);
    reg.heartbeat('fresh', 5, 0); // lastSeen=10_000, load 5, ratio 0.5, but healthy
    now = 35_000; // stale: 35_000-0=35_000 (>30s → stale). fresh: 35_000-10_000=25_000 (<=30s → healthy)
    expect(reg.pick()).toBe('ws://fresh/ws');
  });

  it('a fully-stale registry falls back to the configured fallback URL', () => {
    let now = 0;
    const reg = new GameRegistry(() => now, 'ws://fallback/ws');
    reg.register('a', 'ws://a/ws', 10);
    now = 30_001;
    expect(reg.pick()).toBe('ws://fallback/ws');
  });
});

describe('GameRegistry — capacity exhaustion', () => {
  it('an instance at full capacity (load >= capacity) is skipped even though it is healthy', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('full', 'ws://full/ws', 5);
    reg.heartbeat('full', 5, 0); // load === capacity → full
    expect(reg.pick()).toBeNull();
  });

  it('an over-capacity instance (load > capacity, e.g. a stale heartbeat race) is also skipped', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('over', 'ws://over/ws', 5);
    reg.heartbeat('over', 9, 0);
    expect(reg.pick()).toBeNull();
  });

  it('a full instance is skipped in favor of one with remaining capacity', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('full', 'ws://full/ws', 5);
    reg.heartbeat('full', 5, 0);
    reg.register('open', 'ws://open/ws', 5);
    reg.heartbeat('open', 4, 0); // ratio 0.8, worse than full's 1.0 but full is disqualified outright
    expect(reg.pick()).toBe('ws://open/ws');
  });

  it('register() floors capacity at 1 even if given 0 or a negative value (Math.max(1, capacity))', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('a', 'ws://a/ws', 0);
    // capacity clamped to 1, load 0 < 1 → still pickable once.
    expect(reg.pick()).toBe('ws://a/ws');
    // after the optimistic bump, load(1) >= capacity(1) → now full.
    expect(reg.pick()).toBeNull();
  });
});

describe('GameRegistry — tie-break rule when ratios are equal', () => {
  it('equal ratios → the first-registered instance wins (strict "<" comparison never replaces an equal-ratio incumbent)', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('first', 'ws://first/ws', 10);
    reg.register('second', 'ws://second/ws', 10);
    // both at load 0 / capacity 10 → ratio 0 for both.
    expect(reg.pick()).toBe('ws://first/ws');
  });

  it('after the optimistic bump breaks the tie, the next pick() favors whichever is now relatively less loaded', () => {
    const reg = new GameRegistry(() => 0, null);
    reg.register('first', 'ws://first/ws', 10);
    reg.register('second', 'ws://second/ws', 10);
    expect(reg.pick()).toBe('ws://first/ws'); // first now load=1 (ratio 0.1)
    expect(reg.pick()).toBe('ws://second/ws'); // second still load=0 (ratio 0) — now strictly lower
    expect(reg.pick()).toBe('ws://first/ws'); // both at load=1 (ratio 0.1) — tie again, first wins again
  });
});

describe('GameRegistry — fallback behavior (registry-level; Matchsvc-level GAME_UNAVAILABLE path is already covered by matchsvc.test.ts)', () => {
  it('empty registry with a configured fallback → pick() returns the fallback URL', () => {
    const reg = new GameRegistry(() => 0, 'ws://fallback/ws');
    expect(reg.pick()).toBe('ws://fallback/ws');
  });

  it('empty registry with no fallback configured → pick() returns null', () => {
    const reg = new GameRegistry(() => 0, null);
    expect(reg.pick()).toBeNull();
  });
});
