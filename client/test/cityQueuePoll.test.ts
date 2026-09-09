// Coverage for `client/src/scenes/CityScene/data.ts` — CityScene's initial fetch fan-out (`load`)
// and the once-per-second build/training queue poll (`refreshOnQueueDue`).
//
// 0% until now. `refreshOnQueueDue` is the more interesting half and the reason this file gets a
// gate rather than a `logic/` entry: it is the ONLY refresh path a finished queue entry has.
// worldsvc's 2s scheduler settles the queue server-side and never notifies gateway, so there is no
// push to fall back on (P0-9, comm-audit-2026-07-27 finding B10). When this poll stops firing,
// nothing errors and nothing looks broken — the countdown text just freezes at 剩余 0s and the
// finished building stays in the list until the player leaves CityScene and comes back. That is
// indistinguishable from "the server is slow", which is precisely what the retry branch here is
// for, so no amount of manual play tells the two apart.
//
// The three failure modes the cases below are actually aimed at:
//   1. the poll never fires (a due entry is missed, or the due test only looks at one of the two
//      queues — training completions and build completions come through the same tick);
//   2. the poll fires forever (`queueRefreshPending` not released on the offline path would wedge
//      it after a single failed tick — one dropped request and the queue is frozen for the rest of
//      the session, the B10 symptom exactly);
//   3. the poll stacks (no re-entrancy guard: a getMe slower than one second gives one in-flight
//      request per second for as long as the server lags, against the 5-token rateGate bucket).
//
// `load`'s cases pin the 2026-08-02 decision that it is deliberately NOT a `Promise.all` barrier,
// plus the issue order that decision depends on. Both are invisible when correct and invisible
// when broken — a barrier reintroduced here costs the team row a few hundred ms of placeholder,
// which reads as "the network is slow".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The only PIXI-dragging imports in data.ts are the two atlas loaders, and `load` uses them purely
// as "resolve, then repaint" signals. Stubbing them as resolved promises keeps the repaint edge
// (asserted below) while leaving every other import real.
const resAtlas = vi.fn((): Promise<void> => Promise.resolve());
const cityBldAtlas = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('../src/render/atlas/resAtlasLoader', () => ({ loadResAtlas: () => resAtlas() }));
vi.mock('../src/render/atlas/cityBldAtlasLoader', () => ({ loadCityBldAtlas: () => cityBldAtlas() }));

import { refreshOnQueueDue, load, type QueuePollHost, type DataHost } from '../src/scenes/CityScene/data';
import type { PlayerWorldView } from '../src/net/WorldApiClient';

const NOW = 1_800_000_000_000;

type BuildEntry = NonNullable<PlayerWorldView['buildQueue']>[number];
type TrainEntry = NonNullable<PlayerWorldView['trainingQueue']>[number];

function build(completeAt: number): BuildEntry {
  return { key: 'inkPot', toLevel: 2, startAt: completeAt - 60_000, completeAt } as BuildEntry;
}
function train(completeAt: number): TrainEntry {
  return { qty: 10, startAt: completeAt - 60_000, completeAt } as TrainEntry;
}
function me(over: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return { accountId: 'a1', worldId: 'w1', ...over } as PlayerWorldView;
}

/** Deferred promise, so a case can hold getMe in flight and poll again underneath it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** One microtask-queue drain — enough for a settled promise's .then/.catch/.finally chain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface PollFixture {
  host: QueuePollHost;
  /** `DataHost.destroyed` is readonly by contract (CitySceneCore owns it) — this is the test's
   *  stand-in for `CityScene.destroy()`. */
  kill(): void;
  getMe: ReturnType<typeof vi.fn>;
  renders: number;
  requestRenders: number;
  adopted: PlayerWorldView[];
}

function pollFixture(initial: PlayerWorldView | null, getMe: ReturnType<typeof vi.fn>): PollFixture {
  let current = initial;
  let destroyed = false;
  let pending = false;
  const fx: PollFixture = {
    renders: 0, requestRenders: 0, adopted: [], getMe,
    host: null as unknown as QueuePollHost,
    kill() { destroyed = true; },
  };
  fx.host = {
    cb: { worldApi: { getMe } as never, worldId: 'w1', onBack: () => {} } as never,
    get destroyed() { return destroyed; },
    get me() { return current; },
    teams: [], marches: [], occupations: [], stationed: [],
    teamsLoaded: false, ordersLoaded: false,
    get queueRefreshPending() { return pending; },
    set queueRefreshPending(v: boolean) { pending = v; },
    setMe(next: PlayerWorldView) { current = next; fx.adopted.push(next); },
    render() { fx.renders++; },
    requestRender() { fx.requestRenders++; },
  } as unknown as QueuePollHost;
  return fx;
}

describe('CityScene/data refreshOnQueueDue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fetches when a build entry has come due, and adopts + repaints the answer', async () => {
    const fresh = me({ buildQueue: [] });
    const getMe = vi.fn(async () => fresh);
    const fx = pollFixture(me({ buildQueue: [build(NOW - 1)] }), getMe);

    refreshOnQueueDue(fx.host);
    // The guard is set synchronously — a second tick landing before the answer must find it.
    expect(fx.host.queueRefreshPending).toBe(true);
    await settle();

    expect(getMe).toHaveBeenCalledTimes(1);
    expect(getMe).toHaveBeenCalledWith('w1');
    expect(fx.adopted).toEqual([fresh]);
    // requestRender, NOT render: this fires up to once a second, and the coalesced path is the
    // whole reason CitySceneCore has one (test/ui/cityRenderCoalescing.ui.ts covers the other end).
    expect(fx.requestRenders).toBe(1);
    expect(fx.renders).toBe(0);
    expect(fx.host.queueRefreshPending).toBe(false);
  });

  it('fetches when a TRAINING entry has come due and the build queue is empty', async () => {
    // The two queues arrive on the same tick and are checked by one `||`. A due test that only
    // reads buildQueue leaves finished troops sitting in the barracks list, which is the same
    // invisible symptom one page over.
    const getMe = vi.fn(async () => me());
    const fx = pollFixture(me({ buildQueue: [], trainingQueue: [train(NOW - 1)] }), getMe);
    refreshOnQueueDue(fx.host);
    await settle();
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while every entry is still in the future', async () => {
    const getMe = vi.fn(async () => me());
    const fx = pollFixture(
      me({ buildQueue: [build(NOW + 1)], trainingQueue: [train(NOW + 60_000)] }),
      getMe,
    );
    refreshOnQueueDue(fx.host);
    await settle();
    expect(getMe).not.toHaveBeenCalled();
    expect(fx.requestRenders).toBe(0);
  });

  it('treats completeAt exactly == now as due (the boundary the 1 Hz tick lands on)', async () => {
    const getMe = vi.fn(async () => me());
    const fx = pollFixture(me({ buildQueue: [build(NOW)] }), getMe);
    refreshOnQueueDue(fx.host);
    await settle();
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('does not fetch with both queues absent, or with both empty', async () => {
    const getMe = vi.fn(async () => me());
    for (const state of [me(), me({ buildQueue: [], trainingQueue: [] })]) {
      getMe.mockClear();
      refreshOnQueueDue(pollFixture(state, getMe).host);
      await settle();
      expect(getMe).not.toHaveBeenCalled();
    }
  });

  it('does not fetch before `me` has landed', async () => {
    const getMe = vi.fn(async () => me());
    refreshOnQueueDue(pollFixture(null, getMe).host);
    await settle();
    expect(getMe).not.toHaveBeenCalled();
  });

  it('does not fetch once the scene is destroyed', async () => {
    const getMe = vi.fn(async () => me());
    const fx = pollFixture(me({ buildQueue: [build(NOW - 1)] }), getMe);
    fx.kill();
    refreshOnQueueDue(fx.host);
    await settle();
    expect(getMe).not.toHaveBeenCalled();
  });

  it('coalesces: a due entry polled every tick issues ONE request while the first is in flight', async () => {
    // The failure this pins is not a wrong number, it is request volume. getMe slower than the 1 Hz
    // tick (a lagging worldsvc is exactly when a queue entry sits due) would otherwise mean one
    // in-flight request per second, against rateGate's 5-token FIFO bucket — starving the fetches
    // the player is actually waiting on.
    const d = deferred<PlayerWorldView>();
    const getMe = vi.fn(() => d.promise);
    const fx = pollFixture(me({ buildQueue: [build(NOW - 1)] }), getMe);

    for (let tick = 0; tick < 5; tick++) refreshOnQueueDue(fx.host);
    expect(getMe).toHaveBeenCalledTimes(1);

    d.resolve(me({ buildQueue: [] }));
    await settle();
    expect(fx.requestRenders).toBe(1);
    // ...and the gate reopens afterwards, so this is coalescing and not a one-shot.
    expect(fx.host.queueRefreshPending).toBe(false);
  });

  it('retries on the next tick when the server has not settled the entry yet', async () => {
    // Scheduler lag: getMe answers with the entry still present. Nothing marks it "handled", so
    // the next tick must go again — the poll's own doc comment promises this.
    const stillDue = me({ buildQueue: [build(NOW - 1)] });
    const getMe = vi.fn(async () => stillDue);
    const fx = pollFixture(stillDue, getMe);

    refreshOnQueueDue(fx.host);
    await settle();
    refreshOnQueueDue(fx.host);
    await settle();

    expect(getMe).toHaveBeenCalledTimes(2);
    expect(fx.requestRenders).toBe(2);
  });

  it('releases the guard after a rejected fetch, so one offline tick cannot wedge the poll', async () => {
    // Drop the `.finally` and this is the shipped bug: a single failed request leaves
    // queueRefreshPending true forever, the queue never refreshes again for the rest of the
    // session, and the only visible symptom is a finished building that will not go away.
    const getMe = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(me({ buildQueue: [] }));
    const fx = pollFixture(me({ buildQueue: [build(NOW - 1)] }), getMe);

    refreshOnQueueDue(fx.host);
    await settle();
    expect(fx.host.queueRefreshPending).toBe(false);
    expect(fx.requestRenders).toBe(0); // a failed fetch paints nothing

    refreshOnQueueDue(fx.host);
    await settle();
    expect(getMe).toHaveBeenCalledTimes(2);
    expect(fx.requestRenders).toBe(1);
  });

  it('drops an answer that lands after teardown (no setMe, no repaint) but still releases the guard', async () => {
    const d = deferred<PlayerWorldView>();
    const getMe = vi.fn(() => d.promise);
    const fx = pollFixture(me({ buildQueue: [build(NOW - 1)] }), getMe);

    refreshOnQueueDue(fx.host);
    fx.kill();
    d.resolve(me({ buildQueue: [] }));
    await settle();

    expect(fx.adopted).toEqual([]);
    expect(fx.requestRenders).toBe(0);
    expect(fx.host.queueRefreshPending).toBe(false);
  });
});

interface LoadFixture {
  host: DataHost;
  kill(): void;
  calls: string[];
  renders: number;
  setMeCalls: number;
}

function loadFixture(
  api: Partial<Record<'getTeams' | 'getMe' | 'getMarches' | 'getOccupations' | 'getStationed', () => Promise<unknown>>>,
): LoadFixture {
  let destroyed = false;
  const fx: LoadFixture = {
    calls: [], renders: 0, setMeCalls: 0, host: null as unknown as DataHost,
    kill() { destroyed = true; },
  };
  const wrap = (name: keyof typeof api, fallback: unknown) => (worldId: string) => {
    fx.calls.push(`${name}:${worldId}`);
    return api[name] ? api[name]!() : Promise.resolve(fallback);
  };
  fx.host = {
    cb: {
      worldId: 'w1',
      worldApi: {
        getTeams: wrap('getTeams', []),
        getMe: wrap('getMe', me()),
        getMarches: wrap('getMarches', []),
        getOccupations: wrap('getOccupations', []),
        getStationed: wrap('getStationed', []),
      },
    } as never,
    get destroyed() { return destroyed; },
    me: null,
    teams: [], marches: [], occupations: [], stationed: [],
    teamsLoaded: false, ordersLoaded: false,
    setMe() { fx.setMeCalls++; },
    render() { fx.renders++; },
    requestRender() {},
  } as unknown as DataHost;
  return fx;
}

describe('CityScene/data load', () => {
  beforeEach(() => { resAtlas.mockClear(); cityBldAtlas.mockClear(); });

  it('issues getTeams first (rateGate hands out its bucket strictly FIFO)', () => {
    const fx = loadFixture({});
    load(fx.host);
    // The order is load-bearing, not cosmetic: with the 5-token bucket drained on world-map entry,
    // whatever went last waits for a refill. The team row is what the player is looking at here.
    expect(fx.calls[0]).toBe('getTeams:w1');
    expect(fx.calls).toEqual([
      'getTeams:w1', 'getMe:w1', 'getMarches:w1', 'getOccupations:w1', 'getStationed:w1',
    ]);
  });

  it('paints as each slice lands instead of waiting for the slowest (not a Promise.all barrier)', async () => {
    // The 2026-08-02 decision. Hold the three order slices open; teams alone must already have
    // painted. Reintroduce a barrier and this goes red at `renders === 0` — the only other signal
    // is a few hundred ms of placeholder in the team row, which reads as a slow network.
    // Atlases held open: otherwise their two unconditional `.then(() => host.render())` edges
    // satisfy `renders > 0` on their own and the assertion below stops meaning anything (the
    // vacuous-assertion trap from claudedocs/client-testing.md).
    resAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    cityBldAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    const held = deferred<unknown[]>();
    const fx = loadFixture({
      getMarches: () => held.promise,
      getOccupations: () => held.promise,
      getStationed: () => held.promise,
    });
    load(fx.host);
    await settle();

    expect(fx.host.teamsLoaded).toBe(true);
    expect(fx.setMeCalls).toBe(1);
    expect(fx.renders).toBeGreaterThan(0);
    expect(fx.host.ordersLoaded).toBe(false); // and the order line is still honestly "loading"

    held.resolve([]);
    await settle();
    expect(fx.host.ordersLoaded).toBe(true);
  });

  it('flips ordersLoaded only once ALL THREE order slices have settled', async () => {
    // marches + occupations + stationed all feed teamOrder(); the status line must not claim
    // 驻军在家 while a station fetch is still open. Two of three settling must not be enough.
    const marches = deferred<unknown[]>();
    const occupations = deferred<unknown[]>();
    const stationed = deferred<unknown[]>();
    const fx = loadFixture({
      getMarches: () => marches.promise,
      getOccupations: () => occupations.promise,
      getStationed: () => stationed.promise,
    });
    load(fx.host);

    marches.resolve([]);
    await settle();
    expect(fx.host.ordersLoaded).toBe(false);
    occupations.resolve([]);
    await settle();
    expect(fx.host.ordersLoaded).toBe(false);
    stationed.resolve([]);
    await settle();
    expect(fx.host.ordersLoaded).toBe(true);
  });

  it('an offline slice still settles its flag — the row falls through to its real empty state', async () => {
    resAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    cityBldAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    const fx = loadFixture({
      getTeams: () => Promise.reject(new Error('offline')),
      getMe: () => Promise.reject(new Error('offline')),
      getMarches: () => Promise.reject(new Error('offline')),
      getOccupations: () => Promise.reject(new Error('offline')),
      getStationed: () => Promise.reject(new Error('offline')),
    });
    load(fx.host);
    await settle();

    // teamsLoaded/ordersLoaded exist to distinguish "none" from "not fetched yet". If a rejection
    // left them false, the scene would show a loading placeholder forever instead of the empty state.
    expect(fx.host.teamsLoaded).toBe(true);
    expect(fx.host.ordersLoaded).toBe(true);
    expect(fx.setMeCalls).toBe(0);
    expect(fx.renders).toBeGreaterThan(0);
  });

  it('repaints once each atlas decodes, and survives a decode failure', async () => {
    resAtlas.mockReturnValueOnce(Promise.reject(new Error('decode')));
    const fx = loadFixture({});
    load(fx.host);
    await settle();
    expect(resAtlas).toHaveBeenCalledTimes(1);
    expect(cityBldAtlas).toHaveBeenCalledTimes(1);
    // The failed one falls through to the colour/emoji path; the other still triggers its repaint.
    expect(fx.renders).toBeGreaterThan(0);
  });

  it('suppresses every DATA paint once the scene is destroyed mid-flight', async () => {
    // Atlas decodes are held open here on purpose, so this counts only the paints `load` itself
    // gates. The two atlas `.then(() => host.render())` edges are deliberately NOT gated (see the
    // next case) — mixing them in would make this assertion unfalsifiable.
    resAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    cityBldAtlas.mockReturnValueOnce(new Promise<void>(() => {}));
    const held = deferred<unknown[]>();
    const fx = loadFixture({
      getTeams: () => held.promise,
      getMe: () => held.promise as never,
      getMarches: () => held.promise,
      getOccupations: () => held.promise,
      getStationed: () => held.promise,
    });
    load(fx.host);
    fx.kill();
    held.resolve([]);
    await settle();

    // Flags are still bookkeeping (harmless on a dead host); what must not happen is drawing into
    // a torn-down container.
    expect(fx.host.teamsLoaded).toBe(true);
    expect(fx.host.ordersLoaded).toBe(true);
    expect(fx.renders).toBe(0);
  });

  it('the two atlas repaints are NOT destroy-gated here — CityScene.render() is the guard', async () => {
    // Recording the asymmetry rather than asserting it away. `load`'s API slices route through a
    // local `paint()` that checks `host.destroyed`; the atlas `.then`s call `host.render()` raw.
    // That is safe only because the real dispatcher (`CityScene.render()`) opens with
    // `if (core.destroyed) return;`. If this ever goes red because the atlas edges were gated too,
    // that is an improvement — but if the dispatcher's own guard is ever removed, THIS is the case
    // that says where the second one has to go.
    const fx = loadFixture({
      getTeams: () => new Promise(() => {}),
      getMe: () => new Promise(() => {}),
      getMarches: () => new Promise(() => {}),
      getOccupations: () => new Promise(() => {}),
      getStationed: () => new Promise(() => {}),
    });
    load(fx.host);
    fx.kill();
    await settle();
    expect(fx.renders).toBe(2);
  });
});
