// Regression coverage for the 2026-07-05 ShopScene rework (see design/game/LOBBY_IA_REDESIGN.md §9):
// the [Shop|Coins|Gacha|BattlePass] group nav moved from a full-width horizontal strip to a vertical
// sidebar stacked inside the left tab rail (`sidebarNavW` — widened from the notebook-margin gutter
// by 997d589b to match every other hub), and the promo-code redemption row moved from the Shop tab
// to the Coins tab. This guards both behaviors so a future edit can't silently squash the sidebar
// back into a horizontal strip or leave the promo row orphaned.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); tabs/fields are located by
// their rendered label text, not by hit-array index, so a reorder doesn't mask a real regression.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
import { skinDisplayName } from '../../src/game/meta/skinDefs';
import { ShopScene, type ShopSceneCallbacks } from '../../src/scenes/ShopScene';
// Same asset the shop borrows as skin_shop_c1's placeholder art (SKIN_PLACEHOLDER_ART in shop.ts).
// Under vitest.ui.config.ts every .png import stubs to a 1×1 data-URI string, so this resolves to
// the exact URL the scene feeds to getArtTexture() — i.e. the same cached PIXI texture object.
import infantryArtUrl from '../../src/assets/infantry.png';

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

describe('ShopScene — group nav is a left-gutter sidebar, not a horizontal strip', () => {
  it('stacks [Shop|Coins|Gacha|BattlePass] vertically inside the margin-line gutter', () => {
    const scene = buildShop({ rechargeCoins: async () => ({ ok: true }), openBattlePass() {} });
    const shop = findLabelPos(scene.container, SHOP);
    const coins = findLabelPos(scene.container, COINS);
    const gacha = findLabelPos(scene.container, GACHA);
    const battlepass = findLabelPos(scene.container, BATTLEPASS);
    expect(shop).not.toBeNull();
    expect(coins).not.toBeNull();
    expect(gacha).not.toBeNull();
    expect(battlepass).not.toBeNull();

    // Vertical stack: each entry strictly below the previous one (label x varies per-item since
    // it's centered next to a variable-width icon+text group, so we don't assert x equality here).
    expect(coins!.y).toBeGreaterThan(shop!.y);
    expect(gacha!.y).toBeGreaterThan(coins!.y);
    expect(battlepass!.y).toBeGreaterThan(gacha!.y);

    // Confined to the left sidebar rail (sidebarNavW — see HubTabs.ts), not spread across the full
    // screen width (a horizontal strip would place the last tab's label near the right edge of the
    // screen). Layout picks a fixed design resolution by orientation (independent of the W/H passed
    // to createLayout), so read the scene's actual design width/height/orientation back off it
    // rather than assuming it matches W/H.
    const { w: designW, h: designH, landscape } = scene as unknown as { w: number; h: number; landscape: boolean };
    const gutter = sidebarNavW(designW, designH, landscape);
    expect(shop!.x).toBeLessThan(gutter);
    expect(coins!.x).toBeLessThan(gutter);
    expect(gacha!.x).toBeLessThan(gutter);
    expect(battlepass!.x).toBeLessThan(gutter);

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

describe('ShopScene — starter packs show "Free" and disappear once claimed', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const STARTER_GROWTH = t('shop.starterGrowth');
  const FREE = t('shop.free');

  it('shows the Free label and a tappable Buy button before claiming', async () => {
    const scene = buildShop({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      buyStarter: async () => ({ ok: true }),
    });
    await flush();
    expect(findLabelPos(scene.container, STARTER_GROWTH)).not.toBeNull();
    expect(findLabelPos(scene.container, FREE)).not.toBeNull();
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
        { id: 'skin_shop_c1', cost: 800, grants: 'skin_shop_c1' },
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

  it('draws the monthly-card ¥ price strictly above its buttons (no overlap)', async () => {
    // Only the monthly card renders (no year card / skins), so "¥30" and "Buy" are unique to it.
    const scene = buildLandscape({
      getMonetization: () => ({ subscriptionExpiry: 0, starterUsed: [] }),
      buyMonthlyCard: async () => ({ ok: true }),
      claimMonthlyCard: async () => ({ ok: true }),
    });
    await flush();
    const price = labelBox(scene.container, '¥30');
    const buy = labelBox(scene.container, t('shop.buy'));
    expect(price, 'yuan price should render').not.toBeNull();
    expect(buy, 'buy button should render').not.toBeNull();
    expect(price!.bottom).toBeLessThanOrEqual(buy!.top);
    scene.destroy();
  });
});
