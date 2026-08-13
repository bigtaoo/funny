// Coverage for WorldMapNet's `loadData`/`doRelocate`/`doWatchtower`/`doAbandon` — the 2026-08-05
// client-test-audit flagged these as "tests assert 'UI called net.xxx' but never let net.xxx's real
// body run": every existing test only ever mocks `net.doAbandon`/`net.confirmRelocate`/etc. as a
// `vi.fn()` on the WorldMapInput/Panels side and checks it "was called with args" — the real
// `relocateBase`/`buildWatchtower`/`abandonTile`/`enterWorld` request bodies, `ctx.me`/`tileCache`
// mutations, and success/failure toasts had never actually run.
//
// WorldMapNet touches no PIXI itself (all rendering goes through `ctx.view`/`ctx.panels`, which are
// mocked here) — dressed as a `.ui.ts` file to sit alongside the rest of the WorldMap client suite,
// same precedent as worldMapErrorMsg.ui.ts / worldMapOccupyTeamPicker.ui.ts (real `new
// WorldMapNet(ctx)` against a hand-rolled plain-object `ctx`, no headless PIXI scene needed).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { ui as C } from '../../src/render/sketchUi';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import * as loaders from '../../src/scenes/worldmap/net/loaders';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView, EnterWorldView } from '../../src/net/WorldApiClient';

// 2026-08-13 (claudedocs/client-modules.md "单文件 500 行收敛" split): WorldMapNet's methods are now
// thin delegates that call net/loaders.ts's free functions directly (module-scope, not `this.xxx`),
// so the old `vi.spyOn(net, 'loadMapViewport')` no longer intercepts anything — doRelocate/
// doWatchtower/doAbandon's own `loadMapViewport(ctx)` calls (in structures.ts) bypass the instance
// entirely. Mock the module instead, wrapping the real implementation by default
// (`vi.fn(actual.loadMapViewport)`) so tests that don't touch it still get the genuine behavior; the
// handful below that need call-count assertions or a stubbed-out implementation call
// `vi.mocked(loaders.loadMapViewport)` directly.
vi.mock('../../src/scenes/worldmap/net/loaders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scenes/worldmap/net/loaders')>();
  return { ...actual, loadMapViewport: vi.fn(actual.loadMapViewport) };
});

// No project-wide restoreMocks/clearMocks config — the module mock above is a single instance
// shared across every test in this file (unlike the old per-test `vi.spyOn(net, ...)`, which was
// fresh per test since buildHarness() made a new instance each time), so call-count assertions
// would leak across tests without this.
beforeEach(() => { vi.mocked(loaders.loadMapViewport).mockClear(); });

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return { joined: true, mainBaseTile: null, cardState: {}, ...overrides } as unknown as PlayerWorldView;
}

function makeEnterWorld(overrides: Partial<EnterWorldView> = {}): EnterWorldView {
  return {
    season: null,
    nations: [],
    me: { ...makeMe(), justJoined: false } as EnterWorldView['me'],
    marches: [],
    occupations: [],
    stationed: [],
    worldChannel: [],
    ...overrides,
  } as unknown as EnterWorldView;
}

/** Builds a real `WorldMapNet` against a plain-object `ctx` — mirrors
 *  worldMapOccupyTeamPicker.ui.ts's harness convention. */
function buildHarness(opts: { zoom?: 1 | 2 | 3 } = {}) {
  const renderMap = vi.fn();
  const centerAt = vi.fn();
  const viewportCenter = vi.fn(() => ({ cx: 0, cy: 0, r: 10 }));
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const renderHud = vi.fn();

  const enterWorld = vi.fn(async () => makeEnterWorld());
  const relocateBase = vi.fn(async () => makeMe());
  const buildWatchtower = vi.fn(async () => ({ me: makeMe() }));
  const abandonTile = vi.fn(async () => makeMe());
  const getMap = vi.fn(async () => ({ tiles: [] }));
  const getMapSparse = vi.fn(async () => ({ tiles: [] }));

  const ctx = {
    destroyed: false,
    zoom: opts.zoom ?? 1,
    tileCache: new Map(),
    me: null,
    marches: [],
    occupations: [],
    stationed: [],
    nations: [],
    season: null,
    mapW: 100,
    mapH: 100,
    worldChatLatest: null,
    worldChatUnread: 0,
    getWorldChatSeenTs: () => 0,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap, centerAt, viewportCenter },
    panels: { showToast, closeModal, renderHud },
    cb: { worldId: WORLD_ID, worldApi: { enterWorld, relocateBase, buildWatchtower, abandonTile, getMap, getMapSparse } },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, renderMap, centerAt, showToast, closeModal, renderHud, enterWorld, relocateBase, buildWatchtower, abandonTile, getMap, getMapSparse };
}

// ── loadData ──────────────────────────────────────────────────────────────────

describe('WorldMapNet.loadData()', () => {
  it('is a no-op when the scene is already destroyed', async () => {
    const { ctx, net, enterWorld, renderMap, renderHud } = buildHarness();
    ctx.destroyed = true;

    await net.loadData();

    expect(enterWorld).not.toHaveBeenCalled();
    expect(renderMap).not.toHaveBeenCalled();
    expect(renderHud).not.toHaveBeenCalled();
  });

  it('adopts season/mapW/mapH/nations/me, populates tileCache from a full map, and re-renders', async () => {
    const { ctx, net, enterWorld, renderMap, renderHud, centerAt } = buildHarness();
    enterWorld.mockResolvedValueOnce(makeEnterWorld({
      season: { seasonNo: 1, mapW: 200, mapH: 150 } as unknown as EnterWorldView['season'],
      nations: [{ id: 'n1' }] as unknown as EnterWorldView['nations'],
      me: { ...makeMe({ mainBaseTile: `${WORLD_ID}:5:7` }), justJoined: false } as EnterWorldView['me'],
      map: { tiles: [{ x: 5, y: 7, type: 'plain', level: 1, occupied: true }] } as unknown as EnterWorldView['map'],
      marches: [{ id: 'm1' }] as unknown as EnterWorldView['marches'],
    }));

    await net.loadData();

    expect(enterWorld).toHaveBeenCalledWith(WORLD_ID, 10, 1);
    expect(ctx.mapW).toBe(200);
    expect(ctx.mapH).toBe(150);
    expect(ctx.nations).toEqual([{ id: 'n1' }]);
    expect(ctx.me?.mainBaseTile).toBe(`${WORLD_ID}:5:7`);
    expect(centerAt).toHaveBeenCalledWith(5, 7);
    expect(ctx.tileCache.get('5:7')).toMatchObject({ x: 5, y: 7 });
    expect(ctx.marches).toEqual([{ id: 'm1' }]);
    expect(renderMap).toHaveBeenCalledTimes(1);
    expect(renderHud).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite mapW/mapH when season is null (no world doc yet)', async () => {
    const { ctx, net, enterWorld } = buildHarness();
    enterWorld.mockResolvedValueOnce(makeEnterWorld({ season: null }));

    await net.loadData();

    expect(ctx.mapW).toBe(100); // unchanged default
    expect(ctx.season).toBeNull();
  });

  it('toasts "My Base" only when justJoined is true', async () => {
    const { net, showToast, enterWorld } = buildHarness();
    enterWorld.mockResolvedValueOnce(makeEnterWorld({ me: { ...makeMe(), justJoined: true } as EnterWorldView['me'] }));

    await net.loadData();

    expect(showToast).toHaveBeenCalledWith(t('world.myBase'));
  });

  it('does not toast when justJoined is false', async () => {
    const { net, showToast } = buildHarness();
    await net.loadData();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('synthesizes a minimal tile from mapSparse (mine/ally/allySect flags) when no full map is returned', async () => {
    const { ctx, net, enterWorld } = buildHarness();
    enterWorld.mockResolvedValueOnce(makeEnterWorld({
      map: undefined,
      mapSparse: { tiles: [{ x: 3, y: 4, type: 'city', mine: true }] } as unknown as EnterWorldView['mapSparse'],
    }));

    await net.loadData();

    expect(ctx.tileCache.get('3:4')).toEqual({ x: 3, y: 4, type: 'city', level: 1, occupied: true, mine: true });
  });

  it('computes worldChatUnread from messages newer than the last-seen timestamp', async () => {
    const { ctx, net, enterWorld } = buildHarness();
    ctx.getWorldChatSeenTs = () => 100;
    enterWorld.mockResolvedValueOnce(makeEnterWorld({
      worldChannel: [{ ts: 200 }, { ts: 150 }, { ts: 50 }] as unknown as EnterWorldView['worldChannel'],
    }));

    await net.loadData();

    expect(ctx.worldChatLatest).toEqual({ ts: 200 });
    expect(ctx.worldChatUnread).toBe(2); // 200 and 150 are > seenTs(100); 50 is not
  });

  it('swallows a rejected enterWorld ("offline OK") and still re-renders', async () => {
    const { net, enterWorld, renderMap, renderHud, showToast } = buildHarness();
    enterWorld.mockRejectedValueOnce(new Error('network down'));

    await expect(net.loadData()).resolves.toBeUndefined();

    expect(renderMap).toHaveBeenCalledTimes(1);
    expect(renderHud).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not re-render if the scene was destroyed while the request was in flight', async () => {
    const { ctx, net, enterWorld, renderMap, renderHud } = buildHarness();
    enterWorld.mockImplementationOnce(async () => { ctx.destroyed = true; return makeEnterWorld(); });

    await net.loadData();

    expect(renderMap).not.toHaveBeenCalled();
    expect(renderHud).not.toHaveBeenCalled();
  });
});

// ── doRelocate ────────────────────────────────────────────────────────────────

describe('WorldMapNet.doRelocate()', () => {
  it('closes the modal, relocates, clears the tile cache, re-centers, refetches the viewport, and toasts', async () => {
    const { ctx, net, closeModal, relocateBase, renderMap, renderHud, showToast, centerAt } = buildHarness();
    ctx.tileCache.set('1:1', { x: 1, y: 1 } as never);
    relocateBase.mockResolvedValueOnce(makeMe({ mainBaseTile: `${WORLD_ID}:9:9` }));
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doRelocate(9, 9);

    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(relocateBase).toHaveBeenCalledWith(WORLD_ID, 9, 9);
    expect(ctx.tileCache.size).toBe(0); // old capital's neighborhood invalidated
    expect(centerAt).toHaveBeenCalledWith(9, 9);
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('world.relocated'));
    expect(renderMap).toHaveBeenCalledTimes(1);
    expect(renderHud).toHaveBeenCalledTimes(1);
  });

  it('skips re-centering when the response has no mainBaseTile', async () => {
    const { net, relocateBase, centerAt } = buildHarness();
    relocateBase.mockResolvedValueOnce(makeMe({ mainBaseTile: undefined }));
    vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doRelocate(2, 2);

    expect(centerAt).not.toHaveBeenCalled();
  });

  it('on failure: toasts the mapped error in red and never reaches the refetch/success toast', async () => {
    const { net, relocateBase, showToast, renderMap } = buildHarness();
    relocateBase.mockRejectedValueOnce(new Error('boom'));
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doRelocate(9, 9);

    expect(showToast).toHaveBeenCalledWith('Error: boom', C.red); // plain Error falls through errorMsg's WorldApiError-only mapping to String(e)
    expect(showToast).not.toHaveBeenCalledWith(t('world.relocated'));
    expect(loadMapViewport).not.toHaveBeenCalled();
    expect(renderMap).not.toHaveBeenCalled();
  });
});

// ── doWatchtower ──────────────────────────────────────────────────────────────

describe('WorldMapNet.doWatchtower()', () => {
  it('closes the modal, builds, adopts the returned me, clears the cache, refetches, and toasts', async () => {
    const { ctx, net, closeModal, buildWatchtower, renderMap, renderHud, showToast } = buildHarness();
    ctx.tileCache.set('1:1', { x: 1, y: 1 } as never);
    const newMe = makeMe({ mainBaseTile: `${WORLD_ID}:0:0` });
    buildWatchtower.mockResolvedValueOnce({ me: newMe });
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doWatchtower(4, 4);

    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(buildWatchtower).toHaveBeenCalledWith(WORLD_ID, 4, 4);
    expect(ctx.me).toBe(newMe);
    expect(ctx.tileCache.size).toBe(0);
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('world.watchtowerBuilt'));
    expect(renderMap).toHaveBeenCalledTimes(1);
    expect(renderHud).toHaveBeenCalledTimes(1);
  });

  it('defensively keeps the previous ctx.me when the response omits it', async () => {
    const { ctx, net, buildWatchtower } = buildHarness();
    const prevMe = makeMe({ mainBaseTile: `${WORLD_ID}:1:1` });
    ctx.me = prevMe;
    buildWatchtower.mockResolvedValueOnce({ me: undefined as unknown as PlayerWorldView });
    vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doWatchtower(4, 4);

    expect(ctx.me).toBe(prevMe);
  });

  it('on failure: toasts the mapped error and never refetches', async () => {
    const { net, buildWatchtower, showToast } = buildHarness();
    buildWatchtower.mockRejectedValueOnce(new Error('insufficient resources'));
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doWatchtower(4, 4);

    expect(showToast).toHaveBeenCalledWith('Error: insufficient resources', C.red);
    expect(loadMapViewport).not.toHaveBeenCalled();
  });
});

// ── doAbandon ─────────────────────────────────────────────────────────────────

describe('WorldMapNet.doAbandon()', () => {
  it('closes the modal, abandons, adopts me, removes only the abandoned tile, refetches, and re-renders — with NO success toast', async () => {
    const { ctx, net, closeModal, abandonTile, renderMap, renderHud, showToast } = buildHarness();
    ctx.tileCache.set('4:4', { x: 4, y: 4 } as never);
    ctx.tileCache.set('9:9', { x: 9, y: 9 } as never); // unrelated tile — must survive
    const newMe = makeMe();
    abandonTile.mockResolvedValueOnce(newMe);
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doAbandon(4, 4);

    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(abandonTile).toHaveBeenCalledWith(WORLD_ID, 4, 4);
    expect(ctx.me).toBe(newMe);
    expect(ctx.tileCache.has('4:4')).toBe(false);
    expect(ctx.tileCache.has('9:9')).toBe(true);
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(renderMap).toHaveBeenCalledTimes(1);
    expect(renderHud).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled(); // unlike relocate/watchtower, abandon has no happy-path toast
  });

  it('on failure: toasts the mapped error, never deletes the tile, and never refetches', async () => {
    const { ctx, net, abandonTile, showToast } = buildHarness();
    ctx.tileCache.set('4:4', { x: 4, y: 4 } as never);
    abandonTile.mockRejectedValueOnce(new Error('not owned'));
    const loadMapViewport = vi.mocked(loaders.loadMapViewport).mockResolvedValue(undefined);

    await net.doAbandon(4, 4);

    expect(showToast).toHaveBeenCalledWith('Error: not owned', C.red);
    expect(ctx.tileCache.has('4:4')).toBe(true); // catch fires before the delete line ever runs
    expect(loadMapViewport).not.toHaveBeenCalled();
  });
});
