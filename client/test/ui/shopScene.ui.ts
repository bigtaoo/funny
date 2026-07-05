// Regression coverage for the 2026-07-05 ShopScene rework (see design/game/LOBBY_IA_REDESIGN.md §9):
// the [Shop|Coins|Gacha|BattlePass] group nav moved from a full-width horizontal strip to a vertical
// sidebar stacked inside the red notebook-margin gutter (`marginLineX`), and the promo-code redemption
// row moved from the Shop tab to the Coins tab. This guards both behaviors so a future edit can't
// silently squash the sidebar back into a horizontal strip or leave the promo row orphaned.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles); tabs/fields are located by
// their rendered label text, not by hit-array index, so a reorder doesn't mask a real regression.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { marginLineX } from '../../src/render/sketchUi';
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

    // Confined to the red margin-line gutter, not spread across the full screen width (a horizontal
    // strip would place the last tab's label near the right edge of the screen). Layout picks a
    // fixed design resolution by orientation (independent of the W/H passed to createLayout), so
    // read the scene's actual design width back off it rather than assuming it matches W.
    const designW = (scene as unknown as { w: number }).w;
    const gutter = marginLineX(designW);
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
