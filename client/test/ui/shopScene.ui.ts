// Regression coverage for the 2026-07-05 ShopScene rework (see design/game/LOBBY_IA_REDESIGN.md §9):
// the [Shop|Coins|Gacha|BattlePass] group nav moved from a full-width horizontal strip to a vertical
// sidebar stacked inside the left tab rail (`sidebarNavW` — widened from the notebook-margin gutter
// by 997d589b to match every other hub), and the promo-code redemption row moved from the Shop tab
// to the Coins tab. This guards both behaviors so a future edit can't silently squash the sidebar
// back into a horizontal strip or leave the promo row orphaned.
//
// Portrait's sidebar became a bottom nav bar instead (LOBBY_IA_REDESIGN.md §18, 2026-07-30) — the
// default `buildShop` layout below ([800, 1280]) is portrait, so its own group-nav test reflects a
// horizontal bottom bar (shared y, increasing x, spanning full width) rather than the vertical
// left-gutter stack; landscape (exercised separately further down via `buildLandscape`) is unchanged.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); tabs/fields are located by
// their rendered label text, not by hit-array index, so a reorder doesn't mask a real regression.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { skinDisplayName } from '../../src/game/meta/skinDefs';
import { ShopScene, type ShopSceneCallbacks } from '../../src/scenes/ShopScene';
// Same asset the shop borrows as skin_shop_c1's placeholder art (SKIN_PLACEHOLDER_ART in shop.ts).
// Under vitest.ui.config.ts every .png import stubs to a 1×1 data-URI string, so this resolves to
// the exact URL the scene feeds to getArtTexture() — i.e. the same cached PIXI texture object.
import infantryArtUrl from '../../src/assets/units/infantry.png';
import { buildMaterialIcon } from '../../src/render/atlas/materialAtlas';

// Wrap-don't-replace treatment (same convention as mailAttachmentIcons.ui.ts's 2026-08-01 spec):
// the 2026-08-04 fix routes ShopScene's material cards through buildMaterialIcon (the AI-bitmap
// path every other material-icon site already used) instead of the generic buildCoinIcon→buildIcon
// procedural-glyph fallback — this spy lets the regression test below inspect which MaterialKind
// each card actually resolves to, without touching real rendering.
vi.mock('../../src/render/atlas/materialAtlas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/atlas/materialAtlas')>();
  return { ...actual, buildMaterialIcon: vi.fn(actual.buildMaterialIcon) };
});

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

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

/**
 * Find the LAST PIXI.Text node whose text matches `label` and return its render position.
 * "Last" (not first) matters here: ShopScene's own header title reads "Shop" (`t('shop.title')`,
 * drawn first in the tree) and its sidebar tab of the same name is drawn after it — taking the
 * last match reliably lands on the sidebar tab instead of the header title.
 */
function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === label) found = { x: node.x, y: node.y };
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

/** Absolute top/bottom edge of the LAST Text node matching `label` (anchor-corrected; the whole
 *  card tree hangs off body/container at 0,0, so node-local coords are already absolute here). */
function labelBox(container: PIXI.Container, label: string): { top: number; bottom: number } | null {
  let box: { top: number; bottom: number } | null = null;
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text && n.text === label) {
      const top = n.y - n.anchor.y * n.height;
      box = { top, bottom: top + n.height };
    }
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(container);
  return box;
}

/** Tap the tab/field whose visible label is `label` via the scene's real hit list. */
function tapLabel(scene: { container: PIXI.Container }, label: string): void {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hits: Hit[] }).hits;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under "${label}"`).toBeDefined();
  hit!.fn();
}

const SHOP = t('shop.title');
const COINS = t('shop.coinsTab');
const GACHA = t('gacha.title');
const BATTLEPASS = t('battlepass.title');
const PROMO_PLACEHOLDER = t('shop.promoPlaceholder');

function buildShop(cb: Partial<ShopSceneCallbacks>): ShopScene {
  return new ShopScene(createLayout(W, H), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getOwnedSkins: () => [],
    loadItems: async () => [],
    buy: async () => ({ ok: true }),
    openGacha() {},
    ...cb,
  });
}

describe('ShopScene — group nav is a bottom bar in portrait, not a horizontal header strip', () => {
  it('lays [Shop|Coins|Gacha|BattlePass] out left-to-right in one bottom bar (portrait)', () => {
    const scene = buildShop({ rechargeCoins: async () => ({ ok: true }), openBattlePass() {} });
    const shop = findLabelPos(scene.container, SHOP);
    const coins = findLabelPos(scene.container, COINS);
    const gacha = findLabelPos(scene.container, GACHA);
    const battlepass = findLabelPos(scene.container, BATTLEPASS);
    expect(shop).not.toBeNull();
    expect(coins).not.toBeNull();
    expect(gacha).not.toBeNull();
    expect(battlepass).not.toBeNull();

    // One horizontal row (§18): all four cells share the bottom bar's y, ordered left-to-right by x.
    const { h } = scene as unknown as { h: number };
    expect(Math.abs(coins!.y - shop!.y)).toBeLessThan(2);
    expect(Math.abs(gacha!.y - shop!.y)).toBeLessThan(2);
    expect(Math.abs(battlepass!.y - shop!.y)).toBeLessThan(2);
    expect(coins!.x).toBeGreaterThan(shop!.x);
    expect(gacha!.x).toBeGreaterThan(coins!.x);
    expect(battlepass!.x).toBeGreaterThan(gacha!.x);

    // Pinned to the bottom of the screen, not stacked below the header.
    expect(shop!.y).toBeGreaterThan(h * 0.8);

    scene.destroy();
  });

  it('omits the Coins tab when rechargeCoins is not wired, and BattlePass when openBattlePass is not wired', () => {
    const scene = buildShop({});
    expect(findLabelPos(scene.container, COINS)).toBeNull();
    expect(findLabelPos(scene.container, BATTLEPASS)).toBeNull();
    expect(findLabelPos(scene.container, GACHA)).not.toBeNull();
    scene.destroy();
  });

  it('tapping Gacha/BattlePass routes to the injected callbacks', () => {
    let openedGacha = 0;
    let openedBattlePass = 0;
    const scene = buildShop({
      openGacha: () => { openedGacha++; },
      openBattlePass: () => { openedBattlePass++; },
    });
    tapLabel(scene, GACHA);
    expect(openedGacha).toBe(1);
    tapLabel(scene, BATTLEPASS);
    expect(openedBattlePass).toBe(1);
    scene.destroy();
  });
});

describe('ShopScene — monthly card daily claim greys out once claimed today', () => {
  /** Find the LAST hit rect whose fn === the button's fn is not exposed; locate by label text + enabled styling instead. */
  function findButtonHit(scene: ShopScene, label: string): Hit | undefined {
    const pos = findLabelPos(scene.container, label);
    if (!pos) return undefined;
    const hits = (scene as unknown as { hits: Hit[] }).hits;
    return hits.find(({ rect: r }) => pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h);
  }

  /** Flush the microtask queue (constructor kicks off `loadItems()` async — the shop grid, including
   * the monthly card, only renders once that promise resolves and re-triggers `render()`). */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  const CLAIM = t('shop.monthlyClaim');
  const CLAIMED_TODAY = t('shop.monthlyClaimedToday');

  it('claim button is disabled while the card is inactive (not purchased)', async () => {
    const scene = buildShop({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      buyMonthlyCard: async () => ({ ok: true }),
      claimMonthlyCard: async () => ({ ok: true }),
    });
    await flush();
    expect(findLabelPos(scene.container, CLAIM)).not.toBeNull();
    expect(findButtonHit(scene, CLAIM)).toBeUndefined(); // disabled buttons register no hit rect
    scene.destroy();
  });

  it('claim button is enabled ("claim") while active and not yet claimed today, then greys out ("claimed today") after a successful claim', async () => {
    // Mutable server-mirror stand-in: claimMonthlyCard mutates it exactly like the real
    // shop.ts wiring does via saveManager.adoptServer(save) — getMonetization always reads
    // the live object, so ShopScene's next render() picks up the change.
    const state = { subscriptionExpiry: Date.now() + 86_400_000, subscriptionLastClaimDay: undefined as string | undefined, starterUsed: [] as string[] };
    const scene = buildShop({
      getMonetization: () => ({ ...state }),
      buyMonthlyCard: async () => ({ ok: true }),
      claimMonthlyCard: async () => {
        state.subscriptionLastClaimDay = new Date().toISOString().slice(0, 10);
        return { ok: true };
      },
    });
    await flush();

    expect(findLabelPos(scene.container, CLAIM)).not.toBeNull();
    const hit = findButtonHit(scene, CLAIM);
    expect(hit, 'claim button should be tappable before claiming').toBeDefined();

    hit!.fn(); // triggers the async claim; runDeal awaits it and re-renders on completion
    await flush();
    await flush();

    expect(findLabelPos(scene.container, CLAIMED_TODAY)).not.toBeNull();
    expect(findButtonHit(scene, CLAIMED_TODAY)).toBeUndefined(); // now disabled
    scene.destroy();
  });

  it('claim button stays greyed out ("claimed today") across a second claim attempt that the server rejects as already-claimed', async () => {
    // Reproduces the already-claimed-today server response (claimed=0 → ok:false) arriving
    // for a card whose local mirror had not yet caught up — adoptServer-equivalent mutation
    // still lands via getMonetization, so the button must grey out even on the error path.
    const state = { subscriptionExpiry: Date.now() + 86_400_000, subscriptionLastClaimDay: undefined as string | undefined, starterUsed: [] as string[] };
    const scene = buildShop({
      getMonetization: () => ({ ...state }),
      buyMonthlyCard: async () => ({ ok: true }),
      claimMonthlyCard: async () => {
        // Server already recorded today's claim (e.g. another session claimed first) — no
        // coins granted, but the save mirror still carries today's lastClaimDay.
        state.subscriptionLastClaimDay = new Date().toISOString().slice(0, 10);
        return { ok: false, key: 'shop.monthlyNothing' };
      },
    });
    await flush();

    const hit = findButtonHit(scene, CLAIM);
    expect(hit).toBeDefined();
    hit!.fn();
    await flush();
    await flush();

    expect(findLabelPos(scene.container, CLAIMED_TODAY)).not.toBeNull();
    expect(findButtonHit(scene, CLAIMED_TODAY)).toBeUndefined();
    scene.destroy();
  });
});

describe('ShopScene — starter packs show their real $ price (GACHA_DESIGN §6, not free) and disappear once claimed', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const STARTER_GROWTH = t('shop.starterGrowth');

  it('shows the $4.99 price (not "Free") and a tappable Buy button before claiming', async () => {
    const scene = buildShop({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      buyStarter: async () => ({ ok: true }),
    });
    await flush();
    expect(findLabelPos(scene.container, STARTER_GROWTH)).not.toBeNull();
    expect(findLabelPos(scene.container, '$4.99')).not.toBeNull();
    expect(findLabelPos(scene.container, t('shop.free'))).toBeNull();
    scene.destroy();
  });

  it('removes the card entirely once starterUsed includes its id, instead of leaving a disabled "Owned" tile', async () => {
    const scene = buildShop({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: ['starter_growth'] }),
      buyStarter: async () => ({ ok: true }),
    });
    await flush();
    expect(findLabelPos(scene.container, STARTER_GROWTH)).toBeNull();
    scene.destroy();
  });

  it('hides the growth pack once starterGrowthEligible is false, instead of a Buy button that always 403s', async () => {
    const scene = buildShop({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [], starterGrowthEligible: false }),
      buyStarter: async () => ({ ok: true }),
    });
    await flush();
    expect(findLabelPos(scene.container, STARTER_GROWTH)).toBeNull();
    scene.destroy();
  });

  it('claiming the pack makes the card disappear on the next render', async () => {
    const state = { subscriptionExpiry: 0, starterUsed: [] as string[] };
    const scene = buildShop({
      getMonetization: () => ({ ...state }),
      buyStarter: async () => {
        state.starterUsed.push('starter_growth');
        return { ok: true };
      },
    });
    await flush();
    expect(findLabelPos(scene.container, STARTER_GROWTH)).not.toBeNull();

    tapLabel(scene, t('shop.buy'));
    await flush();
    await flush();

    expect(findLabelPos(scene.container, STARTER_GROWTH)).toBeNull();
    scene.destroy();
  });
});

describe('ShopScene — consumable items (kind="item") render their own name/desc, not the raw id', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('shows the translated name for a known item id instead of "Item · protect_enhance"', async () => {
    const scene = buildShop({
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
    });
    await flush();
    expect(findLabelPos(scene.container, t('shop.item.protect_enhance.name'))).not.toBeNull();
    expect(findLabelPos(scene.container, t('shop.item.protect_enhance.desc'))).not.toBeNull();
    scene.destroy();
  });

  it('stays buyable every time (no "Owned" state) since it is a consumable, not a skin', async () => {
    const scene = buildShop({
      getOwnedSkins: () => ['protect_enhance'], // even if this id somehow appeared in owned skins
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
    });
    await flush();
    expect(findLabelPos(scene.container, t('shop.owned'))).toBeNull();
    expect(findLabelPos(scene.container, t('shop.buy'))).not.toBeNull();
    scene.destroy();
  });

  it('sorts consumables ahead of skins even when skins come first in loadItems', async () => {
    const scene = buildShop({
      // Skins listed BEFORE the stone in the source array; the shop must still render the stone first.
      loadItems: async () => [
        { id: 'skin_shop_c1', cost: 800, kind: 'skin', grants: 'skin_shop_c1' },
        { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' },
      ],
    });
    await flush();
    const stone = findLabelPos(scene.container, t('shop.item.protect_enhance.name'));
    const skin = findLabelPos(scene.container, skinDisplayName('skin_shop_c1'));
    expect(stone).not.toBeNull();
    expect(skin).not.toBeNull();
    // Reading order (row-major grid): stone above the skin, or same row but to its left.
    const before = stone!.y < skin!.y - 1 || (Math.abs(stone!.y - skin!.y) <= 1 && stone!.x < skin!.x);
    expect(before).toBe(true);
    scene.destroy();
  });
});

describe('ShopScene — consumable items get a "×10" bulk-buy shortcut above Buy (buying protection stones one at a time was reported friction)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const BUY_X10 = t('shop.buyX10');

  it('shows the ×10 button (disabled) alongside an enabled Buy when coins cover one but not ten', async () => {
    // buildShop's default getCoins() is 1000; protect_enhance costs 500 → covers 1 (Buy enabled) but not 10.
    const scene = buildShop({
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
    });
    await flush();
    expect(findLabelPos(scene.container, BUY_X10)).not.toBeNull();
    const hits = (scene as unknown as { hits: Hit[] }).hits;
    const pos10 = findLabelPos(scene.container, BUY_X10)!;
    expect(hits.some(({ rect: r }) => pos10.x >= r.x && pos10.x <= r.x + r.w && pos10.y >= r.y && pos10.y <= r.y + r.h))
      .toBe(false); // disabled — no hit rect
    expect(findLabelPos(scene.container, t('shop.buy'))).not.toBeNull();
    scene.destroy();
  });

  it('tapping ×10 (once affordable) calls buy() ONCE with the catalog id + qty=10 (2026-08-10: one request, not ten sequential round trips) and refreshes the catalog', async () => {
    const calls: [string, number | undefined][] = [];
    const scene = buildShop({
      getCoins: () => 5000, // 10× the 500 cost
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
      buy: async (itemId: string, qty?: number) => { calls.push([itemId, qty]); return { ok: true }; },
    });
    await flush();
    tapLabel(scene, BUY_X10);
    await flush();
    await flush();
    expect(calls).toEqual([['protect_enhance', 10]]);
    scene.destroy();
  });

  it('does not show the ×10 shortcut for material bundles (their qty already bundles units; caps need their own UX)', async () => {
    const scene = buildShop({
      loadItems: async () => [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10 }],
    });
    await flush();
    expect(findLabelPos(scene.container, BUY_X10)).toBeNull();
    scene.destroy();
  });

  it('tapping ×10 immediately disables it (busy re-render), so a second physical tap has no hit rect to land on — wiring-level busy-lock guard', async () => {
    let calls = 0;
    const scene = buildShop({
      getCoins: () => 5000,
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
      buy: async () => { calls++; return new Promise(() => {}); }, // never resolves — mirrors an in-flight request
    });
    await flush();
    tapLabel(scene, BUY_X10); // fires onBuyBulk, which synchronously bt.start()+render()s before its first await
    expect(calls).toBe(1);

    // A second real tap right after can't even reach the handler: the button just redrew disabled.
    const hits = (scene as unknown as { hits: Hit[] }).hits;
    const pos10 = findLabelPos(scene.container, BUY_X10)!;
    expect(hits.some(({ rect: r }) => pos10.x >= r.x && pos10.x <= r.x + r.w && pos10.y >= r.y && pos10.y <= r.y + r.h))
      .toBe(false);
    expect(calls).toBe(1); // still just the one purchase run in flight
    scene.destroy();
  });

  it('a real bulk purchase that spends the wallet down greys out ×10 on the next render while Buy stays enabled — coins + catalog refresh wired end to end', async () => {
    const wallet = { coins: 5500 }; // covers exactly 11× the 500 cost
    const scene = buildShop({
      getCoins: () => wallet.coins,
      loadItems: async () => [{ id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' }],
      buy: async (_itemId: string, qty?: number) => { wallet.coins -= 500 * (qty ?? 1); return { ok: true }; },
    });
    await flush();
    expect(findLabelPos(scene.container, BUY_X10)).not.toBeNull(); // 5500 >= 5000, starts enabled

    tapLabel(scene, BUY_X10);
    await flush();
    await flush();
    await flush(); // loadItems() refresh + its own re-render

    // 5500 - 10×500 = 500 left: still covers one Buy, no longer covers ten.
    expect(wallet.coins).toBe(500);
    const hits = (scene as unknown as { hits: Hit[] }).hits;
    const pos10 = findLabelPos(scene.container, BUY_X10)!;
    expect(hits.some(({ rect: r }) => pos10.x >= r.x && pos10.x <= r.x + r.w && pos10.y >= r.y && pos10.y <= r.y + r.h))
      .toBe(false); // ×10 now disabled
    expect(findLabelPos(scene.container, t('shop.buy'))).not.toBeNull();
    scene.destroy();
  });
});

describe('ShopScene — material bundles (kind="material", ECONOMY_NUMBERS §6.5 gold→material exchange)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('renders "{material name} ×{qty}" using the shared material.* translation, not the raw item id', async () => {
    const scene = buildShop({
      loadItems: async () => [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10, dailyLimit: 5, purchasedToday: 2 }],
    });
    await flush();
    expect(findLabelPos(scene.container, t('shop.item.material.title', { name: t('material.scrap'), qty: 10 }))).not.toBeNull();
    expect(findLabelPos(scene.container, t('shop.item.material.limit', { used: 2, limit: 5 }))).not.toBeNull();
    scene.destroy();
  });

  it('renders scrap/lead cards via buildMaterialIcon (the AI-bitmap path), not the generic procedural-glyph fallback — 2026-08-04 regression guard', async () => {
    const spy = buildMaterialIcon as unknown as { mock: { calls: unknown[][] } };
    spy.mock.calls.length = 0;
    const scene = buildShop({
      loadItems: async () => [
        { id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10 },
        { id: 'mat_buy_lead', cost: 105, kind: 'material', grants: 'lead', qty: 3 },
        { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' },
        { id: 'skin_shop_c1', cost: 800, kind: 'skin', grants: 'skin_shop_c1' },
      ],
    });
    await flush();
    const kinds = spy.mock.calls.map((args) => args[0]);
    // Each material card resolves via buildMaterialIcon exactly once, with its own grants id as
    // the kind — not skipped, not both cards collapsing onto the same kind.
    expect(kinds).toContain('scrap');
    expect(kinds).toContain('lead');
    // Non-material cards (protect_enhance/skin) never touch buildMaterialIcon — they keep going
    // through the generic icon/artUrl path.
    expect(kinds.filter((k) => k !== 'scrap' && k !== 'lead')).toHaveLength(0);
    scene.destroy();
  });

  it('greys out Buy and shows the cap-reached label once purchasedToday hits dailyLimit', async () => {
    const scene = buildShop({
      loadItems: async () => [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10, dailyLimit: 5, purchasedToday: 5 }],
    });
    await flush();
    expect(findLabelPos(scene.container, t('shop.item.material.capReached'))).not.toBeNull();
    expect(findLabelPos(scene.container, t('shop.buy'))).toBeNull();
    scene.destroy();
  });

  it('stays buyable every time (no "Owned" state) — stackable, not a skin', async () => {
    const scene = buildShop({
      getOwnedSkins: () => ['scrap'], // even if this id somehow appeared in owned skins
      loadItems: async () => [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10 }],
    });
    await flush();
    expect(findLabelPos(scene.container, t('shop.owned'))).toBeNull();
    expect(findLabelPos(scene.container, t('shop.buy'))).not.toBeNull();
    scene.destroy();
  });

  it('sorts materials ahead of skins but behind consumable items even when skins/items come first in loadItems', async () => {
    const scene = buildShop({
      loadItems: async () => [
        { id: 'skin_shop_c1', cost: 800, kind: 'skin', grants: 'skin_shop_c1' },
        { id: 'mat_buy_lead', cost: 105, kind: 'material', grants: 'lead', qty: 3 },
        { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance' },
      ],
    });
    await flush();
    const stone = findLabelPos(scene.container, t('shop.item.protect_enhance.name'));
    const lead = findLabelPos(scene.container, t('shop.item.material.title', { name: t('material.lead'), qty: 3 }));
    const skin = findLabelPos(scene.container, skinDisplayName('skin_shop_c1'));
    expect(stone).not.toBeNull();
    expect(lead).not.toBeNull();
    expect(skin).not.toBeNull();
    const before = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      a.y < b.y - 1 || (Math.abs(a.y - b.y) <= 1 && a.x < b.x);
    expect(before(stone!, lead!)).toBe(true);
    expect(before(lead!, skin!)).toBe(true);
    scene.destroy();
  });

  it('tapping Buy calls cb.buy with the shop catalog id ("mat_buy_scrap"), not the granted material id ("scrap") — regression guard for the itemId/grants mixup fixed server-side in shopBuy', async () => {
    const buyIds: string[] = [];
    const scene = buildShop({
      loadItems: async () => [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10 }],
      buy: async (itemId: string) => { buyIds.push(itemId); return { ok: true }; },
    });
    await flush();
    tapLabel(scene, t('shop.buy'));
    await flush();
    await flush();
    expect(buyIds).toEqual(['mat_buy_scrap']);
    scene.destroy();
  });

  it('a successful buy immediately re-fetches items so the "purchased/limit" line updates without reopening the shop — 2026-08-04 live-refresh fix', async () => {
    let purchasedToday = 0;
    let loadCalls = 0;
    const scene = buildShop({
      loadItems: async () => {
        loadCalls++;
        return [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10, dailyLimit: 5, purchasedToday }];
      },
      buy: async () => {
        purchasedToday++; // mirrors the server's real MATERIAL_SHOP_DAILY_CAP counter increment
        return { ok: true };
      },
    });
    await flush();
    expect(loadCalls).toBe(1); // the initial constructor-driven load
    expect(findLabelPos(scene.container, t('shop.item.material.limit', { used: 0, limit: 5 }))).not.toBeNull();

    tapLabel(scene, t('shop.buy'));
    await flush();
    await flush();

    expect(loadCalls).toBe(2); // onBuy re-fetched after the successful purchase, not just re-rendered stale data
    expect(findLabelPos(scene.container, t('shop.item.material.limit', { used: 1, limit: 5 }))).not.toBeNull();
    scene.destroy();
  });

  it('a FAILED buy does not spuriously bump the purchased count — the re-fetch only fires on ok:true', async () => {
    let loadCalls = 0;
    const scene = buildShop({
      loadItems: async () => {
        loadCalls++;
        return [{ id: 'mat_buy_scrap', cost: 20, kind: 'material', grants: 'scrap', qty: 10, dailyLimit: 5, purchasedToday: 0 }];
      },
      buy: async () => ({ ok: false, key: 'shop.error' }),
    });
    await flush();
    expect(loadCalls).toBe(1);

    tapLabel(scene, t('shop.buy'));
    await flush();
    await flush();

    expect(loadCalls).toBe(1); // no extra re-fetch when the purchase itself failed
    expect(findLabelPos(scene.container, t('shop.item.material.limit', { used: 0, limit: 5 }))).not.toBeNull();
    scene.destroy();
  });
});

// Regression coverage for the 2026-07-17 fix: the Coins tab stamped a "首充双倍" (first-purchase 2×)
// badge on EVERY recharge tier unconditionally, even for players who had already consumed their one-time
// first-purchase bonus (server CAS on wallets.firstPurchasedAt) — so returning payers were shown a bonus
// their next purchase would not actually receive. The badge is now gated on
// monetization.firstPurchaseUsed !== true (absent/offline = assume still available, so it still shows).
describe('ShopScene — first-purchase 2× badge only shows while the bonus is still available', () => {
  const FIRST_DOUBLE = t('shop.firstDouble');

  const buildCoins = (cb: Partial<ShopSceneCallbacks>): ShopScene =>
    buildShop({ initialTab: 'coins', rechargeCoins: async () => ({ ok: true }), ...cb });

  it('shows the badge for a fresh account (firstPurchaseUsed false)', () => {
    const scene = buildCoins({ getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false }) });
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).not.toBeNull();
    scene.destroy();
  });

  it('shows the badge when firstPurchaseUsed is absent (legacy save / not yet mirrored)', () => {
    const scene = buildCoins({ getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }) });
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).not.toBeNull();
    scene.destroy();
  });

  it('shows the badge when monetization is not wired (offline / logged out)', () => {
    const scene = buildCoins({});
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).not.toBeNull();
    scene.destroy();
  });

  it('hides the badge once the first-purchase bonus has been used (firstPurchaseUsed true)', () => {
    const scene = buildCoins({ getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: true }) });
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).toBeNull();
    scene.destroy();
  });

  it('drops the badge on the next render after the mirror flips firstPurchaseUsed to true', () => {
    const state = { subscriptionExpiry: 0, starterUsed: [] as string[], firstPurchaseUsed: false };
    const scene = buildCoins({ getMonetization: () => ({ ...state }) });
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).not.toBeNull();

    // Simulate the post-purchase mirror refresh (saveManager.adoptServer): the badge must clear on re-render.
    state.firstPurchaseUsed = true;
    (scene as unknown as { render(): void }).render();
    expect(findLabelPos(scene.container, FIRST_DOUBLE)).toBeNull();
    scene.destroy();
  });
});

describe('ShopScene — promo-code redemption lives on the Coins tab', () => {
  it('does not show the promo field on the Shop tab', () => {
    const scene = buildShop({
      rechargeCoins: async () => ({ ok: true }),
      redeemPromo: async () => ({ ok: true }),
    });
    expect(findLabelPos(scene.container, PROMO_PLACEHOLDER)).toBeNull();
    scene.destroy();
  });

  it('shows the promo field after switching to the Coins tab', () => {
    const scene = buildShop({
      rechargeCoins: async () => ({ ok: true }),
      redeemPromo: async () => ({ ok: true }),
    });
    tapLabel(scene, COINS);
    expect(findLabelPos(scene.container, PROMO_PLACEHOLDER)).not.toBeNull();
    scene.destroy();
  });

  it('never shows the promo field when redeemPromo is not wired (offline / logged out)', () => {
    const scene = buildShop({ rechargeCoins: async () => ({ ok: true }) });
    tapLabel(scene, COINS);
    expect(findLabelPos(scene.container, PROMO_PLACEHOLDER)).toBeNull();
    scene.destroy();
  });

  it('starting on the Coins tab (initialTab) shows the promo field immediately', () => {
    const scene = buildShop({
      initialTab: 'coins',
      rechargeCoins: async () => ({ ok: true }),
      redeemPromo: async () => ({ ok: true }),
    });
    expect(findLabelPos(scene.container, PROMO_PLACEHOLDER)).not.toBeNull();
    scene.destroy();
  });
});

// Regression coverage for the 2026-07-16 fix: skin cards carry an `artUrl` placeholder (SKIN_PLACEHOLDER_ART),
// but drawCard() used `PIXI.Sprite.from(url)` and set width/height *immediately* — against a texture whose
// image had not decoded yet. On a still-loading (baseTexture.valid === false) texture that yields a garbage
// scale, so the art never appeared, and the scene never re-rendered once the texture finished loading (this
// is a render()-on-change tree). The fix mirrors CardScene.drawArtFit: skip the sprite while invalid, hook
// baseTexture.once('loaded', render), and only build+size the sprite once the texture is valid.
describe('ShopScene — skin card art waits for texture load, then re-renders it in', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const SKIN_TITLE = skinDisplayName('skin_shop_c1');

  /** Every Sprite in the tree backed by the given base texture (the skin's placeholder art). */
  function artSprites(container: PIXI.Container, base: PIXI.BaseTexture): PIXI.Sprite[] {
    const out: PIXI.Sprite[] = [];
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Sprite && node.texture?.baseTexture === base) out.push(node);
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(container);
    return out;
  }

  it('draws no art sprite while the texture is loading, then a correctly-sized one once it loads', async () => {
    const tex = PIXI.Texture.from(infantryArtUrl as string);
    // Pin the pre-load state deterministically: the headless Image never fires onload, but the global
    // texture cache is shared across tests in this file, so an earlier render may have left it valid.
    tex.baseTexture.valid = false;

    const scene = buildShop({
      loadItems: async () => [{ id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1' }],
    });
    await flush();

    // The card body rendered (title present) — but with the texture unloaded, the OLD code left a
    // zero/garbage-scaled sprite here; the fix must add none until the texture is valid.
    expect(findLabelPos(scene.container, SKIN_TITLE), 'skin card should render').not.toBeNull();
    expect(artSprites(scene.container, tex.baseTexture)).toHaveLength(0);

    // Texture finishes decoding: give it a real size, mark valid, and fire the events drawCard's
    // once('loaded') hook is waiting on. 'update' refreshes the Texture frame (so orig size > 0);
    // 'loaded' triggers the scene's re-render.
    tex.baseTexture.valid = true;
    tex.baseTexture.width = 64;
    tex.baseTexture.height = 64;
    tex.baseTexture.emit('update', tex.baseTexture);
    tex.baseTexture.emit('loaded', tex.baseTexture);
    await flush();

    const sprites = artSprites(scene.container, tex.baseTexture);
    expect(sprites.length, 'art sprite should appear after the texture loads').toBeGreaterThan(0);
    // Sized to the card's icon slot (width/height set on a now-valid texture), not left native 1×1.
    expect(sprites[0].width).toBeGreaterThan(1);
    expect(sprites[0].height).toBeGreaterThan(1);

    scene.destroy();
  });
});

// Regression coverage for the 2026-07-17 fix: shop skin cards showed the raw catalogue id
// ("Skin · skin_shop_c1") because ShopItem carries no name. buildShopCards() now resolves the title
// through the shared skinDisplayName() (character card name + skin label), so the shop and gacha read
// the same human name. Guards both the pure resolver and the rendered card title.
describe('ShopScene — skin cards show the real character name, not the raw catalogue id', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('skinDisplayName resolves each shop skin to "{character}·{skin}", and falls back to the id when unmapped', () => {
    // c1→Infantry/Lichuang, r1→Archer/Suyuan, e1→ShieldBearer/Chenshou (SKIN_TARGET_UNIT + CARD_DEFS).
    for (const [id, cardKey] of [['skin_shop_c1', 'lichuang'], ['skin_shop_r1', 'suyuan'], ['skin_shop_e1', 'chenshou']] as const) {
      const name = skinDisplayName(id);
      expect(name).toBe(`${t(`card.${cardKey}.name` as never)}·${t('shop.skinLabel')}`);
      expect(name).not.toContain(id); // never the raw catalogue id
    }
    expect(skinDisplayName('not_a_skin')).toBe('not_a_skin'); // unmapped → id fallback
  });

  it('renders the resolved skin name as the card title and never the raw id', async () => {
    const scene = buildShop({
      loadItems: async () => [{ id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1' }],
    });
    await flush();
    expect(findLabelPos(scene.container, skinDisplayName('skin_shop_c1'))).not.toBeNull();
    // The old raw-id title must be gone.
    expect(findLabelPos(scene.container, `${t('shop.skinLabel')} · skin_shop_c1`)).toBeNull();
    scene.destroy();
  });
});

// Regression coverage for the 2026-07-17 fix: landscape packed ~4 narrow cards per row, so long titles
// wrapped to 2–3 lines and pushed the price row (¥/coin) down onto the bottom action buttons. The grid
// now targets ~3 wider cards per row (matching portrait). Guards the column count AND the invariant the
// column change protects: the price row must sit strictly above the card's action button.
describe('ShopScene — landscape shop grid is 3-up and the price never overlaps the buttons', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Landscape layout (w>h): exercises the multi-column grid path the fix targets.
  const buildLandscape = (cb: Partial<ShopSceneCallbacks>): ShopScene =>
    new ShopScene(createLayout(1920, 1080), new InputManager(), {
      onBack() {}, getCoins: () => 100_000_000, getOwnedSkins: () => [],
      loadItems: async () => [], buy: async () => ({ ok: true }), openGacha() {},
      ...cb,
    });

  it('lays the grid out 3 columns wide in landscape', () => {
    const scene = buildLandscape({});
    const { cols } = (scene as unknown as { gridMetrics(): { cols: number } }).gridMetrics();
    expect(cols).toBe(3);
    scene.destroy();
  });

  it('draws the skin coin price strictly above its Buy button (no overlap)', async () => {
    // Single skin item, no monetization callbacks → only the skin card renders, so "300"/"Buy" are unique.
    const scene = buildLandscape({
      loadItems: async () => [{ id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1' }],
    });
    await flush();
    const price = labelBox(scene.container, '300');
    const buy = labelBox(scene.container, t('shop.buy'));
    expect(price, 'coin price should render').not.toBeNull();
    expect(buy, 'buy button should render').not.toBeNull();
    expect(price!.bottom).toBeLessThanOrEqual(buy!.top);
    scene.destroy();
  });

  it('draws the monthly-card $ price strictly above its buttons (no overlap)', async () => {
    // Only the monthly card renders (no year card / skins), so "$4.99" and "Buy" are unique to it.
    const scene = buildLandscape({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      buyMonthlyCard: async () => ({ ok: true }),
      claimMonthlyCard: async () => ({ ok: true }),
    });
    await flush();
    const price = labelBox(scene.container, '$4.99');
    const buy = labelBox(scene.container, t('shop.buy'));
    expect(price, 'usd price should render').not.toBeNull();
    expect(buy, 'buy button should render').not.toBeNull();
    expect(price!.bottom).toBeLessThanOrEqual(buy!.top);
    scene.destroy();
  });
});

// Regression coverage for the 2026-07-20 fix: on a wide-but-vertically-short landscape window,
// LandscapeLayout grows `designWidth` to match the safe-area aspect (never narrower than the 1920
// reference) while `designHeight` stays pinned at 1080 (see layout/LandscapeLayout.ts). gridMetrics()
// derives cellW from the (now wider) design width and cellH = cellW*1.5 — with nothing checking cellH
// against the *fixed* vertical scroll budget, a wide enough window made cellH rival or exceed the whole
// scrollable viewport, leaving scrollPeek's peekViewportH (client/src/ui/widgets/scrollPeek.ts) zero
// slack to guarantee its "always show a partial next row" affordance — the Coins/"Top Up" tier grid
// rendered edge-to-edge with the second row of tiers completely invisible, indistinguishable from a
// grid that simply had no more content below. gridMetrics() now caps cellH at `h * 0.6` so the cap
// binds well before availH is exhausted, at any aspect ratio.
describe('ShopScene — Coins tab always peeks the next tier row, even on a wide/short landscape window', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Matches the aspect ratio that reproduced the bug report (~2.12:1 CSS window) — wide enough that
  // LandscapeLayout grows designWidth well past the 1920 reference (see LandscapeLayout.designWidth).
  const buildWideCoins = (cb: Partial<ShopSceneCallbacks>): ShopScene =>
    new ShopScene(createLayout(1896, 896), new InputManager(), {
      onBack() {}, getCoins: () => 1000, getOwnedSkins: () => [],
      loadItems: async () => [], buy: async () => ({ ok: true }), openGacha() {},
      initialTab: 'coins', rechargeCoins: async () => ({ ok: true }),
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      ...cb,
    });

  it('caps cellH against the height budget instead of letting it grow unbounded with a widened design width', () => {
    const scene = buildWideCoins({});
    const { w, h, landscape } = scene as unknown as { w: number; h: number; landscape: boolean };
    expect(landscape).toBe(true);
    expect(w).toBeGreaterThan(1920); // sanity: this aspect really does widen the design space
    const { cellH } = (scene as unknown as { gridMetrics(): { cellH: number } }).gridMetrics();
    expect(cellH).toBeLessThanOrEqual(Math.round(h * 0.6));
    scene.destroy();
  });

  it("renders the second tier row's top edge inside the body mask, and keeps the first row's Buy button fully visible", async () => {
    const scene = buildWideCoins({});
    await flush();
    expect(labelBox(scene.container, '$49.99'), 'second-row tier card should be in the render tree').not.toBeNull();

    const { h } = scene as unknown as { h: number };
    const { cols, cellH, gap } = (scene as unknown as {
      gridMetrics(): { cols: number; cellH: number; gap: number };
    }).gridMetrics();
    expect(cols).toBe(3); // 5 tiers at 3-up → row 1 (0-indexed) holds tiers 4-5, the "second row"
    const mask = (scene as unknown as { bodyMask: PIXI.Graphics | null }).bodyMask;
    expect(mask).not.toBeNull();
    const bounds = mask!.getLocalBounds();
    const maskBottom = bounds.y + bounds.height;
    // Mirrors CoinsMixin.drawCoinsGrid's own bodyTop derivation (top + h*0.02) — the mask's own y IS
    // `top` (maskBody(top, viewH)), so this reconstructs the grid's real content origin.
    const bodyTop = bounds.y + Math.round(h * 0.02);
    const secondRowTop = bodyTop + 1 * (cellH + gap); // row index 1

    // The whole point of the fix: the second row's top edge sits above the mask's bottom edge — i.e.
    // genuinely peeking into view, not just present in the tree but fully clipped away.
    expect(secondRowTop).toBeLessThan(maskBottom);

    // And the first row's own Buy button is still fully visible (unclipped) — the fix must not trade
    // the peek for cutting into content that already fit. Every tier's button reads "Buy", so collect
    // all of them and take the topmost (first row's), not labelBox's usual "last match" pick.
    const buyBoxes: { top: number; bottom: number }[] = [];
    const walkBuy = (n: PIXI.Container): void => {
      if (n instanceof PIXI.Text && n.text === t('shop.buy')) {
        const top = n.y - n.anchor.y * n.height;
        buyBoxes.push({ top, bottom: top + n.height });
      }
      for (const c of n.children) walkBuy(c as PIXI.Container);
    };
    walkBuy(scene.container);
    expect(buyBoxes.length, 'all 5 tier Buy buttons should render').toBe(5);
    const firstRowBuy = buyBoxes.reduce((a, b) => (a.top < b.top ? a : b));
    expect(firstRowBuy.bottom).toBeLessThanOrEqual(maskBottom);

    scene.destroy();
  });
});
