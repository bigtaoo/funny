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
import { ShopScene, type ShopSceneCallbacks } from '../../src/scenes/ShopScene';

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
