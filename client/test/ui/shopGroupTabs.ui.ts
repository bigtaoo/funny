// Regression coverage for the missing "Top Up" (Coins) tab in the shop-group peer
// tab bar. ShopScene draws [Shop|Coins?|Gacha|BattlePass?] (Coins conditional on
// rechargeCoins being wired), but GachaScene and BattlePassScene hard-coded their
// own copy of the strip as [Shop|Gacha|BattlePass] — written before the Coins tab
// existed, and never updated. Result: opening Gacha or Battle Pass from the shop
// dropped the Coins tab entirely, even when recharge was available.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) so scenes
// build their real PIXI tree in plain Node; we locate tabs by their rendered label
// text (not by hit-array index), so the test fails the same way a human clicking
// the wrong-looking tab bar would notice, and survives reordering the tab list.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import { BattlePassScene, type BattlePassCallbacks } from '../../src/scenes/BattlePassScene';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

/** Find the (first) PIXI.Text node whose text matches `label` and return its
 *  render position — tab labels are anchored (0.5, 0.5), so .x/.y IS the center. */
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

/** Tap the tab whose visible label is `label` via the scene's real hit list. */
function tapTab(scene: { container: PIXI.Container }, label: string): void {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `tab labeled "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hits: Hit[] }).hits;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under tab "${label}"`).toBeDefined();
  hit!.fn();
}

const SHOP = t('shop.title');
const COINS = t('shop.coinsTab');
const GACHA = t('gacha.title');
const BATTLEPASS = t('battlepass.title');

function buildGacha(cb: Partial<GachaSceneCallbacks>): GachaScene {
  return new GachaScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [] }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
}

function buildBattlePass(cb: Partial<BattlePassCallbacks>): BattlePassScene {
  return new BattlePassScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    ...cb,
  });
}

describe('GachaScene — shop-group tab bar Coins parity', () => {
  it('shows a Coins tab and routes it to openCoins when wired', () => {
    let openedCoins = 0;
    let openedShop = 0;
    let openedBattlePass = 0;
    const scene = buildGacha({
      openShop: () => { openedShop++; },
      openCoins: () => { openedCoins++; },
      openBattlePass: () => { openedBattlePass++; },
    });
    expect(findLabelPos(scene.container, COINS)).not.toBeNull();
    tapTab(scene, COINS);
    expect(openedCoins).toBe(1);
    expect(openedShop).toBe(0);
    expect(openedBattlePass).toBe(0);
    scene.destroy();
  });

  it('does not show a Coins tab when openCoins is not wired (e.g. WeChat/CrazyGames)', () => {
    const scene = buildGacha({ openShop() {}, openBattlePass() {} });
    expect(findLabelPos(scene.container, COINS)).toBeNull();
    scene.destroy();
  });

  it('Shop and BattlePass peer tabs still route correctly alongside Coins', () => {
    let openedShop = 0;
    let openedBattlePass = 0;
    const scene = buildGacha({
      openShop: () => { openedShop++; },
      openCoins() {},
      openBattlePass: () => { openedBattlePass++; },
    });
    tapTab(scene, SHOP);
    expect(openedShop).toBe(1);
    tapTab(scene, BATTLEPASS);
    expect(openedBattlePass).toBe(1);
    scene.destroy();
  });

  it('degrades to no group tab bar (plain back) when openShop is absent', () => {
    const scene = buildGacha({});
    expect(findLabelPos(scene.container, COINS)).toBeNull();
    expect(findLabelPos(scene.container, SHOP)).toBeNull();
    expect(findLabelPos(scene.container, BATTLEPASS)).toBeNull();
    scene.destroy();
  });

  // Regression: the lobby's shop nav icon opens Gacha (not ShopScene), so its red dot was
  // promising a claimable monthly-card reward that the landed screen had no way to show —
  // the Shop peer tab here never carried the badge ShopScene itself draws for the same state.
  it('forwards getShopBadge onto the Shop peer tab', () => {
    const badgeDotCountBefore = (scene: GachaScene): number =>
      countGraphics(scene.container);
    const withBadge = buildGacha({ openShop() {}, getShopBadge: () => true });
    const withoutBadge = buildGacha({ openShop() {}, getShopBadge: () => false });
    expect(badgeDotCountBefore(withBadge)).toBeGreaterThan(badgeDotCountBefore(withoutBadge));
    withBadge.destroy();
    withoutBadge.destroy();
  });
});

/** Rough proxy for "a badge dot got drawn": count PIXI.Graphics nodes in the tree. */
function countGraphics(container: PIXI.Container): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Graphics) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

describe('BattlePassScene — shop-group tab bar Coins parity', () => {
  it('shows a Coins tab and routes it to openCoins when wired', () => {
    let openedCoins = 0;
    let openedShop = 0;
    let openedGacha = 0;
    const scene = buildBattlePass({
      openShop: () => { openedShop++; },
      openCoins: () => { openedCoins++; },
      openGacha: () => { openedGacha++; },
    });
    expect(findLabelPos(scene.container, COINS)).not.toBeNull();
    tapTab(scene, COINS);
    expect(openedCoins).toBe(1);
    expect(openedShop).toBe(0);
    expect(openedGacha).toBe(0);
    scene.destroy();
  });

  it('does not show a Coins tab when openCoins is not wired', () => {
    const scene = buildBattlePass({ openShop() {}, openGacha() {} });
    expect(findLabelPos(scene.container, COINS)).toBeNull();
    scene.destroy();
  });

  it('Shop and Gacha peer tabs still route correctly alongside Coins', () => {
    let openedShop = 0;
    let openedGacha = 0;
    const scene = buildBattlePass({
      openShop: () => { openedShop++; },
      openCoins() {},
      openGacha: () => { openedGacha++; },
    });
    tapTab(scene, SHOP);
    expect(openedShop).toBe(1);
    tapTab(scene, GACHA);
    expect(openedGacha).toBe(1);
    scene.destroy();
  });

  it('degrades to no group tab bar (plain back) when openShop is absent', () => {
    const scene = buildBattlePass({});
    expect(findLabelPos(scene.container, COINS)).toBeNull();
    expect(findLabelPos(scene.container, SHOP)).toBeNull();
    expect(findLabelPos(scene.container, GACHA)).toBeNull();
    scene.destroy();
  });
});
