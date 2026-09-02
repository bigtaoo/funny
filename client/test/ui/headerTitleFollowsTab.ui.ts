// Class-level guard for the 2026-08-26 report ("皮肤页签下的顶部标题不对", LOBBY_IA_REDESIGN_LOG §27):
// a scene whose rail contains OTHER pages must have its header title name the highlighted rail cell.
// CardScene baked `t('roster.title')` once in build() and ShopScene hard-coded `t('shop.title')` in
// drawHeader(), so the skins wardrobe and the Top Up page each sat under a header naming a different
// page than the one the rail was pointing at.
//
// The per-scene specs (cardSceneSkins.ui.ts, shopGroupTabs.ui.ts) pin each fix in its own file. This
// file is the RULE, across every scene the audit covered — including the four scenes that must NOT
// retitle, so a later "consistency" pass can't quietly flip them without reading the reasoning:
//
//   rail contains another page  → header says what the highlighted cell says   (Card/Shop/Daily/Friends)
//   rail is filters inside one venue, or nested `sub:true` sub-tabs → header keeps the venue name
//                                                                    (Auction/Equipment)
//
// Both halves need the same thing: what the HEADER says, not what the tree contains — the rail draws
// the very same labels. Neither a first-match text search nor a "does this string exist" check can
// tell those apart, so everything here reads the header band by geometry (a node whose global y sits
// above sceneHeaderHeight), which works the same way for every scene regardless of how it builds.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { sceneHeaderHeight } from '../../src/ui/widgets/SceneHeader';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { ShopScene, type ShopSceneCallbacks } from '../../src/scenes/ShopScene';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import type { RetentionView } from '../../src/net/ApiClient';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Portrait, so the tab rail is the bottom nav bar (§18) and lands nowhere near the header band —
// the landscape rail starts right below the header, which would make a geometric read of "the
// header" depend on a few pixels of rail padding.
const W = 800, H = 1280;
const HEADER_H = sceneHeaderHeight(createLayout(W, H).designHeight);

/**
 * Every string drawn in the header band, minus the back pill's own label (shared chrome, present in
 * every scene). A currency readout drawn on the same row stays in — the assertions below are
 * contains/not-contains on the specific titles, so a coin balance never decides anything.
 */
function headerTexts(scene: { container: PIXI.Container }): string[] {
  const out: string[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) {
      if (node.getGlobalPosition().y < HEADER_H) out.push(node.text);
      return;
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(scene.container);
  return out.filter((s) => s !== t('common.back'));
}

/** The header says `says` and does NOT say any of `notSays` (the labels of the tabs NOT on screen). */
function expectHeader(scene: { container: PIXI.Container }, says: string, notSays: string[]): void {
  const texts = headerTexts(scene);
  expect(texts, `header should say "${says}"`).toContain(says);
  for (const other of notSays) {
    expect(texts, `header should not still say "${other}"`).not.toContain(other);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

// ── Scenes whose rail carries other pages: the header must name the active tab ────────────────

describe('header title follows the active tab — rails that contain other pages', () => {
  it('CardScene: Hero Roster ⇄ Skins', () => {
    const cb: CardCallbacks = {
      onBack() {},
      getSave: () => makeNewSave(),
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [],
      getEquippedSkin: () => null,
      equipSkin: () => {},
    };
    const scene = new CardScene(createLayout(W, H), new InputManager(), cb);
    expectHeader(scene, t('roster.title'), [t('roster.tab.skins')]);
    scene.showTab('skins');
    expectHeader(scene, t('roster.tab.skins'), [t('roster.title')]);
    scene.showTab('list');
    expectHeader(scene, t('roster.title'), [t('roster.tab.skins')]);
    scene.destroy();
  });

  it('ShopScene: Shop ⇄ Top Up', () => {
    const build = (initialTab: 'shop' | 'coins'): ShopScene => {
      const cb: ShopSceneCallbacks = {
        onBack() {},
        getCoins: () => 1000,
        getOwnedSkins: () => [],
        loadItems: async () => [],
        buy: async () => ({ ok: true }),
        openGacha() {},
        rechargeCoins: async () => ({ ok: true }),
        openTextInput: createFakeTextInput().openTextInput,
        initialTab,
      };
      return new ShopScene(createLayout(W, H), new InputManager(), cb);
    };
    const shop = build('shop');
    expectHeader(shop, t('shop.title'), [t('shop.coinsTab')]);
    shop.destroy();
    const coins = build('coins');
    expectHeader(coins, t('shop.coinsTab'), [t('shop.title')]);
    coins.destroy();
  });

  // Daily and Friends already retitled before this pass — pinned here so the rule is covered end to
  // end rather than only where it was broken. Their own specs assert the label EXISTS somewhere in
  // the tree, which the rail satisfies on its own; neither checks the header.
  it('DailyScene: Check-in ⇄ Tasks ⇄ Weekly', async () => {
    const save: SaveData = makeNewSave();
    const retention: RetentionView = {
      checkin: null, daily: null, weekly: null,
      defs: { rewards: [], tasks: [], pointsThreshold: 3, dailyCoinsReward: 5, weeklyChestTiers: [] },
      claimable: { checkin: false, daily: false, weeklyTiers: [] },
      ads: { watchedToday: 0, cap: 5, rewardCoins: 10, cooldownMs: 0, nextAvailableAt: 0 },
    };
    const cb: DailyCallbacks = {
      onBack() {},
      getSave: () => save,
      getRetention: () => Promise.resolve(retention),
    };
    const scene = new DailyScene(createLayout(W, H), new InputManager(), cb);
    await flush();
    const s = scene as unknown as { activeTab: string; render(): void };
    const CHECKIN = t('daily.checkin.title'), TASKS = t('daily.tasks.title'), WEEKLY = t('daily.weekly.title');
    expectHeader(scene, CHECKIN, [TASKS, WEEKLY]);
    s.activeTab = 'tasks'; s.render();
    expectHeader(scene, TASKS, [CHECKIN, WEEKLY]);
    s.activeTab = 'weekly'; s.render();
    expectHeader(scene, WEEKLY, [CHECKIN, TASKS]);
    scene.destroy();
  });

  it('FriendsScene: Friends ⇄ Mail ⇄ World', () => {
    const build = (defaultTab: 'friends' | 'mail' | 'world'): FriendsScene =>
      new FriendsScene(createLayout(W, H), new InputManager(), {
        onBack() {}, onOpenRoom() {},
        openTextInput: createFakeTextInput().openTextInput,
        myPublicId: '',
        getProfileExtra: async () => ({}),
        loadFriends: async () => [],
        loadRequests: async () => ({ incoming: [], outgoing: [] }),
        search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
        addFriend: async () => {},
        respond: async () => {},
        removeFriend: async () => {},
        blockUser: async () => {}, reportUser: async () => {},
        duelInvite: () => {}, duelRespond: () => {},
        loadConversations: async () => [],
        openChat() {},
        loadMail: async () => ({ mail: [], unread: 0 }),
        markMailRead: async () => {},
        claimMail: async () => true,
        deleteMail: async () => {},
        loadSLGStatus: async () => ({ worldId: 'world:1:0', isLeader: false }),
        openFamilyHub: () => false,
        openSectHub: () => false,
        defaultTab,
      });
    const FRIENDS = t('friends.tab.friends'), MAIL = t('friends.tab.mail'), WORLD = t('friends.tab.world');
    for (const [tab, title, others] of [
      ['friends', FRIENDS, [MAIL, WORLD]],
      ['mail', MAIL, [FRIENDS, WORLD]],
      ['world', WORLD, [FRIENDS, MAIL]],
    ] as const) {
      const scene = build(tab);
      expectHeader(scene, title, [...others]);
      scene.destroy();
    }
  });
});

// ── Scenes whose rail is filters/sub-tabs: the header deliberately keeps the venue name ──────────

describe('header title stays put — rails that only filter one page', () => {
  it('AuctionScene keeps "Auction House" across Market / My Listings / My Bids', () => {
    const scene = new AuctionScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      // Nothing in this file loads market data; a bare object is enough for the header + rail.
      worldApi: {} as WorldApiClient,
      myAccountId: 'acc_test',
      openTextInput: createFakeTextInput().openTextInput,
    });
    const core = (scene as unknown as { core: { activeTab: string; render(): void } }).core;
    for (const tab of ['all', 'mine', 'bids'] as const) {
      core.activeTab = tab;
      core.render();
      expectHeader(scene, t('auction.title'), [t('auction.tabMine'), t('auction.tabBids')]);
    }
    scene.destroy();
  });

  it('EquipmentScene keeps "Equipment" across its Inventory / Craft sub-tabs', () => {
    const save = makeNewSave('acc_test');
    save.cardInv = { card1: { id: 'card1', defId: 'lichuang', level: 1, gear: {}, locked: false } };
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: 'card1',
    };
    const scene = new EquipmentScene(createLayout(W, H), new InputManager(), cb);
    const core = (scene as unknown as { core: { activeTab: string; render(): void } }).core;
    for (const tab of ['inv', 'craft'] as const) {
      core.activeTab = tab;
      core.render();
      expectHeader(scene, t('equip.title'), [t('equip.tabInv'), t('equip.tabCraft')]);
    }
    scene.destroy();
  });
});
