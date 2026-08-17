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

vi.mock('../../src/assets/bootManifest', () => ({ preloadBootBackground: () => bootBackground() }));
vi.mock('../../src/assets/battleAssets', () => ({ ensureBattleAssets: () => battle() }));
vi.mock('../../src/render/rewardIcon', () => ({ preloadRewardIconArt: () => rewardIcons() }));
vi.mock('../../src/render/gachaArt', () => ({ preloadGachaTextures: () => gacha() }));
vi.mock('../../src/render/atlas/worldAtlas', () => ({ worldAtlas: { load: () => world() } }));

// After vi.mock (hoisted regardless of physical order — same pattern as battleGate.ui.ts).
import { startIdlePrefetch, resetIdlePrefetchForTest } from '../../src/assets/idlePrefetch';

const WAVE_ORDER = ['boot:background', 'battle', 'icons:reward', 'slg:world', 'gacha'];

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
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
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
    // Cheapest/likeliest first: the 3.3 MB gacha set is last.
    expect(WAVE_ORDER[WAVE_ORDER.length - 1]).toBe('gacha');
  });

  it('keeps going after a wave fails', async () => {
    bootBackground.mockImplementationOnce(() => {
      events.push('start:boot:background');
      return Promise.reject(new Error('boom'));
    });
    void startIdlePrefetch();
    await flush();

    expect(events).toEqual(['start:boot:background', 'start:battle']);
    await finish('battle');
    expect(events).toContain('start:icons:reward');
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
});
