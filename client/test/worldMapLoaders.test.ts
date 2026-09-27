// Coverage for `client/src/scenes/worldmap/net/loaders.ts` — the seven "fetch and cache" calls the
// whole SLG map is built out of (entry payload, viewport tiles, the four order slices, me, cities,
// teams, territories).
//
// 0% until now, and what makes that worth fixing is the shape every one of them shares: **an empty
// catch**. `catch { /* offline OK */ }` appears seven times in 122 lines, which is the right call
// for a map that has to survive a dead network — and it also means a loader that fetches the wrong
// thing, writes the wrong field, or drops half its payload is indistinguishable from being offline.
// Nothing throws, nothing is logged, the map just shows stale or missing state. The sibling file
// `push.ts` is gated for the same reason and one level worse (nothing refetches behind it); these
// are what push.ts calls when it needs fresh data, so a silent failure here surfaces there.
//
// The cases below are about which call is made, which field it lands in, and what survives a
// failure — not about wording:
//   · the `destroyed` guard exists TWICE per function (before the fetch and after the await), and
//     the second one is the one that matters: rendering into a torn-down scene is the leak class
//     `claudedocs/client-memory-leak.md` §8 is about, and the await is exactly the window a player
//     leaves the SLG in;
//   · `zoom` picks the endpoint AND the LOD ('thin' at 3, 'mid' at 2) — take the wrong branch and
//     the map is either 64x more bandwidth than asked for or permanently missing tile detail;
//   · `entry.map` vs `entry.mapSparse` are two different synthesis paths into the same `tileCache`,
//     and the sparse one has to carry the four ownership flags or every ally tile paints as neutral;
//   · `teamsLoaded` latches on first success and is never cleared, so an offline blip must not make
//     the team panel claim the player has no teams;
//   · what an offline call must NOT do: overwrite the last good value with an empty one.
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  loadData, loadMapViewport, refreshMarches, refreshMe, refreshCities, refreshTeams,
  refreshTerritories,
} from '../src/scenes/worldmap/net/loaders';
import { setLocale, t } from '../src/i18n';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';

/** Everything the fake records, so a case can assert on effects instead of on internals. */
interface Fake {
  ctx: WorldMapContext;
  api: Record<string, ReturnType<typeof vi.fn>>;
  toasts: string[];
  hudRenders: number;
  mapRenders: number;
  centered: Array<[number, number]>;
}

const WORLD = 'w1';

/** A minimal `/world/enter` payload — every field the loader reads, with nothing in it. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    season: { mapW: 512, mapH: 512 },
    nations: [{ id: 1 }],
    cities: [{ id: 'c1' }],
    me: { joined: true },
    marches: [], occupations: [], stationed: [], siegeHolds: [],
    worldChannel: [],
    ...over,
  };
}

function fake(over: Partial<{ destroyed: boolean; zoom: 1 | 2 | 3; seenTs: number; flag: boolean }> = {}): Fake {
  const f: Fake = {
    toasts: [], hudRenders: 0, mapRenders: 0, centered: [],
    api: {}, ctx: null as unknown as WorldMapContext,
  };
  // Every endpoint resolves empty by default; a case overrides just the one it is about.
  for (const name of [
    'enterWorld', 'getMap', 'getMapSparse', 'getOrders', 'getMe', 'getCities', 'getTeams', 'getTerritories',
  ]) {
    f.api[name] = vi.fn(async () => ({ tiles: [] }));
  }
  f.api.enterWorld!.mockImplementation(async () => entry());
  for (const name of ['getTeams', 'getTerritories', 'getCities']) {
    f.api[name]!.mockImplementation(async () => []);
  }
  f.api.getOrders!.mockImplementation(async () => orders());
  f.api.getMe!.mockImplementation(async () => ({ joined: true }));

  const ctx = {
    destroyed: over.destroyed ?? false,
    zoom: over.zoom ?? 1,
    mapW: 100, mapH: 100,
    season: null as unknown,
    nations: [] as unknown[],
    cityNodes: null as unknown,
    me: null as unknown,
    marches: ['old'] as unknown[],
    occupations: ['old'] as unknown[],
    stationed: ['old'] as unknown[],
    siegeHolds: ['old'] as unknown[],
    teams: ['old'] as unknown[],
    teamsLoaded: false,
    territories: ['old'] as unknown[],
    guideStep: null as unknown,
    worldChatLatest: null as unknown,
    worldChatUnread: 0,
    getWorldChatSeenTs: () => over.seenTs ?? 0,
    tileCache: new Map<string, unknown>(),
    parseTileId: (id: string) => {
      const [, x, y] = id.split(':');
      return [Number(x), Number(y)] as [number, number];
    },
    cb: {
      worldId: WORLD,
      worldApi: f.api,
      getFlag: (_k: string) => over.flag ?? false,
    },
    view: {
      viewportCenter: () => ({ cx: 10, cy: 20, r: 7 }),
      centerAt: (x: number, y: number) => { f.centered.push([x, y]); },
      renderMap: () => { f.mapRenders++; },
    },
    panels: {
      renderHud: () => { f.hudRenders++; },
      showToast: (msg: string) => { f.toasts.push(msg); },
    },
  };
  f.ctx = ctx as unknown as WorldMapContext;
  return f;
}

/**
 * Reject on a LATER tick, the way a real fetch fails.
 *
 * `async () => { throw }` rejects with a body that ran synchronously up to the throw, which is
 * close enough here — but `destroyed` flipping mid-flight is not reproducible that way at all, so
 * both helpers go through a real macrotask and stay honest about the await window.
 */
function orders(o: Partial<Record<'marches' | 'occupations' | 'stationed' | 'siegeHolds', unknown[]>> = {}) {
  return { marches: [], occupations: [], stationed: [], siegeHolds: [], ...o };
}

function later<T>(value: T | (() => T)): () => Promise<T> {
  return async () => {
    await new Promise<void>((r) => { setTimeout(r, 0); });
    return typeof value === 'function' ? (value as () => T)() : value;
  };
}

function failsLater(): () => Promise<never> {
  return async () => {
    await new Promise<void>((r) => { setTimeout(r, 0); });
    throw new Error('offline');
  };
}

beforeEach(() => {
  setLocale('zh');
});

// ── The teardown guard ──────────────────────────────────────────────────────────────────────

describe('loaders — teardown', () => {
  it('every loader makes no request at all once ctx.destroyed', async () => {
    const f = fake({ destroyed: true });
    await Promise.all([
      loadData(f.ctx), loadMapViewport(f.ctx), refreshMarches(f.ctx), refreshMe(f.ctx),
      refreshCities(f.ctx), refreshTeams(f.ctx), refreshTerritories(f.ctx),
    ]);
    for (const [name, fn] of Object.entries(f.api)) {
      expect(fn, `${name} was called on a destroyed scene`).not.toHaveBeenCalled();
    }
    expect(f.mapRenders + f.hudRenders).toBe(0);
  });

  it('a scene torn down DURING the entry fetch does not paint', async () => {
    // The real case: the player taps back while `/world/enter` is in flight. The second guard is
    // the only thing between that and a render call into a destroyed scene graph.
    const f = fake();
    f.api.enterWorld!.mockImplementation(later(() => entry()));
    const p = loadData(f.ctx);
    (f.ctx as unknown as { destroyed: boolean }).destroyed = true;
    await p;
    expect(f.mapRenders).toBe(0);
    expect(f.hudRenders).toBe(0);
  });

  it('a scene torn down during the order-slice refetch keeps the data but skips the paint', async () => {
    const f = fake();
    f.api.getOrders!.mockImplementation(later(orders({ marches: ['m1'] })));
    const p = refreshMarches(f.ctx);
    (f.ctx as unknown as { destroyed: boolean }).destroyed = true;
    await p;
    expect(f.ctx.marches).toEqual(['m1']);
    expect(f.mapRenders + f.hudRenders).toBe(0);
  });

  it('a scene torn down during getMe skips the HUD paint', async () => {
    const f = fake();
    f.api.getMe!.mockImplementation(later({ joined: true, tag: 'fresh' }));
    const p = refreshMe(f.ctx);
    (f.ctx as unknown as { destroyed: boolean }).destroyed = true;
    await p;
    expect(f.ctx.me).toMatchObject({ tag: 'fresh' });
    expect(f.hudRenders).toBe(0);
  });

  it('a scene torn down during getTeams still latches teamsLoaded but skips the paint', async () => {
    const f = fake();
    f.api.getTeams!.mockImplementation(later([{ id: 't1' }]));
    const p = refreshTeams(f.ctx);
    (f.ctx as unknown as { destroyed: boolean }).destroyed = true;
    await p;
    expect(f.ctx.teamsLoaded).toBe(true);
    expect(f.hudRenders).toBe(0);
  });
});

// ── loadData: the single entry round-trip ───────────────────────────────────────────────────

describe('loadData — the entry payload', () => {
  it('asks for the viewport radius and the current zoom, and lands every slice', async () => {
    const f = fake({ zoom: 2 });
    f.api.enterWorld!.mockImplementation(async () => entry({
      season: { mapW: 400, mapH: 300 },
      nations: [{ id: 7 }],
      cities: [{ id: 'c9' }],
      marches: ['m'], occupations: ['o'], stationed: ['s'], siegeHolds: ['h'],
    }));
    await loadData(f.ctx);
    // r comes from the canvas, not from the camera — it is readable before `me` is known, which is
    // the whole reason the entry call can be a single round-trip.
    expect(f.api.enterWorld).toHaveBeenCalledWith(WORLD, 7, 2);
    expect(f.ctx.mapW).toBe(400);
    expect(f.ctx.mapH).toBe(300);
    expect(f.ctx.nations).toEqual([{ id: 7 }]);
    expect(f.ctx.cityNodes).toEqual([{ id: 'c9' }]);
    expect(f.ctx.marches).toEqual(['m']);
    expect(f.ctx.occupations).toEqual(['o']);
    expect(f.ctx.stationed).toEqual(['s']);
    expect(f.ctx.siegeHolds).toEqual(['h']);
    expect(f.mapRenders).toBe(1);
    expect(f.hudRenders).toBeGreaterThanOrEqual(1);
  });

  it('keeps the existing map size when the world has no season doc, or a zero-sized one', async () => {
    // A shard with no provisioned world doc answers `season: null`. Taking 0x0 from it would make
    // every coordinate clamp collapse; the defaults have to survive.
    const f = fake();
    f.api.enterWorld!.mockImplementation(async () => entry({ season: null }));
    await loadData(f.ctx);
    expect([f.ctx.mapW, f.ctx.mapH]).toEqual([100, 100]);

    const g = fake();
    g.api.enterWorld!.mockImplementation(async () => entry({ season: { mapW: 0, mapH: 0 } }));
    await loadData(g.ctx);
    expect([g.ctx.mapW, g.ctx.mapH]).toEqual([100, 100]);
    expect(g.ctx.season).toEqual({ mapW: 0, mapH: 0 });
  });

  it('centers on the resolved main base and greets a player who just joined', async () => {
    const f = fake();
    f.api.enterWorld!.mockImplementation(async () => entry({
      me: { joined: true, justJoined: true, mainBaseTile: 'w1:12:34' },
    }));
    await loadData(f.ctx);
    expect(f.centered).toEqual([[12, 34]]);
    expect(f.toasts).toEqual([t('world.myBase')]);
  });

  it('does not greet a returning player, and does not center when there is no base yet', async () => {
    const f = fake();
    f.api.enterWorld!.mockImplementation(async () => entry({ me: { joined: true } }));
    await loadData(f.ctx);
    expect(f.toasts).toEqual([]);
    expect(f.centered).toEqual([]);
    expect(f.ctx.guideStep).toBeNull();
  });

  it('arms the opening guide off the FLAG, not off justJoined', async () => {
    // Deliberate (ONBOARDING_DESIGN §4.2): a player who joined before the guide shipped has no
    // `justJoined` any more and must still get it once. Keyed on justJoined it would never fire
    // for exactly the population that has never seen it.
    const f = fake({ flag: false });
    f.api.enterWorld!.mockImplementation(async () => entry({
      me: { joined: true, mainBaseTile: 'w1:5:6' },   // NOT justJoined
    }));
    await loadData(f.ctx);
    expect(f.ctx.guideStep).toBe('step1');

    const seen = fake({ flag: true });
    seen.api.enterWorld!.mockImplementation(async () => entry({
      me: { joined: true, justJoined: true, mainBaseTile: 'w1:5:6' },
    }));
    await loadData(seen.ctx);
    expect(seen.ctx.guideStep).toBeNull();
  });

  it('survives a platform with no flag reader at all', async () => {
    const f = fake();
    (f.ctx.cb as unknown as { getFlag?: unknown }).getFlag = undefined;
    f.api.enterWorld!.mockImplementation(async () => entry({
      me: { joined: true, mainBaseTile: 'w1:5:6' },
    }));
    await loadData(f.ctx);
    expect(f.ctx.guideStep).toBe('step1');
  });

  it('caches full tiles from entry.map', async () => {
    const f = fake();
    f.api.enterWorld!.mockImplementation(async () => entry({
      map: { tiles: [{ x: 1, y: 2, type: 'plain', level: 3 }] },
    }));
    await loadData(f.ctx);
    expect(f.ctx.tileCache.get('1:2')).toMatchObject({ level: 3 });
  });

  it('synthesizes tiles from entry.mapSparse, carrying all four ownership flags', async () => {
    // The sparse payload has no level/ownerName — only "somebody owns this, and how you relate to
    // them". Drop a flag here and an ally's territory paints as neutral ground on first entry.
    const f = fake();
    f.api.enterWorld!.mockImplementation(async () => entry({
      mapSparse: {
        tiles: [
          { x: 3, y: 4, type: 'hill', mine: true },
          { x: 5, y: 6, type: 'hill', ally: true, sectmate: true, allySect: true },
          { x: 7, y: 8, type: 'hill' },
        ],
      },
    }));
    await loadData(f.ctx);
    expect(f.ctx.tileCache.get('3:4')).toMatchObject({ type: 'hill', level: 1, occupied: true, mine: true });
    expect(f.ctx.tileCache.get('5:6')).toMatchObject({ ally: true, sectmate: true, allySect: true });
    // Absent flags stay ABSENT rather than becoming `false` — the renderer tests presence.
    expect(f.ctx.tileCache.get('7:8')).not.toHaveProperty('mine');
  });

  it('takes the newest world-chat line and counts only what is newer than the seen stamp', async () => {
    const f = fake({ seenTs: 100 });
    f.api.enterWorld!.mockImplementation(async () => entry({
      worldChannel: [{ ts: 300 }, { ts: 200 }, { ts: 100 }, { ts: 50 }],   // newest-first
    }));
    await loadData(f.ctx);
    expect(f.ctx.worldChatLatest).toEqual({ ts: 300 });
    // Strictly newer: the message AT the seen stamp is the one that was read last.
    expect(f.ctx.worldChatUnread).toBe(2);
  });

  it('leaves the latest line null on an empty channel', async () => {
    const f = fake();
    await loadData(f.ctx);
    expect(f.ctx.worldChatLatest).toBeNull();
    expect(f.ctx.worldChatUnread).toBe(0);
  });

  it('still paints, and still fetches teams, when the entry call fails outright', async () => {
    // Offline entry is a normal state, not an error state: the map has to come up on whatever the
    // scene already had. What must NOT happen is the paint being skipped, which would leave the
    // player on a blank screen with no way to retry but leaving.
    const f = fake();
    f.api.enterWorld!.mockImplementation(failsLater());
    await loadData(f.ctx);
    expect(f.mapRenders).toBe(1);
    expect(f.hudRenders).toBeGreaterThanOrEqual(1);
    expect(f.api.getTeams).toHaveBeenCalled();
    expect(f.ctx.marches).toEqual(['old']);
  });
});

// ── loadMapViewport: which endpoint, which LOD ──────────────────────────────────────────────

describe('loadMapViewport — the zoom branch', () => {
  it('at zoom 1 asks for full tiles', async () => {
    const f = fake({ zoom: 1 });
    f.api.getMap!.mockImplementation(async () => ({ tiles: [{ x: 1, y: 1, type: 'plain', level: 2 }] }));
    await loadMapViewport(f.ctx);
    expect(f.api.getMap).toHaveBeenCalledWith(WORLD, 10, 20, 7);
    expect(f.api.getMapSparse).not.toHaveBeenCalled();
    expect(f.ctx.tileCache.get('1:1')).toMatchObject({ level: 2 });
  });

  it('at zoom 2 and 3 asks for the sparse layer, at the LOD that zoom level implies', async () => {
    for (const [zoom, lod] of [[2, 'mid'], [3, 'thin']] as const) {
      const f = fake({ zoom });
      f.api.getMapSparse!.mockImplementation(async () => ({ tiles: [{ x: 9, y: 9, type: 'hill', ally: true }] }));
      await loadMapViewport(f.ctx);
      expect(f.api.getMapSparse, `zoom ${zoom}`).toHaveBeenCalledWith(WORLD, 10, 20, 7, lod);
      expect(f.api.getMap).not.toHaveBeenCalled();
      expect(f.ctx.tileCache.get('9:9')).toMatchObject({ level: 1, occupied: true, ally: true });
    }
  });

  it('carries all four ownership flags through the viewport synthesis too', async () => {
    // A second, byte-identical copy of the synthesis in loadData — covered separately on purpose:
    // two copies of the same eight lines are exactly where one of them loses a flag in an edit and
    // the symptom (ally land painting neutral) only shows at one zoom level.
    const f = fake({ zoom: 2 });
    f.api.getMapSparse!.mockImplementation(async () => ({
      tiles: [
        { x: 1, y: 1, type: 'hill', mine: true, sectmate: true, allySect: true },
        { x: 2, y: 2, type: 'hill' },
      ],
    }));
    await loadMapViewport(f.ctx);
    expect(f.ctx.tileCache.get('1:1')).toMatchObject({ mine: true, sectmate: true, allySect: true });
    expect(f.ctx.tileCache.get('2:2')).not.toHaveProperty('ally');
  });

  it('keeps the tiles it already had when the fetch fails', async () => {
    const f = fake();
    f.ctx.tileCache.set('1:1', { x: 1, y: 1 } as never);
    f.api.getMap!.mockImplementation(failsLater());
    await loadMapViewport(f.ctx);
    expect(f.ctx.tileCache.size).toBe(1);
  });
});

// ── The refreshers ──────────────────────────────────────────────────────────────────────────

describe('the order slices', () => {
  it('refreshMarches lands all four slices and repaints both layers', async () => {
    // Four, not three: a team pinned to a won assault for the damage delay is in `siegeHolds` and
    // in none of the other three, so a refresh that forgot it reported that team as idle at home
    // (2026-09-12).
    const f = fake();
    f.api.getOrders!.mockImplementation(async () => orders({ marches: ['m'], occupations: ['o'], stationed: ['s'], siegeHolds: ['h'] }));
    await refreshMarches(f.ctx);
    expect([f.ctx.marches, f.ctx.occupations, f.ctx.stationed, f.ctx.siegeHolds])
      .toEqual([['m'], ['o'], ['s'], ['h']]);
    expect(f.mapRenders).toBe(1);
    expect(f.hudRenders).toBe(1);
  });

  it('refreshMarches keeps every slice when the read fails', async () => {
    // All-or-nothing: a half-applied order set is what makes a team look busy forever.
    const f = fake();
    f.api.getOrders!.mockImplementation(failsLater());
    await refreshMarches(f.ctx);
    expect(f.ctx.marches).toEqual(['old']);
    expect(f.ctx.occupations).toEqual(['old']);
    expect(f.mapRenders).toBe(0);
  });

  // 2026-09-26: every march_update push, the team picker, recall and stop-hold all call this. Each
  // used to be its own four requests, and during a five-team dispatch they queued behind the 5 req/s
  // rate gate ahead of the player's next order.
  it('collapses calls made while a read is in flight into ONE trailing read', async () => {
    const f = fake();
    const gates: Array<() => void> = [];
    let n = 0;
    f.api.getOrders!.mockImplementation(() => new Promise((resolve) => {
      const tag = `read${++n}`;
      gates.push(() => resolve(orders({ marches: [tag] })));
    }));
    const first = refreshMarches(f.ctx);
    const joiners = [refreshMarches(f.ctx), refreshMarches(f.ctx), refreshMarches(f.ctx)];
    expect(f.api.getOrders).toHaveBeenCalledTimes(1);

    gates[0]!();
    await vi.waitFor(() => expect(f.api.getOrders).toHaveBeenCalledTimes(2));
    gates[1]!();
    await Promise.all([first, ...joiners]);
    expect(f.api.getOrders).toHaveBeenCalledTimes(2); // not 4
    expect(f.ctx.marches).toEqual(['read2']);
  });

  it('a caller that joins mid-flight is resolved only after a read that started after it asked', async () => {
    // The team picker awaits this and then judges who is busy from ctx — so "resolved" must mean
    // "fresh as of my call", never "the read that was already half-way back when I asked".
    const f = fake();
    const gates: Array<() => void> = [];
    let n = 0;
    f.api.getOrders!.mockImplementation(() => new Promise((resolve) => {
      const tag = `read${++n}`;
      gates.push(() => resolve(orders({ marches: [tag] })));
    }));
    void refreshMarches(f.ctx);
    let joinedSaw: unknown = null;
    const joined = refreshMarches(f.ctx).then(() => { joinedSaw = f.ctx.marches; });

    gates[0]!();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(joinedSaw).toBeNull(); // the first read landing is NOT enough
    gates[1]!();
    await joined;
    expect(joinedSaw).toEqual(['read2']);
  });

  it('once a refresh has fully settled, the next call starts a fresh read immediately', async () => {
    const f = fake();
    await refreshMarches(f.ctx);
    await refreshMarches(f.ctx);
    expect(f.api.getOrders).toHaveBeenCalledTimes(2);
  });

  it('refreshMe replaces me, repaints the HUD and picks up re-armed teams', async () => {
    const f = fake();
    f.api.getMe!.mockImplementation(async () => ({ joined: true, tag: 'fresh' }));
    f.api.getTeams!.mockImplementation(async () => [{ id: 't1' }]);
    await refreshMe(f.ctx);
    expect(f.ctx.me).toMatchObject({ tag: 'fresh' });
    expect(f.hudRenders).toBeGreaterThanOrEqual(1);
    // The overlays worth calling refreshMe from (city, formation, defense editor) are the same ones
    // that can have re-crewed a team, so the roster comes along.
    expect(f.api.getTeams).toHaveBeenCalled();
  });

  it('refreshMe keeps the last known me when the call fails', async () => {
    const f = fake();
    f.ctx.me = { joined: true, tag: 'stale' } as never;
    f.api.getMe!.mockImplementation(failsLater());
    await refreshMe(f.ctx);
    expect(f.ctx.me).toMatchObject({ tag: 'stale' });
  });

  it('refreshCities replaces the entry snapshot, and keeps it on failure', async () => {
    const f = fake();
    f.api.getCities!.mockImplementation(async () => [{ id: 'fresh' }]);
    await refreshCities(f.ctx);
    expect(f.ctx.cityNodes).toEqual([{ id: 'fresh' }]);

    f.api.getCities!.mockImplementation(failsLater());
    await refreshCities(f.ctx);
    expect(f.ctx.cityNodes).toEqual([{ id: 'fresh' }]);
  });

  it('refreshTerritories replaces the list, and keeps it on failure', async () => {
    const f = fake();
    f.api.getTerritories!.mockImplementation(async () => ['t']);
    await refreshTerritories(f.ctx);
    expect(f.ctx.territories).toEqual(['t']);

    f.api.getTerritories!.mockImplementation(failsLater());
    await refreshTerritories(f.ctx);
    expect(f.ctx.territories).toEqual(['t']);
  });

  it('refreshTeams latches teamsLoaded on first success and never unlatches it', async () => {
    // The latch is the whole point: an offline blip must not make the team panel say "you have no
    // teams", which is indistinguishable from a real empty roster and sends the player to build one.
    const f = fake();
    f.api.getTeams!.mockImplementation(async () => [{ id: 't1' }]);
    await refreshTeams(f.ctx);
    expect(f.ctx.teamsLoaded).toBe(true);
    expect(f.ctx.teams).toEqual([{ id: 't1' }]);
    expect(f.hudRenders).toBe(1);

    f.api.getTeams!.mockImplementation(failsLater());
    await refreshTeams(f.ctx);
    expect(f.ctx.teamsLoaded).toBe(true);
    expect(f.ctx.teams).toEqual([{ id: 't1' }]);
    expect(f.hudRenders).toBe(1);
  });
});
