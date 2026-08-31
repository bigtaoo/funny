// Regression coverage for the SLG shop's *purchase flow* (WorldMapNet → net/structures.ts
// doBuyShopItem), as opposed to worldMapShopPanel.ui.ts's coverage of how the catalog draws.
//
// Before 2026-08-30 (batch 3 of the SLG UI-consistency audit) this action was a bare
// `me = await buyShopItem(...)` with none of the guards the lobby shop's equivalent has had all
// along (ShopScene/actions.ts onBuy):
//   • no busy lock       → a double-tap on the Buy band dispatched — and was charged for — twice.
//   • no timeout         → a request that never settled left the UI live with no feedback.
//   • wrong re-render    → it refreshed the *Territory* panel's World tab, the shop's home before
//                          it was pulled into a panel of its own on 2026-08-02; a purchase made
//                          from the shop panel left it showing the pre-buy balance and a
//                          battle-pass card still reading "Buy".
//   • no wallet resync   → coins are charged by worldsvc → commercial and the response carries only
//                          the world state, so the local SaveData wallet kept the pre-spend number.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { doBuyShopItem } from '../../src/scenes/worldmap/net/structures';
import { BusyTracker, BUSY_TIMEOUT_MS } from '../../src/ui/busyTracker';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Minimal hand-rolled context — same harness idiom as worldMapShopPanel.ui.ts, but reaching the
 *  net action directly instead of through a rendered panel. */
function buildHarness(opts: { buy?: () => Promise<unknown>; shopPanelOpen?: boolean } = {}) {
  const buyShopItem = vi.fn(opts.buy ?? (async () => ({ joined: true, hasBattlePass: true })));
  const refreshWallet = vi.fn(async () => {});
  const panels = {
    showToast: vi.fn(),
    renderShopPanel: vi.fn(),
    renderTerritoryPanel: vi.fn(),
    renderHud: vi.fn(),
    renderBusyOverlay: vi.fn(),
  };
  const ctx = {
    bt: new BusyTracker(),
    me: { joined: true },
    shopPanelOpen: opts.shopPanelOpen ?? true,
    territoryPanelOpen: false,
    territoryTab: 'overview',
    cb: { worldId: 'w1', worldApi: { buyShopItem }, refreshWallet },
    panels,
  } as unknown as WorldMapContext;
  return { ctx, panels, buyShopItem, refreshWallet };
}

describe('doBuyShopItem — busy lock', () => {
  it('a second tap while the first request is still in flight is dropped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ctx, buyShopItem } = buildHarness({ buy: async () => { await gate; return { joined: true }; } });

    const first = doBuyShopItem(ctx, 'sp1');
    expect(ctx.bt.busy).toBe(true);
    await doBuyShopItem(ctx, 'sp1'); // the double-tap
    expect(buyShopItem).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(ctx.bt.busy).toBe(false);
  });

  it('releases the lock (and clears the busy cover) after a failed purchase too', async () => {
    const { ctx, panels } = buildHarness({ buy: async () => { throw new Error('INSUFFICIENT_FUNDS'); } });
    await doBuyShopItem(ctx, 'sp1');
    expect(ctx.bt.busy).toBe(false);
    expect(panels.renderBusyOverlay).toHaveBeenCalled();
    expect(panels.showToast).toHaveBeenCalled();
  });
});

describe('doBuyShopItem — timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a request that never settles times out, toasts, and frees the lock', async () => {
    const { ctx, panels, refreshWallet } = buildHarness({ buy: () => new Promise(() => {}) });
    const done = doBuyShopItem(ctx, 'sp1');
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS + 10);
    await done;
    expect(ctx.bt.busy).toBe(false);
    expect(panels.showToast).toHaveBeenCalledWith('Network timeout — please retry', expect.any(Number));
    // A timed-out purchase must not pretend it landed: no success toast, no wallet resync.
    expect(refreshWallet).not.toHaveBeenCalled();
  });
});

describe('doBuyShopItem — post-purchase refresh', () => {
  it('re-renders the shop panel it was bought from, and resyncs the wallet', async () => {
    const { ctx, panels, refreshWallet } = buildHarness({ shopPanelOpen: true });
    await doBuyShopItem(ctx, 'slg_battle_pass');
    expect(refreshWallet).toHaveBeenCalledTimes(1);
    expect(panels.renderShopPanel).toHaveBeenCalledTimes(1);
    expect(panels.renderHud).toHaveBeenCalledTimes(1);
    // The adopted `me` is what makes the battle-pass card flip to "Active" on that re-render.
    expect((ctx.me as { hasBattlePass?: boolean }).hasBattlePass).toBe(true);
  });

  it('does not re-render the shop panel when it is closed', async () => {
    const { ctx, panels } = buildHarness({ shopPanelOpen: false });
    await doBuyShopItem(ctx, 'sp1');
    expect(panels.renderShopPanel).not.toHaveBeenCalled();
  });

  it('still refreshes the Territory panel\'s World tab when that is what is open', async () => {
    const { ctx, panels } = buildHarness({ shopPanelOpen: false });
    (ctx as { territoryPanelOpen: boolean }).territoryPanelOpen = true;
    (ctx as { territoryTab: string }).territoryTab = 'world';
    await doBuyShopItem(ctx, 'sp1');
    expect(panels.renderTerritoryPanel).toHaveBeenCalledTimes(1);
  });

  it('a purchase against a context with no refreshWallet wired (older fixtures) still completes', async () => {
    const { ctx, panels } = buildHarness();
    (ctx.cb as { refreshWallet?: unknown }).refreshWallet = undefined;
    await doBuyShopItem(ctx, 'sp1');
    expect(panels.renderShopPanel).toHaveBeenCalledTimes(1);
  });
});

// The lock above only stops a second dispatch of the SAME action. What stops a tap reaching
// anything else mid-flight — Close, another card's Buy, a tile underneath — is the gate at the top
// of WorldMapInput.handleDown, which is a separate line of code and needs its own coverage.
describe('WorldMapInput — every tap is swallowed while a request is in flight', () => {
  function inputHarness() {
    const action = vi.fn();
    const closeModal = vi.fn();
    const ctx = {
      w: 1080, h: 1920,
      bt: new BusyTracker(),
      modalLayer: new PIXI.Container(),
      toastLayer: new PIXI.Container(),
      modalDimRect: { x: 0, y: 0, w: 1080, h: 1920 },
      modalBtnRects: [{ rect: { x: 100, y: 100, w: 200, h: 56 }, fn: action }],
      infoScrollRect: null,
      infoScrollPendingTap: null,
      shopPanelOpen: true,
      me: { joined: true },
      cb: { accountId: 'me', worldApi: {} },
      panels: { closeModal },
      view: { renderMap: vi.fn() },
    } as unknown as WorldMapContext;
    return { ctx, input: new WorldMapInput(ctx), action, closeModal };
  }

  it('fires a modal button normally when idle', () => {
    const { input, action } = inputHarness();
    input.handleDown(200, 128);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not fire that button while bt.busy', () => {
    const { ctx, input, action } = inputHarness();
    ctx.bt.start();
    input.handleDown(200, 128);
    expect(action).not.toHaveBeenCalled();
  });

  it('does not close the modal on a tap outside it either — the whole panel is frozen', () => {
    const { ctx, input, closeModal } = inputHarness();
    ctx.bt.start();
    input.handleDown(900, 1800); // on the dim, which normally closes
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('accepts taps again once the request settles', () => {
    const { ctx, input, action } = inputHarness();
    ctx.bt.start();
    input.handleDown(200, 128);
    ctx.bt.stop();
    input.handleDown(200, 128);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// The cover itself. It lives on its own layer (ctx.busyLayer) precisely because renderShopPanel /
// showModal tear modalLayer down wholesale on every re-render, so a cover parented there would be
// wiped by the very re-render a settling request triggers.
describe('WorldMapPanelsCore.renderBusyOverlay', () => {
  function overlayHarness() {
    const ctx = {
      w: 1080, h: 1920,
      bt: new BusyTracker(),
      modalLayer: new PIXI.Container(),
      toastLayer: new PIXI.Container(),
      busyLayer: new PIXI.Container(),
      modalBtnRects: [],
      cb: { accountId: 'me', worldApi: {} },
      view: { renderMap: vi.fn() },
    } as unknown as WorldMapContext;
    const panels = new WorldMapPanels(ctx);
    (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
    return { ctx, panels };
  }

  it('draws nothing until the tracker has been in flight past its 1 s threshold', () => {
    const { ctx, panels } = overlayHarness();
    ctx.bt.start();
    panels.renderBusyOverlay();
    expect(ctx.busyLayer.children).toHaveLength(0);
  });

  it('draws the cover once loadingVisible flips', () => {
    const { ctx, panels } = overlayHarness();
    ctx.bt.start();
    ctx.bt.tick(1.5); // past BusyTracker's threshold
    expect(ctx.bt.loadingVisible).toBe(true);
    panels.renderBusyOverlay();
    expect(ctx.busyLayer.children.length).toBeGreaterThan(0);
  });

  it('clears the cover when the request settles', () => {
    const { ctx, panels } = overlayHarness();
    ctx.bt.start();
    ctx.bt.tick(1.5);
    panels.renderBusyOverlay();
    ctx.bt.stop();
    panels.renderBusyOverlay();
    expect(ctx.busyLayer.children).toHaveLength(0);
  });

  it('repaints in place rather than stacking a second cover per tick', () => {
    const { ctx, panels } = overlayHarness();
    ctx.bt.start();
    ctx.bt.tick(1.5);
    panels.renderBusyOverlay();
    const n = ctx.busyLayer.children.length;
    ctx.bt.tick(0.4); // dots advance -> lifecycle repaints
    panels.renderBusyOverlay();
    expect(ctx.busyLayer.children).toHaveLength(n);
  });

  it('no-ops on a context that never built the layer (the pre-existing UI fixtures)', () => {
    const { ctx, panels } = overlayHarness();
    (ctx as unknown as { busyLayer?: PIXI.Container }).busyLayer = undefined;
    ctx.bt.start();
    ctx.bt.tick(1.5);
    expect(() => panels.renderBusyOverlay()).not.toThrow();
  });
});
