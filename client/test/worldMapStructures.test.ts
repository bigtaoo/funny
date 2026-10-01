// Coverage for `client/src/scenes/worldmap/net/structures.ts` — the world map's tile actions
// (relocate / watchtower / ADR-051 arrow tower + blocker / demolish / abandon) and the world-info
// panel's two writes (SLG shop buy, nation rename).
//
// 0% in the coverage suite until now. Four of the eleven exports had ui-layer cases
// (worldMapNetActions.ui.ts, worldMapShopBuyFlow.ui.ts, slgCoinSinkWalletResync.ui.ts — a layer
// that reports no coverage); the other six had no test at all, and those are the ADR-051
// structures, the in-list abandon and the rename. What they get wrong is quiet: every one ends in
// a catch that toasts and returns, so a call that clears the wrong cache, keeps a stale `me` or
// re-renders the wrong panel does not throw — the map just shows the old state. The cases below
// pin which call is made, what lands in ctx, which cache entries survive and which panel redraws.
//
// Same seams as worldMapPush.test.ts: `render/sketchUi` is the module's only pixi.js-legacy import
// and is used for two palette entries, so sentinels make the toast colour assertable; `./loaders`
// is the network + redraw boundary. vi.mock is hoisted above top-level bindings, hence the repeated
// literals inside the factory.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/render/sketchUi', () => ({ ui: { red: 0xff0001, green: 0x00ff02 } }));
const RED = 0xff0001;
const GREEN = 0x00ff02;

const loadMapViewport = vi.fn(async (_ctx: unknown) => {});
const refreshTerritories = vi.fn(async (_ctx: unknown) => {});
vi.mock('../src/scenes/worldmap/net/loaders', () => ({
  loadMapViewport: (ctx: unknown) => loadMapViewport(ctx),
  refreshTerritories: (ctx: unknown) => refreshTerritories(ctx),
}));

import {
  confirmRelocate, doRelocate, confirmWatchtower, doWatchtower, confirmBuildStructure, doBuildStructure,
  doDemolishStructure, doAbandon, doAbandonFromList, doBuyShopItem, doRename,
} from '../src/scenes/worldmap/net/structures';
import { RELOCATE_COST, WATCHTOWER_COST_METAL, WATCHTOWER_COST_PAPER } from '../src/scenes/worldmap/logic/constants';
import { ARROW_TOWER_COST, BLOCKER_COST } from '@nw/shared';
import { WorldApiError } from '../src/net/WorldApiClient';
import { BusyTracker, BUSY_TIMEOUT_MS } from '../src/ui/busyTracker';
import { setLocale, t } from '../src/i18n';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';

const WORLD = 'w1';
const OLD_ME = { joined: true, tag: 'old' };
const NEW_ME = { joined: true, tag: 'new', mainBaseTile: 't:40:50' };

type Modal = { lines: Array<{ text: string; icon?: unknown }>; buttons: Array<{ label: string; action: () => void }> };

interface Fake {
  ctx: WorldMapContext;
  api: Record<string, ReturnType<typeof vi.fn>>;
  toasts: Array<{ msg: string; color?: number; filled?: boolean }>;
  modals: Modal[];
  calls: string[];
  centered: Array<[number, number]>;
  refreshWallet: ReturnType<typeof vi.fn>;
  raw: Record<string, unknown>;
}

function fake(over: Partial<{
  territoryPanelOpen: boolean; territoryTab: string; shopPanelOpen: boolean; bt: BusyTracker | undefined;
}> = {}): Fake {
  const f: Fake = {
    api: {}, toasts: [], modals: [], calls: [], centered: [],
    refreshWallet: vi.fn(async () => {}), raw: {}, ctx: null as unknown as WorldMapContext,
  };
  f.api.relocateBase = vi.fn(async () => NEW_ME);
  f.api.buildWatchtower = vi.fn(async () => ({ me: NEW_ME }));
  f.api.buildStructure = vi.fn(async () => ({ me: NEW_ME }));
  f.api.demolishStructure = vi.fn(async () => ({}));
  f.api.abandonTile = vi.fn(async () => NEW_ME);
  f.api.buyShopItem = vi.fn(async () => NEW_ME);
  f.api.setNationName = vi.fn(async () => ({}));

  const tileCache = new Map<string, unknown>([['3:4', { x: 3 }], ['5:6', { x: 5 }]]);
  const ctx = {
    me: OLD_ME as unknown,
    tileCache,
    parseTileId: (id: string) => {
      const [, x, y] = id.split(':');
      return [Number(x), Number(y)] as [number, number];
    },
    territoryPanelOpen: over.territoryPanelOpen ?? false,
    territoryTab: over.territoryTab ?? 'list',
    shopPanelOpen: over.shopPanelOpen ?? false,
    shopItems: [{ id: 'pack', label: 'Resource pack' }],
    nations: [{ capitalIdx: 2, nationName: 'Old' }, { capitalIdx: 7, nationName: 'Other' }],
    bt: 'bt' in over ? over.bt : new BusyTracker(),
    cb: { worldId: WORLD, worldApi: f.api, refreshWallet: f.refreshWallet },
    view: {
      centerAt: (x: number, y: number) => { f.centered.push([x, y]); },
      renderMap: () => { f.calls.push('renderMap'); },
    },
    panels: {
      showModal: (lines: Modal['lines'], buttons: Modal['buttons']) => { f.modals.push({ lines, buttons }); },
      closeModal: () => { f.calls.push('closeModal'); },
      showToast: (msg: string, color?: number, filled?: boolean) => { f.toasts.push({ msg, color, filled }); },
      renderHud: () => { f.calls.push('renderHud'); },
      renderTerritoryPanel: () => { f.calls.push('renderTerritoryPanel'); },
      renderShopPanel: () => { f.calls.push('renderShopPanel'); },
      renderBusyOverlay: () => { f.calls.push('renderBusyOverlay'); },
      shopLabel: (item: { label: string }) => item.label,
    },
  };
  f.raw = ctx as unknown as Record<string, unknown>;
  f.ctx = ctx as unknown as WorldMapContext;
  return f;
}

const fail = (code = 'INSUFFICIENT_RESOURCES') => vi.fn(async () => { throw new WorldApiError(code, 'raw'); });
const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });

beforeEach(() => {
  setLocale('en');
  loadMapViewport.mockClear();
  refreshTerritories.mockClear();
});

describe('confirm dialogs', () => {
  it('relocate shows the coin cost; its first button relocates, the second only closes', async () => {
    const f = fake();
    confirmRelocate(f.ctx, 9, 8);
    const m = f.modals[0]!;
    expect(m.lines[1]!.text).toBe(t('world.relocateConfirm').replace('{n}', String(RELOCATE_COST)));
    m.buttons[1]!.action();
    expect(f.api.relocateBase).not.toHaveBeenCalled();
    expect(f.calls).toEqual(['closeModal']);
    m.buttons[0]!.action();
    await flush();
    expect(f.api.relocateBase).toHaveBeenCalledWith(WORLD, 9, 8);
  });

  it('watchtower lists paper then metal as their own icon lines, from the display constants', async () => {
    const f = fake();
    confirmWatchtower(f.ctx, 1, 2);
    const m = f.modals[0]!;
    const line = (res: 'paper' | 'metal', n: number) =>
      t('world.costLine').replace('{res}', t(`world.${res}`)).replace('{n}', String(n));
    expect(m.lines[1]).toEqual({ text: line('paper', WATCHTOWER_COST_PAPER), icon: { res: 'paper' } });
    expect(m.lines[2]).toEqual({ text: line('metal', WATCHTOWER_COST_METAL), icon: { res: 'metal' } });
    m.buttons[0]!.action();
    await flush();
    expect(f.api.buildWatchtower).toHaveBeenCalledWith(WORLD, 1, 2);
  });

  it.each([
    ['arrowTower', ARROW_TOWER_COST, 'world.arrowTowerTitle'],
    ['blocker', BLOCKER_COST, 'world.blockerTitle'],
  ] as const)('%s confirm shows its own title and cost, and builds that kind', async (kind, cost, title) => {
    const f = fake();
    confirmBuildStructure(f.ctx, 3, 4, kind);
    const m = f.modals[0]!;
    expect(m.lines[0]!.text).toBe(t(title));
    expect(m.lines[1]!.text).toContain(String(cost.paper));
    expect(m.lines[2]!.text).toContain(String(cost.metal));
    m.buttons[0]!.action();
    await flush();
    expect(f.api.buildStructure).toHaveBeenCalledWith(WORLD, 3, 4, kind);
  });

  it('every build confirm\'s second button only closes — nothing is sent', () => {
    const f = fake();
    confirmWatchtower(f.ctx, 1, 2);
    confirmBuildStructure(f.ctx, 3, 4, 'arrowTower');
    for (const m of f.modals) m.buttons[1]!.action();
    expect(f.calls).toEqual(['closeModal', 'closeModal']);
    expect(f.api.buildWatchtower).not.toHaveBeenCalled();
    expect(f.api.buildStructure).not.toHaveBeenCalled();
  });

  it('the two structure kinds do not share a cost (a swapped ternary would show one twice)', () => {
    const a = fake(); confirmBuildStructure(a.ctx, 0, 0, 'arrowTower');
    const b = fake(); confirmBuildStructure(b.ctx, 0, 0, 'blocker');
    expect(a.modals[0]!.lines[2]!.text).not.toBe(b.modals[0]!.lines[2]!.text);
  });
});

describe('doRelocate', () => {
  it('adopts the new state, drops the WHOLE cache, centres on the new base and resyncs the wallet', async () => {
    const f = fake();
    await doRelocate(f.ctx, 40, 50);
    expect(f.raw.me).toBe(NEW_ME);
    expect((f.raw.tileCache as Map<string, unknown>).size).toBe(0);
    expect(f.centered).toEqual([[40, 50]]);
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(f.refreshWallet).toHaveBeenCalledTimes(1);
    expect(f.toasts).toEqual([{ msg: t('world.relocated'), color: undefined, filled: undefined }]);
    expect(f.calls).toEqual(['closeModal', 'renderMap', 'renderHud']);
  });

  it('does not centre when the response carries no base tile', async () => {
    const f = fake();
    f.api.relocateBase!.mockImplementation(async () => ({ joined: true }));
    await doRelocate(f.ctx, 1, 1);
    expect(f.centered).toEqual([]);
  });

  it('on failure: red toast with the mapped copy, cache, state and wallet untouched', async () => {
    const f = fake();
    f.api.relocateBase = fail();
    await doRelocate(f.ctx, 1, 1);
    expect(f.toasts).toEqual([{ msg: t('world.err.noInk'), color: RED, filled: undefined }]);
    expect(f.raw.me).toBe(OLD_ME);
    expect((f.raw.tileCache as Map<string, unknown>).size).toBe(2);
    expect(f.refreshWallet).not.toHaveBeenCalled();
  });
});

describe('doWatchtower', () => {
  it('adopts `me` from the response and refetches the whole viewport (vision grew)', async () => {
    const f = fake();
    await doWatchtower(f.ctx, 1, 2);
    expect(f.raw.me).toBe(NEW_ME);
    expect((f.raw.tileCache as Map<string, unknown>).size).toBe(0);
    expect(f.toasts[0]!.msg).toBe(t('world.watchtowerBuilt'));
  });

  it('keeps the cached state when the response omits `me`', async () => {
    const f = fake();
    f.api.buildWatchtower!.mockImplementation(async () => ({}));
    await doWatchtower(f.ctx, 1, 2);
    expect(f.raw.me).toBe(OLD_ME);
  });

  it('on failure toasts red and keeps the cache', async () => {
    const f = fake();
    f.api.buildWatchtower = fail();
    await doWatchtower(f.ctx, 1, 2);
    expect(f.toasts[0]!.color).toBe(RED);
    expect((f.raw.tileCache as Map<string, unknown>).size).toBe(2);
  });
});

describe('structures (ADR-051) build / demolish', () => {
  it('build drops ONLY the built tile from the cache and adopts `me`', async () => {
    const f = fake();
    await doBuildStructure(f.ctx, 3, 4, 'blocker');
    const cache = f.raw.tileCache as Map<string, unknown>;
    expect([...cache.keys()]).toEqual(['5:6']);
    expect(f.raw.me).toBe(NEW_ME);
    expect(f.toasts[0]!.msg).toBe(t('world.structureBuilt'));
    expect(f.calls).toEqual(['closeModal', 'renderMap', 'renderHud']);
  });

  it('build keeps the cached state when the response omits `me`', async () => {
    const f = fake();
    f.api.buildStructure!.mockImplementation(async () => ({}));
    await doBuildStructure(f.ctx, 3, 4, 'arrowTower');
    expect(f.raw.me).toBe(OLD_ME);
  });

  it('build failure toasts red, keeps the tile cached and does not refetch', async () => {
    const f = fake();
    f.api.buildStructure = fail();
    await doBuildStructure(f.ctx, 3, 4, 'arrowTower');
    expect(f.toasts).toEqual([{ msg: t('world.err.noInk'), color: RED, filled: undefined }]);
    expect((f.raw.tileCache as Map<string, unknown>).has('3:4')).toBe(true);
    expect(loadMapViewport).not.toHaveBeenCalled();
  });

  it('demolish drops only that tile and toasts', async () => {
    const f = fake();
    await doDemolishStructure(f.ctx, 5, 6);
    expect(f.api.demolishStructure).toHaveBeenCalledWith(WORLD, 5, 6);
    expect([...(f.raw.tileCache as Map<string, unknown>).keys()]).toEqual(['3:4']);
    expect(f.toasts[0]!.msg).toBe(t('world.structureDemolished'));
    expect(f.calls).toEqual(['closeModal', 'renderMap', 'renderHud']);
  });

  it('demolish failure toasts red and keeps the tile', async () => {
    const f = fake();
    f.api.demolishStructure = fail('NOT_OWNER');
    await doDemolishStructure(f.ctx, 5, 6);
    expect(f.toasts).toEqual([{ msg: t('world.err.notOwner'), color: RED, filled: undefined }]);
    expect((f.raw.tileCache as Map<string, unknown>).has('5:6')).toBe(true);
  });
});

describe('abandon', () => {
  it('from the tile menu: closes the modal, adopts `me`, drops only that tile, no toast', async () => {
    const f = fake();
    await doAbandon(f.ctx, 3, 4);
    expect(f.raw.me).toBe(NEW_ME);
    expect([...(f.raw.tileCache as Map<string, unknown>).keys()]).toEqual(['5:6']);
    expect(f.calls).toEqual(['closeModal', 'renderMap', 'renderHud']);
    expect(f.toasts).toEqual([]);
    expect(refreshTerritories).not.toHaveBeenCalled();
  });

  it('from the tile menu: failure toasts red', async () => {
    const f = fake();
    f.api.abandonTile = fail();
    await doAbandon(f.ctx, 3, 4);
    expect(f.toasts[0]!.color).toBe(RED);
    expect(f.raw.me).toBe(OLD_ME);
  });

  it('from the territory list: keeps the modal open, refetches viewport AND territories, redraws the open list', async () => {
    const f = fake({ territoryPanelOpen: true });
    await doAbandonFromList(f.ctx, 3, 4);
    expect(f.calls).not.toContain('closeModal');
    expect(loadMapViewport).toHaveBeenCalledTimes(1);
    expect(refreshTerritories).toHaveBeenCalledTimes(1);
    expect(f.raw.me).toBe(NEW_ME);
    expect(f.calls).toEqual(['renderMap', 'renderHud', 'renderTerritoryPanel']);
  });

  it('from the territory list: does not redraw a panel that is closed', async () => {
    const f = fake({ territoryPanelOpen: false });
    await doAbandonFromList(f.ctx, 3, 4);
    expect(f.calls).toEqual(['renderMap', 'renderHud']);
  });

  it('from the territory list: failure toasts red and redraws nothing', async () => {
    const f = fake({ territoryPanelOpen: true });
    f.api.abandonTile = fail();
    await doAbandonFromList(f.ctx, 3, 4);
    expect(f.toasts[0]!.color).toBe(RED);
    expect(f.calls).toEqual([]);
  });
});

describe('doBuyShopItem', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('names the bought item in a green filled toast, resyncs the wallet and redraws the open shop', async () => {
    const f = fake({ shopPanelOpen: true });
    await doBuyShopItem(f.ctx, 'pack');
    expect(f.api.buyShopItem).toHaveBeenCalledWith(WORLD, 'pack');
    expect(f.raw.me).toBe(NEW_ME);
    expect(f.refreshWallet).toHaveBeenCalledTimes(1);
    expect(f.toasts).toEqual([{ msg: t('shop.boughtNamed', { name: 'Resource pack' }), color: GREEN, filled: true }]);
    expect(f.calls).toEqual(['renderShopPanel', 'renderHud', 'renderBusyOverlay']);
    expect((f.raw.bt as BusyTracker).busy).toBe(false);
  });

  it('falls back to the bare word when the item is not in the cached catalog', async () => {
    const f = fake();
    await doBuyShopItem(f.ctx, 'unknown');
    expect(f.toasts[0]!.msg).toBe(t('world.shopBought'));
  });

  it('redraws the territory panel only when it is open on the world tab', async () => {
    const onWorld = fake({ territoryPanelOpen: true, territoryTab: 'world' });
    await doBuyShopItem(onWorld.ctx, 'pack');
    expect(onWorld.calls).toContain('renderTerritoryPanel');
    const onList = fake({ territoryPanelOpen: true, territoryTab: 'list' });
    await doBuyShopItem(onList.ctx, 'pack');
    expect(onList.calls).not.toContain('renderTerritoryPanel');
  });

  it('a second tap while one is in flight is dropped (no double charge)', async () => {
    const f = fake();
    let release!: () => void;
    f.api.buyShopItem!.mockImplementation(() => new Promise((r) => { release = () => r(NEW_ME); }));
    const first = doBuyShopItem(f.ctx, 'pack');
    await doBuyShopItem(f.ctx, 'pack');
    expect(f.api.buyShopItem).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect((f.raw.bt as BusyTracker).busy).toBe(false);
  });

  it('a request that never settles times out, says so, and releases the lock', async () => {
    vi.useFakeTimers();
    const f = fake();
    f.api.buyShopItem!.mockImplementation(() => new Promise(() => {}));
    const p = doBuyShopItem(f.ctx, 'pack');
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS);
    await p;
    expect(f.toasts).toEqual([{ msg: t('common.networkTimeout'), color: RED, filled: undefined }]);
    expect((f.raw.bt as BusyTracker).busy).toBe(false);
    expect(f.calls).toEqual(['renderBusyOverlay']);
    expect(f.refreshWallet).not.toHaveBeenCalled();
  });

  it('a server error toasts the mapped copy and still releases the lock', async () => {
    const f = fake();
    f.api.buyShopItem = fail();
    await doBuyShopItem(f.ctx, 'pack');
    expect(f.toasts).toEqual([{ msg: t('world.err.noInk'), color: RED, filled: undefined }]);
    expect((f.raw.bt as BusyTracker).busy).toBe(false);
    expect(f.calls).toEqual(['renderBusyOverlay']);
  });

  it('works without a busy tracker', async () => {
    const f = fake({ bt: undefined });
    await doBuyShopItem(f.ctx, 'pack');
    expect(f.api.buyShopItem).toHaveBeenCalledTimes(1);
  });
});

describe('doRename', () => {
  it('renames only the matching nation in place and redraws the world tab', async () => {
    const f = fake({ territoryPanelOpen: true, territoryTab: 'world' });
    await doRename(f.ctx, 2, 'New');
    expect(f.api.setNationName).toHaveBeenCalledWith(WORLD, 2, 'New');
    expect(f.raw.nations).toEqual([{ capitalIdx: 2, nationName: 'New' }, { capitalIdx: 7, nationName: 'Other' }]);
    expect(f.calls).toEqual(['renderTerritoryPanel']);
  });

  it('does not redraw a territory panel showing another tab', async () => {
    const f = fake({ territoryPanelOpen: true, territoryTab: 'list' });
    await doRename(f.ctx, 2, 'New');
    expect(f.calls).toEqual([]);
  });

  it('a rename for a nation not cached is not an error', async () => {
    const f = fake();
    await doRename(f.ctx, 99, 'New');
    expect(f.toasts).toEqual([]);
  });

  it('on failure: red toast, name unchanged', async () => {
    const f = fake();
    f.api.setNationName = fail('NOT_OWNER');
    await doRename(f.ctx, 2, 'New');
    expect(f.toasts[0]).toEqual({ msg: t('world.err.notOwner'), color: RED, filled: undefined });
    expect((f.raw.nations as Array<{ nationName: string }>)[0]!.nationName).toBe('Old');
  });
});
