// Coverage for ADR-058's busy-lock + button-greying extension to AuctionScene: doBuy/doCancel must
// not fire twice while the first request is in flight, the acting list-row button must grey out
// (no hit rect) during that window, and a hung request must time out and recover.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import type { AuctionView, WorldApiClient } from '../../src/net/WorldApiClient';
import { TimeoutError } from '../../src/ui/busyTracker';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 1280];
const WORLD_ID = 'world:1:0';

function makeAuction(overrides: Partial<AuctionView> = {}): AuctionView {
  return {
    auctionId: 'auc_1', worldId: WORLD_ID, sellerId: 'acc_seller',
    itemType: 'material', item: { material: 'scrap' }, qty: 1, price: 100,
    status: 'open', expireAt: Date.now() + 3_600_000, saleMode: 'fixed',
    ...overrides,
  } as AuctionView;
}

function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return {
    listAuctions: vi.fn(async () => [] as AuctionView[]),
    getMyListings: vi.fn(async () => [] as AuctionView[]),
    ...overrides,
  } as unknown as WorldApiClient;
}

/** Parks the scene with a fixed listing snapshot on the 'all' tab — bypasses the constructor's own
 *  loadData() fetch (same reasoning as the Sect/Family busy-lock specs' direct-mode construction). */
function buildListScene(worldApi: WorldApiClient, listing: AuctionView, myAccountId = 'acc_me'): any {
  const scene: any = new AuctionScene(createLayout(W, H), new InputManager(), {
    onBack() {}, worldApi, myAccountId,
  });
  scene.core.allAuctions = [listing];
  scene.core.activeTab = 'all';
  scene.core.loading = false; // constructor's own loadData() fetch is still pending — render the snapshot now
  scene.render();
  return scene;
}

function buildMineScene(worldApi: WorldApiClient, listing: AuctionView, myAccountId = 'acc_me'): any {
  const scene: any = new AuctionScene(createLayout(W, H), new InputManager(), {
    onBack() {}, worldApi, myAccountId,
  });
  scene.core.myListings = [listing];
  scene.core.activeTab = 'mine';
  scene.core.loading = false;
  scene.render();
  return scene;
}

function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: node.x, y: node.y }; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };
function hitUnder(hits: Hit[], pos: { x: number; y: number }): Hit | undefined {
  return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
}

describe('AuctionScene — busy lock prevents duplicate requests', () => {
  it('doBuy: a second call while the first is in flight does not re-issue the request', async () => {
    const buyAuction = vi.fn(() => new Promise<{ ok: true }>(() => {})); // never resolves
    const scene = buildListScene(stubWorldApi({ buyAuction }), makeAuction());

    void scene.trade.doBuy('auc_1');
    void scene.trade.doBuy('auc_1'); // busy — must short-circuit before touching worldApi
    await Promise.resolve();

    expect(buyAuction).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(true);
  });

  it('doCancel: a second call while the first is in flight does not re-issue the request', async () => {
    const cancelAuction = vi.fn(() => new Promise<{ ok: true }>(() => {}));
    const scene = buildMineScene(stubWorldApi({ cancelAuction }), makeAuction({ sellerId: 'acc_me' }), 'acc_me');

    void scene.trade.doCancel('auc_1');
    void scene.trade.doCancel('auc_1');
    await Promise.resolve();

    expect(cancelAuction).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(true);
  });

  it('doBuy: unlocks once the request resolves', async () => {
    const buyAuction = vi.fn(async () => ({ ok: true as const }));
    const scene = buildListScene(stubWorldApi({ buyAuction }), makeAuction());

    await scene.trade.doBuy('auc_1');

    expect(buyAuction).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(false);
  });
});

// doCancel's own success/failure bodies were never driven by any test before this — the busy-lock
// spec above only proved the SECOND call is a no-op, never that the FIRST call's cancelAuction
// request body, success toast + refetch, or failure toast actually run (2026-08-05 client-test-audit).
describe('AuctionScene — doCancel() real request body', () => {
  it('success: cancels, toasts, refetches both listings feeds, and unlocks', async () => {
    const cancelAuction = vi.fn(async () => ({ ok: true as const }));
    const listAuctions = vi.fn(async () => [] as AuctionView[]);
    const getMyListings = vi.fn(async () => [] as AuctionView[]);
    const scene = buildMineScene(
      stubWorldApi({ cancelAuction, listAuctions, getMyListings }),
      makeAuction({ sellerId: 'acc_me' }),
      'acc_me',
    );
    listAuctions.mockClear(); getMyListings.mockClear(); // drop the constructor's own initial loadData() call
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.trade.doCancel('auc_1');

    expect(cancelAuction).toHaveBeenCalledWith('auc_1');
    expect(showToast).toHaveBeenCalledWith(t('auction.cancelled'));
    // doCancel's success path awaits loadData(), which refetches BOTH feeds (all + mine).
    expect(listAuctions).toHaveBeenCalledTimes(1);
    expect(getMyListings).toHaveBeenCalledTimes(1);
    expect(scene.core.bt.busy).toBe(false);
  });

  it('failure: toasts the mapped error and never refetches', async () => {
    const cancelAuction = vi.fn(async () => { throw new Error('not your listing'); });
    const listAuctions = vi.fn(async () => [] as AuctionView[]);
    const scene = buildMineScene(
      stubWorldApi({ cancelAuction, listAuctions }),
      makeAuction({ sellerId: 'acc_me' }),
      'acc_me',
    );
    listAuctions.mockClear(); // drop the constructor's own initial loadData() call
    const showToast = vi.spyOn(scene.core, 'showToast');

    await scene.trade.doCancel('auc_1');

    expect(showToast).toHaveBeenCalledWith('Error: not your listing', expect.anything());
    expect(showToast).not.toHaveBeenCalledWith(t('auction.cancelled'));
    expect(listAuctions).not.toHaveBeenCalled();
    expect(scene.core.bt.busy).toBe(false);
  });

  it('a hung cancelAuction() times out after 10s, toasts common.networkTimeout, and unlocks', async () => {
    vi.useFakeTimers();
    try {
      const cancelAuction = vi.fn(() => new Promise<{ ok: true }>(() => {}));
      const scene = buildMineScene(stubWorldApi({ cancelAuction }), makeAuction({ sellerId: 'acc_me' }), 'acc_me');
      const showToast = vi.spyOn(scene.core, 'showToast');

      const pending = scene.trade.doCancel('auc_1');
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;

      expect(showToast).toHaveBeenCalledWith(t('common.networkTimeout'), expect.anything());
      expect(scene.core.bt.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AuctionScene — list-row Buy button greys out while busy', () => {
  it('has a hit rect when idle, none while the request is pending', async () => {
    const buyAuction = vi.fn(() => new Promise<{ ok: true }>(() => {}));
    const scene = buildListScene(stubWorldApi({ buyAuction }), makeAuction());

    const pos = findLabelPos(scene.container, t('auction.buy'));
    expect(pos).not.toBeNull();
    expect(hitUnder(scene.core.hitRects, pos!)).toBeDefined(); // idle: clickable

    void scene.trade.doBuy('auc_1');
    expect(hitUnder(scene.core.hitRects, pos!)).toBeUndefined(); // busy: greyed out, no hit rect
  });
});

describe('AuctionScene — network timeout recovers cleanly', () => {
  it('a hung buyAuction() times out after 10s, toasts common.networkTimeout, and unlocks', async () => {
    vi.useFakeTimers();
    try {
      const buyAuction = vi.fn(() => new Promise<{ ok: true }>(() => {}));
      const scene = buildListScene(stubWorldApi({ buyAuction }), makeAuction());
      const showToast = vi.spyOn(scene.core, 'showToast');

      const pending = scene.trade.doBuy('auc_1');
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;

      expect(showToast).toHaveBeenCalledWith(t('common.networkTimeout'), expect.anything());
      expect(scene.core.bt.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AuctionScene — errorMsg() classifies TimeoutError', () => {
  it('maps TimeoutError to the common.networkTimeout i18n key instead of falling through to String(e)', () => {
    const scene = buildListScene(stubWorldApi({}), makeAuction());
    expect(scene.core.errorMsg(new TimeoutError())).toBe(t('common.networkTimeout'));
  });
});
