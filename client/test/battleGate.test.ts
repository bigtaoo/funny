/**
 * battleGate.test.ts — `client/src/app/battleGate.ts`: the battle-specific half of the pre-match
 * asset gate (ASSET_PACKAGING §10), plus `DeferredSceneCalls`.
 *
 * Replaces `test/ui/battleGate.ui.ts` (deleted 2026-09-09). That file drove the real
 * `assetGate.enterWithAssets` with real PIXI, which is why it had to live in test/ui — and it
 * asserted, through `enterBattle`, the same three things `test/ui/assetGate.ui.ts` already asserts
 * on the primitive directly (input frozen, no goto before the warm step settles, overlay torn down
 * before goto). So the module read as 0% in the coverage report while its 20 lines were exercised
 * only by a suite that reports none, and the duplicated cases guarded the layer BELOW it.
 *
 * Here `assetGate` and `battleAssets` are both mocked, which leaves exactly what this file owns:
 * the two arguments it hands the primitive, and the queue. What that deliberately does NOT cover
 * (and what `assetGate.ui.ts` does) is the gate mechanics themselves — ordering, overlay teardown,
 * un-suppressing input. Asserting those here would only be asserting the mock.
 *
 * Why the forwarding is worth a gate at all, given it is one `return` statement: `opts` carries
 * both sides' equipped skin ids, and skins are the one part of a battle's asset set that is NOT in
 * `STICKMAN_ASSETS` — drop them on the floor here and the loading screen still runs, still fills,
 * still cross-fades, and the FIRST match of a session that fields an equipped skin flashes a
 * placeholder circle for a few frames. Every later match in that session is fine (the rig is cached
 * by then), which is precisely the case nobody sees while developing.
 *
 * `DeferredSceneCalls` is the same shape of invisible: it buffers `net_state`/`peer_dc`/`match_over`
 * pushes that arrive while the loading screen is up (PixiAppViews.showGameNet must hand the caller
 * a NetGameView synchronously, but the scene does not exist yet). If a queued call were dropped
 * instead of flushed, nothing errors anywhere — a lost `match_over` just leaves the player in a
 * battle that never ends. That window only exists on a COLD asset cache, i.e. the first net match
 * after a fresh load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Scene } from '../src/scenes/SceneManager';
import type { AssetGateDeps, WarmAssets } from '../src/app/assetGate';

/** Records what `enterBattle` hands the shared primitive, and drives the warm callback itself. */
const gateCalls: Array<{
  deps: AssetGateDeps;
  warm: WarmAssets;
  build: () => unknown;
  opts?: { fade?: boolean };
}> = [];
/** Progress reported by the warm step, as the primitive would see it. */
const progress: Array<[number, number]> = [];

vi.mock('../src/app/assetGate', () => ({
  enterWithAssets: vi.fn(async (
    deps: AssetGateDeps,
    warm: WarmAssets,
    build: () => unknown,
    opts?: { fade?: boolean },
  ) => {
    gateCalls.push({ deps, warm, build, opts });
    await warm((done, total) => progress.push([done, total]));
    return build();
  }),
}));

/** Reports one step, so the progress plumbed through `enterBattle` has something to carry. */
const ensureCalls: unknown[][] = [];
vi.mock('../src/assets/battleAssets', () => ({
  ensureBattleAssets: vi.fn((opts: unknown, onProgress?: (d: number, t: number) => void) => {
    ensureCalls.push([opts, onProgress]);
    onProgress?.(0, 1);
    onProgress?.(1, 1);
    return Promise.resolve();
  }),
}));

// Imported AFTER vi.mock (vitest hoists mock registration above all imports regardless of
// physical order — same pattern as the file this replaced).
import { enterBattle, DeferredSceneCalls } from '../src/app/battleGate';
import { ensureBattleAssets } from '../src/assets/battleAssets';
import { enterWithAssets } from '../src/app/assetGate';

const deps = {} as AssetGateDeps; // opaque here: the primitive is mocked, nothing reads it
const scene = { container: {}, update: () => {}, destroy: () => {} } as unknown as Scene;

describe('enterBattle', () => {
  beforeEach(() => {
    gateCalls.length = 0;
    progress.length = 0;
    ensureCalls.length = 0;
    vi.clearAllMocks();
  });

  it('warms with the caller’s options object, skins and all', async () => {
    const opts = { equippedSkins: ['skin_l1'], opponentSkins: ['skin_e1'] };
    await enterBattle(deps, opts, () => scene);
    expect(ensureBattleAssets).toHaveBeenCalledTimes(1);
    // Identity, not shape: the failure this guards is the skin ids not reaching the warm step, and
    // a `{}`-for-`opts` slip would still satisfy a shape assertion on the default (no-skin) case.
    expect(ensureCalls[0][0]).toBe(opts);
  });

  it('threads the gate’s progress sink into the warm step', async () => {
    await enterBattle(deps, {}, () => scene);
    // Dropped onProgress = a loading bar that sits at 0% for the whole warm and then vanishes.
    expect(progress).toEqual([[0, 1], [1, 1]]);
  });

  it('cross-fades into the battle and returns the built scene', async () => {
    const build = vi.fn(() => scene);
    const built = await enterBattle(deps, {}, build);
    expect(enterWithAssets).toHaveBeenCalledTimes(1);
    expect(gateCalls[0].opts).toEqual({ fade: true }); // entering a match cross-fades, not cuts
    expect(gateCalls[0].deps).toBe(deps);
    expect(gateCalls[0].build).toBe(build); // the scene is built by the gate, after warming
    expect(built).toBe(scene);
  });

  it('passes a warm callback rather than a load already in flight', async () => {
    // The primitive owns "warm, THEN build" (assetGate.ui.ts pins that); what belongs here is that
    // `enterBattle` hands over a FUNCTION instead of kicking the load off at call time — an
    // eagerly evaluated `ensureBattleAssets(opts)` would start pulling rigs while the player is
    // still on the previous screen, before there is a loading overlay in front of it.
    (enterWithAssets as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_deps: AssetGateDeps, _warm: WarmAssets, build: () => unknown) => build(),
    );
    await enterBattle(deps, {}, () => scene);
    expect(ensureBattleAssets).not.toHaveBeenCalled(); // never called: the warm was never invoked
  });
});

describe('DeferredSceneCalls', () => {
  it('queues calls made before resolve() and flushes them in order once the scene exists', () => {
    const order: string[] = [];
    const deferred = new DeferredSceneCalls<{ tag: string }>();
    deferred.call(() => order.push('a'));
    deferred.call(() => order.push('b'));
    expect(order).toEqual([]); // not flushed yet — no scene

    deferred.resolve({ tag: 'scene' });
    // Order matters: net_state-then-match_over is not the same stream as match_over-then-net_state.
    expect(order).toEqual(['a', 'b']);
  });

  it('applies calls immediately once resolved, with no queuing', () => {
    const order: string[] = [];
    const deferred = new DeferredSceneCalls<{ tag: string }>();
    deferred.resolve({ tag: 'scene' });
    deferred.call(() => order.push('a'));
    deferred.call(() => order.push('b'));
    expect(order).toEqual(['a', 'b']);
  });

  it('passes the resolved scene through to each callback', () => {
    const target = { tag: 'scene' };
    const seen: unknown[] = [];
    const deferred = new DeferredSceneCalls<typeof target>();
    deferred.call((s) => seen.push(s));
    deferred.resolve(target);
    expect(seen).toEqual([target]);
  });

  it('drains the queue, so a flushed call is not replayed by a later resolve()', () => {
    // `resolve()` is called once per scene in production (showGameNet); draining is what makes that
    // a property of this class instead of of its caller — a re-flush would re-apply an old
    // net_state on top of newer state.
    let calls = 0;
    const deferred = new DeferredSceneCalls<{ tag: string }>();
    deferred.call(() => { calls += 1; });
    deferred.resolve({ tag: 'first' });
    deferred.resolve({ tag: 'second' });
    expect(calls).toBe(1);
  });
});
