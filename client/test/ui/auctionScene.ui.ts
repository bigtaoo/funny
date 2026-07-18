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
import { AUCTION_DURATION_SEC, AUCTION_POLL_SEC } from '../../src/scenes/AuctionScene/base';
import { WorldApiError, type AuctionView, type WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipmentInstance, CardInstance } from '../../src/game/meta/SaveData';
import { setToastSink } from '../../src/net/log';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Scene toasts now route through the global sink (net/log) → GlobalToast, no longer a per-scene
// toastLayer. Capture what the scene emits so the "refuses to submit / server rejects" cases can
// still assert the user-facing message.
const toastMsgs: string[] = [];
setToastSink((text) => { toastMsgs.push(text); });

const [W, H] = [800, 1280];
const WORLD_ID = 'world:1:0';

/** Spy-backed WorldApiClient stub — every auction endpoint resolves immediately (no hang), so
 *  synchronous call-count/arg assertions right after construction are safe. */
function stubWorldApi(overrides: Partial<WorldApiClient> = {}): WorldApiClient {
  return {
    listAuctions: vi.fn(async () => [] as AuctionView[]),
    getMyListings: vi.fn(async () => [] as AuctionView[]),
    getAuctionRefBand: vi.fn(async () => ({ ref: 10, floor: 5, ceil: 20 })),
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

/** Capturing hidden-input stub. The headless UI harness (plain Node) has no DOM, so the numeric-field
 *  editor (openNumInput → document.createElement + addEventListener + blur) has nothing to attach to.
 *  Installs a fake `document` whose created <input> records its 'input'/'blur' listeners and exposes
 *  `_fire(type)` so a test can drive the real handler code. Restores the previous global on teardown. */
type StubInput = { value: string; _fire: (type: 'input' | 'blur') => void; [k: string]: unknown };
function withStubbedInput(run: () => void): void {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  g.document = {
    body: { appendChild(): void {} },
    createElement(): StubInput {
      const listeners: Record<string, Array<() => void>> = {};
      return {
        type: '', value: '', inputMode: '', maxLength: 0, placeholder: '', autocomplete: '',
        style: { cssText: '' }, parentNode: null,
        focus(): void {}, select(): void {}, remove(): void {}, setAttribute(): void {},
        addEventListener(t: string, fn: () => void): void { (listeners[t] ??= []).push(fn); },
        _fire(t: 'input' | 'blur'): void { for (const fn of listeners[t] ?? []) fn(); },
      };
    },
  };
  try { run(); } finally { g.document = prev; }
}

// ── errorMsg() — the WorldApiError code → localized-message table ─────────────────────────────

describe('AuctionScene — errorMsg()', () => {
  it('maps known WorldApiError codes to their localized message', () => {
    const scene = buildScene();
    expect(scene.errorMsg(new WorldApiError('AUCTION_CLOSED', 'x'))).toBe(t('auction.err.closed'));
    expect(scene.errorMsg(new WorldApiError('NOT_DESIGNATED_BUYER', 'x'))).toBe(t('auction.err.notDesignatedBuyer'));
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
      'material', { material: 'lead' }, 5, AUCTION_DURATION_SEC,
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
      'equipment', { instanceId: 'eq_7' }, 1, AUCTION_DURATION_SEC,
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
      'card', { instanceId: 'card_3' }, 1, AUCTION_DURATION_SEC,
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
    expect(toastMsgs).toContain(t('auction.selectItem'));
    scene.destroy();
  });

  it('refuses to submit a card listing with no instance picked (no API call)', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    scene.createClass = 'card';
    scene.createCardId = null;

    await scene.doCreate();

    expect(worldApi.createAuction).not.toHaveBeenCalled();
    expect(toastMsgs).toContain(t('auction.selectItem'));
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

    expect(toastMsgs).toContain(t('auction.err.noMaterial'));
    scene.destroy();
  });
});

// ── clampToBand() — typed-price snap into the item's guardrail band ───────────────────────────

describe('AuctionScene — clampToBand()', () => {
  it('snaps a below-floor price up to the floor and an above-ceil price down to the ceil', () => {
    const scene = buildScene();
    scene.refBand = { ref: 80, floor: 40, ceil: 160 };
    expect(scene.clampToBand(10)).toBe(40);   // too low → floor
    expect(scene.clampToBand(500)).toBe(160); // too high → ceil
    expect(scene.clampToBand(90)).toBe(90);   // in range → unchanged
    scene.destroy();
  });

  it('uses ceil()/floor() on fractional band edges so the snapped value is always inside the band', () => {
    const scene = buildScene();
    scene.refBand = { ref: 80, floor: 40.4, ceil: 160.9 };
    expect(scene.clampToBand(40)).toBe(41);   // floor rounds up (40 < 40.4)
    expect(scene.clampToBand(200)).toBe(160); // ceil rounds down
    scene.destroy();
  });

  it('passes through unchanged (min 1) when no band is loaded (cards / cold-start)', () => {
    const scene = buildScene();
    scene.refBand = null;
    expect(scene.clampToBand(0)).toBe(1);
    expect(scene.clampToBand(9999)).toBe(9999);
    scene.destroy();
  });
});

// ── openNumInput() — tap-to-type price field: live update while typing, clamp on blur ─────────

describe('AuctionScene — editable price field (openNumInput)', () => {
  it('live-updates the bound value on each keystroke (no clamp mid-typing)', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      scene.refBand = { ref: 80, floor: 40, ceil: 160 };
      const onChange = (v: number): void => { scene.createStartPrice = Math.max(1, v); };
      scene.openNumInput('startPrice', 15, onChange, (v: number) => scene.clampToBand(v));

      const inp = scene.hiddenInput as unknown as StubInput;
      expect(scene.numEditKey).toBe('startPrice');

      inp.value = '12';                // below the floor (40) — but not clamped while typing
      inp._fire('input');
      expect(scene.createStartPrice).toBe(12);
      scene.destroy();
    });
  });

  it('strips non-digit characters from the typed value', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      const onChange = (v: number): void => { scene.createPrice = Math.max(1, v); };
      scene.openNumInput('price', 10, onChange);

      const inp = scene.hiddenInput as unknown as StubInput;
      inp.value = '1a2b3';
      inp._fire('input');
      expect(inp.value).toBe('123');
      expect(scene.createPrice).toBe(123);
      scene.destroy();
    });
  });

  it('snaps a below-floor typed price up to the floor on blur, then clears the edit state', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      scene.refBand = { ref: 80, floor: 40, ceil: 160 };
      const onChange = (v: number): void => { scene.createStartPrice = Math.max(1, v); };
      scene.openNumInput('startPrice', 15, onChange, (v: number) => scene.clampToBand(v));

      const inp = scene.hiddenInput as unknown as StubInput;
      inp.value = '12';
      inp._fire('input');
      inp._fire('blur');

      expect(scene.createStartPrice).toBe(40);   // clamped up to floor on commit
      expect(scene.numEditKey).toBeNull();
      expect(scene.hiddenInput).toBeNull();
      scene.destroy();
    });
  });

  it('snaps an above-ceil typed price down to the ceil on blur', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      scene.refBand = { ref: 80, floor: 40, ceil: 160 };
      const onChange = (v: number): void => { scene.createStartPrice = Math.max(1, v); };
      scene.openNumInput('startPrice', 15, onChange, (v: number) => scene.clampToBand(v));

      const inp = scene.hiddenInput as unknown as StubInput;
      inp.value = '9999';
      inp._fire('input');
      inp._fire('blur');

      expect(scene.createStartPrice).toBe(160);
      scene.destroy();
    });
  });

  it('leaves a value with no clamp fn untouched on blur (e.g. the buyout field)', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      const onChange = (v: number): void => { scene.createBuyoutPrice = Math.max(0, v); };
      scene.openNumInput('buyout', 0, onChange);       // no clamp passed

      const inp = scene.hiddenInput as unknown as StubInput;
      inp.value = '5000';
      inp._fire('input');
      inp._fire('blur');

      expect(scene.createBuyoutPrice).toBe(5000);
      scene.destroy();
    });
  });

  it('is wired to the start-price field in the create form (tapping it opens the numeric editor)', () => {
    withStubbedInput(() => {
      const scene = buildScene();
      scene.createClass = 'equipment'; // no qty row, so '80' below is unambiguously the start price
      scene.createSaleMode = 'auction';
      scene.refBand = { ref: 80, floor: 40, ceil: 160 };
      scene.createStartPrice = 80;     // distinctive value → its rendered field label is unique
      scene.createBuyoutPrice = 0;
      scene.openCreateForm();

      // Tap the hit sitting under the rendered '80' (the editable start-price field value).
      tapLabel(scene, scene.container, '80', 'modalHits');
      expect(scene.numEditKey).toBe('startPrice');
      scene.destroy();
    });
  });

  it('renders a blinking caret in the editable field while it is being typed into', () => {
    const scene = buildScene();
    scene.createClass = 'material';
    scene.createSaleMode = 'auction';
    scene.refBand = { ref: 80, floor: 40, ceil: 160 };
    scene.createStartPrice = 80;
    scene.numEditKey = 'startPrice';

    scene.caretOn = true;
    scene.openCreateForm();
    expect(collectTexts(scene.container)).toContain('80|');

    scene.caretOn = false;
    scene.openCreateForm();
    expect(collectTexts(scene.container)).not.toContain('80|');
    scene.destroy();
  });
});

// ── myBids() — "My Bids" tab: auctions where I'm currently the top bidder ─────────────────────

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

// ── My Listings rows — closed history shows a status badge (no Cancel action), open shows Cancel ──

describe('AuctionScene — My Listings status badges', () => {
  it('open listing shows Cancel; sold/expired/cancelled show a status badge instead', () => {
    const scene = buildScene();
    scene.myListings = [
      makeAuction({ auctionId: 'open1', status: 'open' }),
      makeAuction({ auctionId: 'sold1', status: 'sold' }),
      makeAuction({ auctionId: 'exp1', status: 'expired' }),
      makeAuction({ auctionId: 'can1', status: 'cancelled' }),
    ];
    scene.activeTab = 'mine';
    scene.loading = false;
    scene.render();

    const texts = collectTexts(scene.container);
    expect(texts).toContain(t('auction.cancel'));          // open row → cancel action
    expect(texts).toContain(t('auction.statusSold'));      // closed rows → status badge
    expect(texts).toContain(t('auction.statusExpired'));
    expect(texts).toContain(t('auction.statusCancelled'));
    scene.destroy();
  });

  it('a closed listing exposes no cancel hit rect (badge is informational only)', () => {
    const scene = buildScene();
    scene.myListings = [makeAuction({ auctionId: 'exp1', status: 'expired' })];
    scene.activeTab = 'mine';
    scene.loading = false;
    scene.render();

    // The status badge must not sit over any actionable hit rect.
    const pos = findLabelPos(scene.container, t('auction.statusExpired'));
    expect(pos).not.toBeNull();
    const hits: Hit[] = scene.hitRects;
    const hit = hits.find(({ rect: r }) => pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
    expect(hit).toBeUndefined();
    scene.destroy();
  });
});

// ── renderAuctionCell() — countdown format (d/h/m/s) + compact-card stacking (16.07.2026 fix) ──

describe('AuctionScene — market cell countdown', () => {
  it('formats the remaining time as full days/hours/minutes/seconds, not bare minutes', () => {
    const fixedNow = Date.parse('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      const scene = buildScene();
      const remainingMs = ((3 * 86400) + (2 * 3600) + (5 * 60) + 20) * 1000;
      scene.allAuctions = [makeAuction({ status: 'open', expireAt: fixedNow + remainingMs })];
      scene.activeTab = 'all';
      scene.loading = false;
      scene.render();

      expect(collectTexts(scene.container)).toContain(t('auction.timeLeft', { d: 3, h: 2, m: 5, s: 20 }));
      scene.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no countdown for a closed listing (sold/expired/cancelled show a status badge instead)', () => {
    const fixedNow = Date.parse('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      const scene = buildScene();
      const remainingMs = (2 * 3600 + 30 * 60) * 1000;
      scene.myListings = [makeAuction({ status: 'sold', expireAt: fixedNow + remainingMs })];
      scene.activeTab = 'mine';
      scene.loading = false;
      scene.render();

      expect(collectTexts(scene.container)).not.toContain(t('auction.timeLeft', { d: 0, h: 2, m: 30, s: 0 }));
      scene.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the "For You" badge in Market only when I am the designated buyer', () => {
    const scene = buildScene({ myAccountId: 'acc_me' });
    scene.allAuctions = [
      makeAuction({ auctionId: 'a_mine', designatedBuyerId: 'acc_me' }),
      makeAuction({ auctionId: 'a_other', designatedBuyerId: 'acc_other' }),
      makeAuction({ auctionId: 'a_open' }),
    ];
    scene.activeTab = 'all';
    scene.loading = false;
    scene.render();

    expect(collectTexts(scene.container)).toContain(t('auction.exclusive'));
    scene.destroy();
  });

  it('does not show the "For You" badge outside Market (My Auctions / My Bids)', () => {
    const scene = buildScene({ myAccountId: 'acc_me' });
    scene.myListings = [makeAuction({ designatedBuyerId: 'acc_me' })];
    scene.activeTab = 'mine';
    scene.loading = false;
    scene.render();

    expect(collectTexts(scene.container)).not.toContain(t('auction.exclusive'));
    scene.destroy();
  });

  it('stacks below the price/buyout block instead of pinning to a fixed bottom offset', () => {
    // Regression guard for the 16.07.2026 "看起来太乱了" layout fix: the countdown used to be
    // pinned at `y + AUC_CELL_H - pad - 18` regardless of content height, leaving a large dead
    // gap above it. It must now flow immediately after the price (or buyout) line, so adding a
    // buyout line pushes the countdown further down.
    const fixedNow = Date.parse('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      const remainingMs = (5 * 3600) * 1000;
      const withoutBuyout = buildScene();
      withoutBuyout.allAuctions = [makeAuction({
        auctionId: 'no-buyout', saleMode: 'auction', status: 'open', expireAt: fixedNow + remainingMs,
      })];
      withoutBuyout.activeTab = 'all';
      withoutBuyout.loading = false;
      withoutBuyout.render();
      const yWithoutBuyout = findLabelPos(withoutBuyout.container, t('auction.timeLeft', { d: 0, h: 5, m: 0, s: 0 }))?.y;

      const withBuyout = buildScene();
      withBuyout.allAuctions = [makeAuction({
        auctionId: 'with-buyout', saleMode: 'auction', buyoutPrice: 999, status: 'open', expireAt: fixedNow + remainingMs,
      })];
      withBuyout.activeTab = 'all';
      withBuyout.loading = false;
      withBuyout.render();
      const yWithBuyout = findLabelPos(withBuyout.container, t('auction.timeLeft', { d: 0, h: 5, m: 0, s: 0 }))?.y;

      expect(yWithoutBuyout).toBeDefined();
      expect(yWithBuyout).toBeDefined();
      expect(yWithBuyout!).toBeGreaterThan(yWithoutBuyout!);

      withoutBuyout.destroy();
      withBuyout.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps the buy/bid button pinned to the card\'s bottom-right corner', () => {
    const fixedNow = Date.parse('2026-07-16T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      const scene = buildScene();
      const remainingMs = (1 * 86400 + 3 * 3600) * 1000;
      scene.allAuctions = [makeAuction({ saleMode: 'auction', buyoutPrice: 999, status: 'open', expireAt: fixedNow + remainingMs })];
      scene.activeTab = 'all';
      scene.loading = false;
      scene.render();

      const countdownPos = findLabelPos(scene.container, t('auction.timeLeft', { d: 1, h: 3, m: 0, s: 0 }));
      expect(countdownPos).not.toBeNull();

      // The buy/bid button hit rect is the only 96x40 rect in the list (btnW/btnH in list.ts).
      const btnHit = (scene.hitRects as Hit[]).find(({ rect: r }) => r.w === 96 && r.h === 40);
      expect(btnHit).toBeDefined();

      // Generous line-height allowance (14px font) — the countdown's own bottom edge must sit
      // at or above the button's top edge.
      expect(countdownPos!.y + 18).toBeLessThanOrEqual(btnHit!.rect.y);
      scene.destroy();
    } finally {
      vi.useRealTimers();
    }
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
    expect(worldApi.listAuctions).toHaveBeenCalledWith(undefined);

    tapLabel(scene, scene.container, t('auction.filterEquipment'));
    expect(scene.allFilter).toBe('equipment');
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2);
    expect(worldApi.listAuctions).toHaveBeenLastCalledWith({ itemType: 'equipment' });
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

// ── Background poll — keeps the open market fresh (auctionsvc has no push) ─────────────────────
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AuctionScene — background poll', () => {
  it('re-fetches once the poll interval elapses in update() and applies a changed snapshot', async () => {
    // First load returns one listing; the next (poll) load returns empty — as if it was bought elsewhere.
    let call = 0;
    const worldApi = stubWorldApi({
      listAuctions: vi.fn(async () => (call++ === 0 ? [makeAuction({ auctionId: 'auc_1' })] : [])),
    });
    const scene = buildScene({ worldApi });
    await flush();
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
    expect(scene.allAuctions).toHaveLength(1);

    // Not enough time yet — no extra fetch.
    scene.update(AUCTION_POLL_SEC - 1);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);

    // Cross the interval → one silent re-pull; the sold listing drops off.
    scene.update(2);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2);
    await flush();
    expect(scene.allAuctions).toHaveLength(0);
    scene.destroy();
  });

  it('holds the poll clock while a modal is open (never re-renders over an in-progress form)', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    await flush();
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);

    scene.modalOpen = true;
    scene.update(AUCTION_POLL_SEC + 5);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1); // suppressed

    scene.modalOpen = false;
    scene.update(AUCTION_POLL_SEC + 1);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // resumes once idle
    scene.destroy();
  });

  it('does not fire the poll while still loading the initial data', () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    scene.loading = true; // simulate the in-flight initial load
    scene.update(AUCTION_POLL_SEC + 1);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1); // only the constructor's load
    scene.destroy();
  });

  it('holds the poll clock while the item picker overlay is open', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    await flush();
    scene.itemPickerOpen = true; // picker replaces the list (modalOpen stays false)
    scene.update(AUCTION_POLL_SEC + 5);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('accumulates dt across several sub-interval ticks before firing once', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    await flush();
    for (let i = 0; i < 4; i++) scene.update(AUCTION_POLL_SEC / 4); // sums to exactly one interval
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // fired exactly once
    scene.destroy();
  });

  it('re-fetches scoped to the currently active filter, not the default', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    await flush();
    scene.allFilter = 'equipment';
    scene.update(AUCTION_POLL_SEC + 1);
    expect(worldApi.listAuctions).toHaveBeenLastCalledWith({ itemType: 'equipment' });
    scene.destroy();
  });

  it('skips the re-render when the snapshot signature is unchanged', async () => {
    // Same listing on every fetch → poll still calls the API but must not tear down / rebuild the body.
    // Fixed expireAt so the signature is byte-identical across fetches (makeAuction() would recompute it).
    const stable = makeAuction({ auctionId: 'auc_1', price: 100, expireAt: 9_999_999_999 });
    const worldApi = stubWorldApi({
      listAuctions: vi.fn(async () => [{ ...stable }]),
    });
    const scene = buildScene({ worldApi });
    await flush();
    const renderSpy = vi.spyOn(scene, 'render');
    scene.update(AUCTION_POLL_SEC + 1);
    await flush();
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // fetched
    expect(renderSpy).not.toHaveBeenCalled();               // but nothing changed → no re-render
    scene.destroy();
  });

  it('re-renders when a new bid changes the price (signature differs)', async () => {
    let call = 0;
    const worldApi = stubWorldApi({
      listAuctions: vi.fn(async () => [makeAuction({ auctionId: 'auc_1', price: call++ === 0 ? 100 : 120 })]),
    });
    const scene = buildScene({ worldApi });
    await flush();
    const renderSpy = vi.spyOn(scene, 'render');
    scene.update(AUCTION_POLL_SEC + 1);
    await flush();
    expect(renderSpy).toHaveBeenCalled();
    expect(scene.allAuctions[0].price).toBe(120);
    scene.destroy();
  });

  it('drops a poll result if a modal opened during the in-flight fetch (no stomp)', async () => {
    let resolveList: (v: AuctionView[]) => void = () => {};
    const worldApi = stubWorldApi({
      listAuctions: vi.fn(() => new Promise<AuctionView[]>((r) => { resolveList = r; })),
    });
    const scene = buildScene({ worldApi });
    // Let the constructor's initial load settle first.
    resolveList([makeAuction({ auctionId: 'auc_1' })]);
    await flush();

    scene.update(AUCTION_POLL_SEC + 1);       // kicks off pollRefresh (fetch now pending)
    scene.modalOpen = true;                    // user opens a form while it's in flight
    const renderSpy = vi.spyOn(scene, 'render');
    resolveList([]);                           // fetch resolves with an emptied market
    await flush();
    expect(renderSpy).not.toHaveBeenCalled();  // post-await guard drops it — form untouched
    expect(scene.allAuctions).toHaveLength(1); // snapshot left as-is
    scene.destroy();
  });

  it('keeps the last snapshot when a poll fetch fails (offline)', async () => {
    let call = 0;
    const worldApi = stubWorldApi({
      listAuctions: vi.fn(async () => {
        if (call++ === 0) return [makeAuction({ auctionId: 'auc_1' })];
        throw new Error('network down');
      }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    expect(scene.allAuctions).toHaveLength(1);
    scene.update(AUCTION_POLL_SEC + 1);
    await flush();
    expect(scene.allAuctions).toHaveLength(1); // unchanged — kept the last good snapshot
    scene.destroy();
  });

  it('stops polling after destroy (no fetch, and an in-flight refresh bails out)', async () => {
    const worldApi = stubWorldApi();
    const scene = buildScene({ worldApi });
    await flush();
    scene.destroy();
    scene.update(AUCTION_POLL_SEC + 1);
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1); // no post-destroy fetch
    await scene.pollRefresh();                              // guarded early-return, no throw
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
  });
});

// ── Concurrent-buy race — two buyers, the loser gets refreshed + told ─────────────────────────
describe('AuctionScene — buy race', () => {
  it('on AUCTION_CLOSED refreshes the market and shows the sold-out prompt', async () => {
    let call = 0;
    const worldApi = stubWorldApi({
      // Snapshot still shows the listing; the buy loses the race; the refresh returns it gone.
      listAuctions: vi.fn(async () => (call++ === 0 ? [makeAuction({ auctionId: 'auc_1' })] : [])),
      buyAuction: vi.fn(async () => { throw new WorldApiError('AUCTION_CLOSED', 'closed'); }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    toastMsgs.length = 0;

    await scene.doBuy('auc_1');

    expect(toastMsgs).toContain(t('auction.err.soldOut'));
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // refreshed after the lost race
    await flush();
    expect(scene.allAuctions).toHaveLength(0);
    scene.destroy();
  });

  it('treats AUCTION_NOT_FOUND (already purged) the same as CLOSED', async () => {
    const worldApi = stubWorldApi({
      buyAuction: vi.fn(async () => { throw new WorldApiError('AUCTION_NOT_FOUND', 'gone'); }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    toastMsgs.length = 0;

    await scene.doBuy('auc_1');

    expect(toastMsgs).toContain(t('auction.err.soldOut'));
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // refreshed
    scene.destroy();
  });

  it('a non-race buy failure (insufficient funds) shows its own error and does not refetch', async () => {
    const worldApi = stubWorldApi({
      buyAuction: vi.fn(async () => { throw new WorldApiError('INSUFFICIENT_FUNDS', 'x'); }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    toastMsgs.length = 0;

    await scene.doBuy('auc_1');

    expect(toastMsgs).toContain(t('auction.err.insufficientFunds'));
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1); // no refresh — the listing is still valid
    scene.destroy();
  });

  it('a bid on an auction that ended in the gap surfaces the error and refreshes the list', async () => {
    const worldApi = stubWorldApi({
      placeBid: vi.fn(async () => { throw new WorldApiError('AUCTION_CLOSED', 'closed'); }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    toastMsgs.length = 0;

    await scene.doBid('auc_1', 150);

    expect(toastMsgs).toContain(t('auction.err.closed'));
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(2); // stale card refreshed off
    scene.destroy();
  });

  it('a bid rejected as too low does not refetch (listing still valid)', async () => {
    const worldApi = stubWorldApi({
      placeBid: vi.fn(async () => { throw new WorldApiError('BID_TOO_LOW', 'x'); }),
    });
    const scene = buildScene({ worldApi });
    await flush();
    toastMsgs.length = 0;

    await scene.doBid('auc_1', 1);

    expect(toastMsgs).toContain(t('auction.err.bidTooLow'));
    expect(worldApi.listAuctions).toHaveBeenCalledTimes(1);
    scene.destroy();
  });
});
