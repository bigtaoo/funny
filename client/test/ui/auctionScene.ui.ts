// Dedicated coverage for AuctionScene (client/src/scenes/AuctionScene/*), added when the 1090-line
// god-file was split into a mixin chain. Previously only a build/update/destroy smoke test (scenes.ui.ts)
// and a buyer-field caret regression (caretRegression.ui.ts) existed — none of the actual business logic
// (error mapping, min-bid rule, instance-picker eligibility, create-listing payload assembly, "my bids"
// filtering, tab/filter click wiring) had a single assertion.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { AUCTION_DURATION_SEC } from '../../src/scenes/AuctionScene/base';
import { WorldApiError, type AuctionView, type WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipmentInstance, CardInstance } from '../../src/game/meta/SaveData';

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

/** Spy-backed WorldApiClient stub — every auction endpoint resolves immediately (no hang), so
 *  synchronous call-count/arg assertions right after construction are safe. */
function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return {
    listAuctions: vi.fn(async () => [] as AuctionView[]),
    getMyListings: vi.fn(async () => [] as AuctionView[]),
    createAuction: vi.fn(async () => makeAuction()),
    buyAuction: vi.fn(async () => ({ ok: true as const })),
    cancelAuction: vi.fn(async () => ({ ok: true as const })),
    placeBid: vi.fn(async () => makeAuction()),
    ...overrides,
  } as unknown as WorldApiClient;
}

function makeAuction(overrides: Partial<AuctionView> = {}): AuctionView {
  return {
    auctionId: 'auc_1',
    worldId: WORLD_ID,
    sellerId: 'acc_seller',
    itemType: 'material',
    item: { material: 'scrap' },
    qty: 1,
    price: 100,
    status: 'open',
    expireAt: Date.now() + 3_600_000,
    saleMode: 'fixed',
    ...overrides,
  } as AuctionView;
}

// Scene fields/methods below are all TS `protected`/`private` (mixin-internal); every other UI
// spec in this codebase reaches them via an untyped handle (see caretRegression.ui.ts) rather than
// re-exposing internals just for tests, so we do the same here.
function buildScene(cb: Record<string, unknown> = {}): any {
  return new AuctionScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    worldApi: stubWorldApi(),
    worldId: WORLD_ID,
    ...cb,
  });
}

/** All PIXI.Text content currently in the display tree, recursing sub-containers. */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

type Hit = { rect: { x: number; y: number; w: number; h: number }; action: () => void };

/** Find the (first) PIXI.Text node whose text matches `label` and return its render position
 *  (labels here are all anchored (0.5,0.5), so .x/.y IS the center). */
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

/** Tap whichever hit rect (from `hitsField`) sits under the rendered label `label`. */
function tapLabel(scene: any, container: PIXI.Container, label: string, hitsField: 'hitRects' | 'modalHits' = 'hitRects'): void {
  const pos = findLabelPos(container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits: Hit[] = scene[hitsField];
  const hit = hits.find(({ rect: r }) => pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under "${label}"`).toBeDefined();
  hit!.action();
}

// ── errorMsg() — the WorldApiError code → localized-message table ─────────────────────────────

describe('AuctionScene — errorMsg()', () => {
  it('maps known WorldApiError codes to their localized message', () => {
    const scene = buildScene();
    expect(scene.errorMsg(new WorldApiError('AUCTION_CLOSED', 'x'))).toBe(t('auction.err.closed'));
    expect(scene.errorMsg(new WorldApiError('NOT_DESIGNATED_BUYER', 'x'))).toBe(t('auction.err.selfBuy'));
    expect(scene.errorMsg(new WorldApiError('BID_TOO_LOW', 'x'))).toBe(t('auction.err.bidTooLow'));
    scene.destroy();
  });

  it('collapses both fund-related codes onto the same insufficient-funds message', () => {
    const scene = buildScene();
    expect(scene.errorMsg(new WorldApiError('INSUFFICIENT_FUNDS', 'x'))).toBe(t('auction.err.insufficientFunds'));
    expect(scene.errorMsg(new WorldApiError('INSUFFICIENT_RESOURCES', 'x'))).toBe(t('auction.err.insufficientFunds'));
    scene.destroy();
  });

  it('falls back to e.message for an unmapped WorldApiError code', () => {
    const scene = buildScene();
    expect(scene.errorMsg(new WorldApiError('SOME_NEW_SERVER_CODE', 'raw server message'))).toBe('raw server message');
    scene.destroy();
  });

  it('falls back to String(e) for a non-WorldApiError value', () => {
    const scene = buildScene();
    expect(scene.errorMsg(new Error('boom'))).toBe('Error: boom');
    expect(scene.errorMsg('plain string')).toBe('plain string');
    scene.destroy();
  });
});

// ── minBidFor() — +5% (or +1, whichever is larger) minimum raise over the current top bid ─────

describe('AuctionScene — minBidFor()', () => {
  it('with no bids yet, the minimum is just the starting price', () => {
    const scene = buildScene();
    const auc = makeAuction({ saleMode: 'auction', price: 100 });
    expect(scene.minBidFor(auc)).toBe(100);
    scene.destroy();
  });

  it('with a bid, requires +5%% rounded up when that beats +1', () => {
    const scene = buildScene();
    const auc = makeAuction({ saleMode: 'auction', price: 100, topBid: { bidderId: 'acc_x', amount: 100, ts: 0 } });
    expect(scene.minBidFor(auc)).toBe(105); // ceil(100*1.05)=105 > 101
    scene.destroy();
  });

  it('with a bid, falls back to +1 when 5%% would round down to the same price', () => {
    const scene = buildScene();
    const auc = makeAuction({ saleMode: 'auction', price: 1, topBid: { bidderId: 'acc_x', amount: 1, ts: 0 } });
    expect(scene.minBidFor(auc)).toBe(2); // max(2, ceil(1.05)=2) = 2
    scene.destroy();
  });
});

// ── listableEquipment() / listableCards() — instance-picker eligibility (mirrors server escrow guard) ──

describe('AuctionScene — listableEquipment() / listableCards()', () => {
  function equip(id: string, opts: Partial<EquipmentInstance> = {}): EquipmentInstance {
    return { id, defId: 'sword_basic', rarity: 'common', level: 0, affixes: [], ...opts };
  }
  function card(id: string, opts: Partial<CardInstance> = {}): CardInstance {
    return { id, defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false, ...opts };
  }

  function saveWith(equipmentInv: Record<string, EquipmentInstance>, cardInv: Record<string, CardInstance>): SaveData {
    return { ...makeNewSave('acc_1'), equipmentInv, cardInv };
  }

  it('excludes locked equipment', () => {
    const save = saveWith({ e1: equip('e1'), e2: equip('e2', { locked: true }) }, {});
    const scene = buildScene({ getSave: () => save });
    expect(scene.listableEquipment().map((e: EquipmentInstance) => e.id)).toEqual(['e1']);
    scene.destroy();
  });

  it('excludes equipment currently equipped by any card', () => {
    const save = saveWith(
      { e1: equip('e1'), e2: equip('e2') },
      { c1: card('c1', { gear: { weapon: 'e2' } }) },
    );
    const scene = buildScene({ getSave: () => save });
    expect(scene.listableEquipment().map((e: EquipmentInstance) => e.id)).toEqual(['e1']);
    scene.destroy();
  });

  it('excludes cards that still have any gear equipped', () => {
    const save = saveWith(
      { e1: equip('e1') },
      { c1: card('c1', { gear: {} }), c2: card('c2', { gear: { trinket: 'e1' } }) },
    );
    const scene = buildScene({ getSave: () => save });
    expect(scene.listableCards().map((c: CardInstance) => c.id)).toEqual(['c1']);
    scene.destroy();
  });

  it('returns an empty list for both when getSave is not wired', () => {
    const scene = buildScene();
    expect(scene.listableEquipment()).toEqual([]);
    expect(scene.listableCards()).toEqual([]);
    scene.destroy();
  });
});

// ── doCreate() — payload assembly per item class + the "must pick an instance" guard ──────────

describe('AuctionScene — doCreate()', () => {
  it('creates a material listing with the fixed-price payload', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    scene.createClass = 'material';
    scene.createMaterial = 'lead';
    scene.createQty = 5;
    scene.createSaleMode = 'fixed';
    scene.createPrice = 20;
    scene.createBuyer = 'acc_9';

    await scene.doCreate();

    expect(worldApi.createAuction).toHaveBeenCalledWith(
      WORLD_ID, 'material', { material: 'lead' }, 5, AUCTION_DURATION_SEC,
      { saleMode: 'fixed', price: 20, designatedBuyerId: 'acc_9' },
    );
    scene.destroy();
  });

  it('creates an auction-mode equipment listing, forcing qty=1 and instanceId payload', async () => {
    const worldApi = stubWorldApi();
    const reloadSave = vi.fn(async () => {});
    const scene = buildScene({ worldApi, reloadSave, getSave: () => makeNewSave('acc_1') });
    scene.createClass = 'equipment';
    scene.createEquipId = 'eq_7';
    scene.createSaleMode = 'auction';
    scene.createStartPrice = 15;
    scene.createBuyoutPrice = 0;

    await scene.doCreate();

    expect(worldApi.createAuction).toHaveBeenCalledWith(
      WORLD_ID, 'equipment', { instanceId: 'eq_7' }, 1, AUCTION_DURATION_SEC,
      { saleMode: 'auction', startPrice: 15, buyoutPrice: undefined, designatedBuyerId: undefined },
    );
    // Equipment/card listings escrow server-side — the picker selection is cleared and the save re-pulled.
    expect(scene.createEquipId).toBeNull();
    expect(reloadSave).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('creates a card listing with instanceId payload', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi, reloadSave: vi.fn(async () => {}), getSave: () => makeNewSave('acc_1') });
    scene.createClass = 'card';
    scene.createCardId = 'card_3';
    scene.createSaleMode = 'fixed';
    scene.createPrice = 500;

    await scene.doCreate();

    expect(worldApi.createAuction).toHaveBeenCalledWith(
      WORLD_ID, 'card', { instanceId: 'card_3' }, 1, AUCTION_DURATION_SEC,
      { saleMode: 'fixed', price: 500, designatedBuyerId: undefined },
    );
    scene.destroy();
  });

  it('refuses to submit an equipment listing with no instance picked (no API call)', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    scene.createClass = 'equipment';
    scene.createEquipId = null;

    await scene.doCreate();

    expect(worldApi.createAuction).not.toHaveBeenCalled();
    expect(collectTexts(scene.toastLayer)).toContain(t('auction.selectItem'));
    scene.destroy();
  });

  it('refuses to submit a card listing with no instance picked (no API call)', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    scene.createClass = 'card';
    scene.createCardId = null;

    await scene.doCreate();

    expect(worldApi.createAuction).not.toHaveBeenCalled();
    expect(collectTexts(scene.toastLayer)).toContain(t('auction.selectItem'));
    scene.destroy();
  });

  it('shows an error toast (mapped via errorMsg) when the server rejects the listing', async () => {
    const worldApi = stubWorldApi({
      createAuction: vi.fn(async () => { throw new WorldApiError('INSUFFICIENT_MATERIALS', 'x'); }),
    });
    const scene = buildScene({ worldApi });
    scene.createClass = 'material';
    scene.createMaterial = 'scrap';

    await scene.doCreate();

    expect(collectTexts(scene.toastLayer)).toContain(t('auction.err.noMaterial'));
    scene.destroy();
  });
});

// ── myBids() — "我的收购" tab: auctions where I'm currently the top bidder ─────────────────────

describe('AuctionScene — myBids()', () => {
  it('keeps only auction-mode listings where I am the current top bidder', () => {
    const scene = buildScene({ myAccountId: 'acc_me' });
    scene.allAuctions = [
      makeAuction({ auctionId: 'a1', saleMode: 'auction', topBid: { bidderId: 'acc_me', amount: 10, ts: 0 } }),
      makeAuction({ auctionId: 'a2', saleMode: 'auction', topBid: { bidderId: 'acc_other', amount: 20, ts: 0 } }),
      makeAuction({ auctionId: 'a3', saleMode: 'fixed' }), // fixed-price listings never have a topBid
      makeAuction({ auctionId: 'a4', saleMode: 'auction' }), // no bids yet
    ];
    expect(scene.myBids().map((a: AuctionView) => a.auctionId)).toEqual(['a1']);
    scene.destroy();
  });

  it('returns an empty list when myAccountId is not wired', () => {
    const scene = buildScene();
    scene.allAuctions = [makeAuction({ saleMode: 'auction', topBid: { bidderId: 'acc_other', amount: 20, ts: 0 } })];
    expect(scene.myBids()).toEqual([]);
    scene.destroy();
  });
});

// ── Tab switching & filter chips — click wiring through the real hit-rect list ─────────────────

describe('AuctionScene — sidebar tabs & filter chips', () => {
  it('switching the sidebar tab re-renders but does not re-fetch data', () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
    expect(worldApi.getMyListings).toHaveBeenCalledTimes(1);

    tapLabel(scene, scene.container, t('auction.tabMine'));
    expect(scene.activeTab).toBe('mine');
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1); // unchanged — tab switch is local state only
    expect(worldApi.getMyListings).toHaveBeenCalledTimes(1);

    tapLabel(scene, scene.container, t('auction.tabBids'));
    expect(scene.activeTab).toBe('bids');
    scene.destroy();
  });

  it('picking a filter chip re-fetches the market list scoped to that item type', () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    expect(worldApi.listAuctions).toHaveBeenCalledWith(WORLD_ID, undefined);

    tapLabel(scene, scene.container, t('auction.filterEquipment'));
    expect(scene.allFilter).toBe('equipment');
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2);
    expect(worldApi.listAuctions).toHaveBeenLastCalledWith(WORLD_ID, { itemType: 'equipment' });
    scene.destroy();
  });

  it('re-tapping the already-active filter chip is a no-op (no extra fetch)', () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    tapLabel(scene, scene.container, t('auction.filterAll')); // already active by default
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('the filter bar is hidden outside the "all" (market) tab', () => {
    const scene = buildScene();
    scene.activeTab = 'mine';
    scene.render();
    expect(findLabelPos(scene.container, t('auction.filterEquipment'))).toBeNull();
    scene.destroy();
  });
});
