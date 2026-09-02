// Coverage for `client/src/assets/idlePrefetch.ts` (ASSET_PACKAGING §11) — the post-lobby
// L1 warm-up.
//
// Every wave is mocked away: what matters here is not that the loaders work (they have their
// own tests) but the scheduling contract around them, which is the part that can quietly hurt
// the player — a prefetch that fans out in parallel, or keeps going on a metered link, or
// restarts on every call, competes with the gameplay traffic it was meant to get ahead of.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Records the order waves start/finish, and hands each test control over when they resolve.
const events: string[] = [];
const pending = new Map<string, () => void>();
function wave(id: string) {
  return vi.fn(() => {
    events.push(`start:${id}`);
    return new Promise<void>((resolve) => {
      pending.set(id, () => { events.push(`end:${id}`); resolve(); });
    });
  });
}
const bootBackground = wave('boot:background');
const battle = wave('battle');
const rewardIcons = wave('icons:reward');
const world = wave('slg:world');
const gacha = wave('gacha');

vi.mock('../src/assets/bootManifest', () => ({ preloadBootBackground: () => bootBackground() }));
vi.mock('../src/assets/battleAssets', () => ({ ensureBattleAssets: () => battle() }));
vi.mock('../src/render/rewardIcon', () => ({ preloadRewardIconArt: () => rewardIcons() }));
vi.mock('../src/render/gachaArt', () => ({ preloadGachaTextures: () => gacha() }));
vi.mock('../src/render/atlas/worldAtlas', () => ({ worldAtlas: { load: () => world() } }));

// Rotation clock, driven by the tests. Defaults to "never rotated", which is the state every test
// below except the rotation block runs in — awaitRotationQuiet returns immediately there.
const rotation: { at: number | undefined } = { at: undefined };
vi.mock('../src/net/anomaly/deviceContext', () => ({ lastRotationAt: () => rotation.at }));

// After vi.mock (hoisted regardless of physical order — same pattern as battleGate.ui.ts).
import { startIdlePrefetch, resetIdlePrefetchForTest } from '../src/assets/idlePrefetch';
import {
  installPrefetchPolicy, resetPrefetchPolicyForTest, markFeatureUsed, setDataSaverEnabled,
  type NetworkKind,
} from '../src/assets/prefetchPolicy';
import type { IStorage } from '../src/platform/IPlatform';

/** In-memory stand-in for platform.storage — the marks and the data-saver flag live here. */
const store = new Map<string, string>();
const storage: IStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, v); },
  removeItem: (k) => { store.delete(k); },
};

// `icons:reward` moved ahead of `battle` with the scene-title icon pass: it is both the smallest
// wave (~430 KB) and the one every menu screen draws from the moment it opens, and some of those
// screens render exactly once, so a late decode there is a permanently blank glyph rather than a
// one-frame flash. See the ordering rationale in idlePrefetch.ts's WAVES table.
const WAVE_ORDER = ['boot:background', 'icons:reward', 'battle', 'slg:world', 'gacha'];

/**
 * Drain enough turns of the event loop for a settled wave to schedule its idle callback
 * and start the next one. Over-draining is safe and is what makes the serial assertion
 * meaningful: if the chain were parallel, every remaining wave would have started by now.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Resolve the wave currently in flight and let the chain advance. */
async function finish(id: string): Promise<void> {
  pending.get(id)?.();
  await flush();
}

function setConnection(conn: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(globalThis.navigator ?? {}), connection: conn },
    configurable: true,
    writable: true,
  });
}

describe('idlePrefetch', () => {
  beforeEach(() => {
    events.length = 0;
    pending.clear();
    resetIdlePrefetchForTest();
    // requestIdleCallback fires straight away, so tests don't wait out the real
    // 3s/1s inter-wave delays. Its absence (WeChat) falls back to setTimeout, which
    // is covered by the "no requestIdleCallback" test below.
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: () => void) => { setTimeout(cb, 0); return 1; };
    setConnection(undefined);
    // Default to a player who has opened both gated screens, so the tests about SCHEDULING see the
    // full five-wave chain. The gating itself is covered in its own describe block below.
    store.clear();
    installPrefetchPolicy({ storage });
    markFeatureUsed('world');
    markFeatureUsed('gacha');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    resetPrefetchPolicyForTest();
    vi.restoreAllMocks();
  });

  it('runs the waves one at a time, in priority order', async () => {
    void startIdlePrefetch();
    await flush();

    // Nothing beyond the first wave may be in flight at any point.
    for (const id of WAVE_ORDER) {
      expect(events.filter((e) => e.startsWith('start:'))).toEqual(
        WAVE_ORDER.slice(0, WAVE_ORDER.indexOf(id) + 1).map((w) => `start:${w}`),
      );
      await finish(id);
    }

    expect(events).toEqual(WAVE_ORDER.flatMap((id) => [`start:${id}`, `end:${id}`]));
    // Cheapest/likeliest first: the gacha set (1.2 MB since §12.1) is last.
    expect(WAVE_ORDER[WAVE_ORDER.length - 1]).toBe('gacha');
  });

  it('keeps going after a wave fails', async () => {
    bootBackground.mockImplementationOnce(() => {
      events.push('start:boot:background');
      return Promise.reject(new Error('boom'));
    });
    void startIdlePrefetch();
    await flush();

    expect(events).toEqual(['start:boot:background', 'start:icons:reward']);
    await finish('icons:reward');
    expect(events).toContain('start:battle');
  });

  it('does nothing on a save-data / 2g connection', async () => {
    setConnection({ saveData: true });
    await startIdlePrefetch();
    expect(events).toEqual([]);

    resetIdlePrefetchForTest();
    setConnection({ effectiveType: '2g' });
    await startIdlePrefetch();
    expect(events).toEqual([]);
  });

  it('prefetches when the Network Information API is absent', async () => {
    setConnection(undefined);
    void startIdlePrefetch();
    await flush();
    expect(events).toContain('start:boot:background');
  });

  it('still prefetches on 3g and up — only 2g/save-data opt out', async () => {
    // Pins the boundary: the skip is for links where speculative bytes genuinely hurt, not for
    // "anything short of wifi". Widening it silently would turn the prefetch off for most phones.
    for (const effectiveType of ['3g', '4g']) {
      resetIdlePrefetchForTest();
      events.length = 0;
      pending.clear();
      setConnection({ effectiveType });
      void startIdlePrefetch();
      await flush();
      expect(events, `effectiveType=${effectiveType} should still prefetch`).toContain('start:boot:background');
    }
  });

  it('only ever starts once', async () => {
    void startIdlePrefetch();
    void startIdlePrefetch();
    await flush();
    expect(events.filter((e) => e === 'start:boot:background')).toHaveLength(1);
  });

  it('still runs without requestIdleCallback (WeChat)', async () => {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    vi.useFakeTimers();
    void startIdlePrefetch();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(events).toContain('start:boot:background');
    vi.useRealTimers();
  });

  // ── mid-rotation hold (2026-08-24) ──
  // requestIdleCallback is not sufficient on its own here: a rotation's cost is largely off the main
  // thread (drawing-buffer reallocation, texture re-upload), so the thread can look idle at exactly
  // the moment GPU and memory pressure peak. Decoding a multi-megabyte texture into that window is
  // the worst available timing on a memory-capped mobile WebView.
  describe('holds off while the screen is rotating', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Honour the requested deadline, unlike the fire-immediately stub the other tests use — the
      // whole point here is *when* the wave is allowed to start.
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback =
        (cb: () => void, opts?: { timeout: number }) => { setTimeout(cb, opts?.timeout ?? 0); return 1; };
    });
    afterEach(() => { rotation.at = undefined; vi.useRealTimers(); });

    it('delays the first wave until the screen has been still for a moment', async () => {
      void startIdlePrefetch();
      await vi.advanceTimersByTimeAsync(2_999);
      expect(events).toEqual([]); // still inside the opening 3s idle delay

      const rotatedAt = Date.now(); // the player turns the phone right as that delay expires
      rotation.at = rotatedAt;
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual([]); // ...so the wave is held rather than started

      // Quiet is measured from the flip, not from when the wave wanted to run.
      await vi.advanceTimersByTimeAsync(rotatedAt + 1_499 - Date.now());
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toEqual(['start:boot:background']); // 1500ms of stillness reached
    });

    it('does not hold a session that has never rotated', async () => {
      void startIdlePrefetch();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(events).toEqual(['start:boot:background']);
    });

    it('gives up waiting rather than stalling forever while the screen keeps turning', async () => {
      // Bounded by MAX_QUIET_WAITS. A player idly flipping the phone back and forth must not be
      // able to park the prefetch permanently — the waves still have to land eventually.
      void startIdlePrefetch();
      await vi.advanceTimersByTimeAsync(3_000);
      for (let i = 0; i < 6; i += 1) {
        rotation.at = Date.now();
        await vi.advanceTimersByTimeAsync(1_500);
      }
      expect(events).toContain('start:boot:background');
    });
  });
});

/**
 * Per-feature scoping (ASSET_PACKAGING §14). Before this, every non-metered player warmed all
 * ~5 MB, including `slg:world` (2.0 MB / ~13.7 MB decoded) and `gacha` (1.2 MB) for screens they
 * may never open. The world atlas is the one that matters most: its real cost is the decode, which
 * is paid on wifi exactly the same, so no network-side heuristic could ever have caught it.
 */
describe('idlePrefetch — scoped to features the player actually uses', () => {
  const UNGATED = ['boot:background', 'icons:reward', 'battle'];

  beforeEach(() => {
    events.length = 0;
    pending.clear();
    resetIdlePrefetchForTest();
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: () => void) => { setTimeout(cb, 0); return 1; };
    setConnection(undefined);
    store.clear();
    installPrefetchPolicy({ storage });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    resetPrefetchPolicyForTest();
    vi.restoreAllMocks();
  });

  /** Run the whole chain to completion, resolving each wave as it starts. */
  async function runAll(): Promise<string[]> {
    void startIdlePrefetch();
    await flush();
    for (let i = 0; i < 8; i += 1) {
      const inFlight = [...pending.keys()];
      if (!inFlight.length) break;
      for (const id of inFlight) await finish(id);
    }
    return events.filter((e) => e.startsWith('start:')).map((e) => e.slice('start:'.length));
  }

  it('warms only the ungated waves for a player who has opened neither screen', async () => {
    expect(await runAll()).toEqual(UNGATED);
  });

  it('warms the world atlas once the player has opened the world map', async () => {
    markFeatureUsed('world');
    expect(await runAll()).toEqual([...UNGATED, 'slg:world']);
  });

  it('warms the gacha set once the player has pulled', async () => {
    markFeatureUsed('gacha');
    expect(await runAll()).toEqual([...UNGATED, 'gacha']);
  });

  // The marks are hints, not permissions: a wrong answer costs nothing because every scene gate
  // re-awaits the same idempotent loaders. But a mark that never sticks would silently pin every
  // player to the reduced set forever, which is the failure mode worth pinning down.
  it('keeps the mark across sessions (it lives in storage, not in module state)', async () => {
    markFeatureUsed('world');
    expect(await runAll()).toContain('slg:world');

    resetIdlePrefetchForTest();
    resetPrefetchPolicyForTest();
    events.length = 0;
    pending.clear();
    installPrefetchPolicy({ storage }); // same storage, fresh module state = a new session
    expect(await runAll()).toContain('slg:world');
  });

  it('the data-saver setting overrides everything, marks included', async () => {
    markFeatureUsed('world');
    markFeatureUsed('gacha');
    setDataSaverEnabled(true);
    expect(await runAll()).toEqual([]);
  });

  it('lets a platform probe answer where navigator.connection cannot (WeChat)', async () => {
    // The whole point of the platform hook: WeChat has no navigator.connection at all, so the web
    // path reads every WeChat link as "unknown" and prefetches. wx.getNetworkType can say '2g'.
    const kinds: NetworkKind[] = ['slow', 'none'];
    for (const kind of kinds) {
      resetIdlePrefetchForTest();
      resetPrefetchPolicyForTest();
      events.length = 0;
      installPrefetchPolicy({ storage, getNetworkKind: () => Promise.resolve(kind) });
      await startIdlePrefetch();
      expect(events, `${kind} should skip the prefetch entirely`).toEqual([]);
    }
  });

  it('does not treat plain cellular as a reason to skip', async () => {
    // Same boundary the web path pins, restated for the platform probe: the rule is "links where
    // speculative bytes genuinely hurt", not "anything short of wifi". Widening it here would turn
    // the prefetch off for most phones — the per-feature marks are what keep 4G honest instead.
    installPrefetchPolicy({ storage, getNetworkKind: () => Promise.resolve('cellular' as NetworkKind) });
    expect(await runAll()).toEqual(UNGATED);
  });
});
