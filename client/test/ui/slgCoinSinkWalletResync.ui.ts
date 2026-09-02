// Every SLG coin sink must resync the local wallet after the spend (UI_DESIGN_LOG_2026-08.md §43).
//
// The invariant, and why it needs a sweep rather than a test per site: coins are charged by
// worldsvc -> the commercial service, and every one of these endpoints answers with the updated
// *world* state (`PlayerWorldView`) and nothing else. The SaveData wallet the header coin readout
// reads from is a separate document that no response touches. So a sink that forgets to
// `await cb.refreshWallet?.()` leaves the player looking at their pre-spend balance until some
// unrelated thing happens to re-pull the save — a bug with no error, no toast, and no failing
// assertion anywhere, which is how all four of these shipped without it.
//
// `refreshWallet` is optional on both callback interfaces (so the many fixtures predating it need
// no change), which means a forgotten call is also invisible to the type checker. This file is the
// only thing standing behind that `?.`, so it enumerates the sinks deliberately: shop purchase,
// build speed-up, training speed-up, relocation. A NEW sink is not caught automatically — add it
// to SINKS below when you add one.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import { initI18n } from '../../src/i18n';
import { BusyTracker } from '../../src/ui/busyTracker';
import { doBuyShopItem, doRelocate } from '../../src/scenes/worldmap/net/structures';
import { doSpeedup, doSpeedupTraining } from '../../src/scenes/CityScene/actions';
import type { ActionsHost } from '../../src/scenes/CityScene/actions';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const ME = { joined: true, mainBaseTile: 'w1:10:10', troops: 100 } as unknown as PlayerWorldView;

/** One sink: how to run it against a stubbed API, and how to make that API fail. */
interface Sink {
  name: string;
  /** Runs the action; `refreshWallet` counts the resyncs, `fail` makes the server call reject. */
  run(refreshWallet: () => Promise<void>, fail?: boolean): Promise<void>;
}

// ── World-map sinks (net/structures.ts, ctx-based) ───────────────────────────

function worldCtx(refreshWallet: () => Promise<void>, api: Record<string, unknown>): WorldMapContext {
  return {
    bt: new BusyTracker(),
    me: ME,
    zoom: 1,
    destroyed: false,
    tileCache: new Map(),
    shopPanelOpen: true,
    territoryPanelOpen: false,
    territoryTab: 'overview',
    cb: { worldId: 'w1', refreshWallet, worldApi: api },
    panels: {
      showToast: vi.fn(), closeModal: vi.fn(), renderShopPanel: vi.fn(),
      renderTerritoryPanel: vi.fn(), renderHud: vi.fn(), renderBusyOverlay: vi.fn(),
    },
    view: { renderMap: vi.fn(), centerAt: vi.fn(), viewportCenter: () => ({ cx: 10, cy: 10, r: 5 }) },
    parseTileId: (id: string) => {
      const p = id.split(':');
      return [Number(p[p.length - 2]), Number(p[p.length - 1])] as [number, number];
    },
  } as unknown as WorldMapContext;
}

// ── City sinks (CityScene/actions.ts, explicit host) ─────────────────────────

function cityHost(refreshWallet: () => Promise<void>, api: Record<string, unknown>): ActionsHost {
  return {
    bt: new BusyTracker(),
    cb: { worldId: 'w1', refreshWallet, worldApi: api } as unknown as ActionsHost['cb'],
    teams: [],
    me: { ...ME, buildQueue: [{ key: 'desk', completeAt: Date.now() + 600_000 }] } as unknown as PlayerWorldView,
    setMe: vi.fn(),
    requestRender: vi.fn(),
    showToast: vi.fn(),
  } as unknown as ActionsHost;
}

const SINKS: Sink[] = [
  {
    name: 'shop purchase (worldApi.buyShopItem)',
    run: (refreshWallet, fail) => doBuyShopItem(
      worldCtx(refreshWallet, {
        buyShopItem: fail ? vi.fn(async () => { throw new Error('INSUFFICIENT_FUNDS'); }) : vi.fn(async () => ME),
      }),
      'sp1',
    ),
  },
  {
    name: 'relocation (worldApi.relocateBase)',
    run: (refreshWallet, fail) => doRelocate(
      worldCtx(refreshWallet, {
        relocateBase: fail ? vi.fn(async () => { throw new Error('nope'); }) : vi.fn(async () => ME),
        getMap: vi.fn(async () => ({ tiles: [] })),
      }),
      20, 20,
    ),
  },
  {
    name: 'build speed-up (worldApi.speedupBuild)',
    run: (refreshWallet, fail) => doSpeedup(
      cityHost(refreshWallet, {
        speedupBuild: fail ? vi.fn(async () => { throw new Error('nope'); }) : vi.fn(async () => ME),
      }),
      'desk',
    ),
  },
  {
    name: 'training speed-up (worldApi.speedupTraining)',
    run: (refreshWallet, fail) => doSpeedupTraining(
      cityHost(refreshWallet, {
        speedupTraining: fail ? vi.fn(async () => { throw new Error('nope'); }) : vi.fn(async () => ME),
      }),
      60,
    ),
  },
];

describe('SLG coin sinks — the local wallet is resynced after the server-side charge', () => {
  for (const sink of SINKS) {
    it(`${sink.name} resyncs the wallet on success`, async () => {
      const refreshWallet = vi.fn(async () => {});
      await sink.run(refreshWallet);
      expect(refreshWallet).toHaveBeenCalledTimes(1);
    });

    it(`${sink.name} does NOT resync when the charge failed`, async () => {
      // Nothing was spent, so re-pulling the save would be a wasted round-trip — and, worse, would
      // make a failed spend look like a successful one to anyone reading the call as a signal.
      const refreshWallet = vi.fn(async () => {});
      await sink.run(refreshWallet, true);
      expect(refreshWallet).not.toHaveBeenCalled();
    });
  }
});
