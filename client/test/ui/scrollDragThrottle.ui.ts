// Regression coverage for the 2026-07-15 scroll-drag jank fix.
//
// Bug: several list/roster scenes called `this.render()` — a full teardown + rebuild of every
// Text/Graphics node in the scene — directly from handleMove(), which InputManager dispatches
// straight off raw DOM pointermove/touchmove events with NO throttling. Browsers can deliver those
// far faster than the display refresh rate, so a single drag gesture could trigger dozens of full
// scene rebuilds per rendered frame — the worst case being FamilyScene/SectScene, whose render()
// recreates a hand-drawn sketchPanel border per roster row / chat message.
//
// Fix: handleMove now only updates scroll state and sets a `scrollDirty` flag; the actual
// render() call moved into update() (ticker-gated — SceneManager calls scene.update() once per
// rendered frame), so a drag gesture re-renders at most once per frame regardless of how many raw
// pointermove events land in between.
//
// These tests assert the contract directly: N handleMove calls between two update() ticks must
// produce at most the one render() from the frame boundary, not one per handleMove call.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { EquipmentScene } from '../../src/scenes/EquipmentScene';
import type { EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { CardScene } from '../../src/scenes/CardScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { CityScene } from '../../src/scenes/CityScene';
import { ShopScene } from '../../src/scenes/ShopScene';
import { DeckBuilderScene } from '../../src/scenes/DeckBuilderScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { FriendView, ChatMessageView } from '../../src/net/ApiClient';

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

/** Never-resolving WorldApiClient stub — enough for FamilyScene/SectScene/AuctionScene to sit in
 *  their loading state without a real network, which is all a scroll-throttle test needs. */
function stubWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getMarches: never, getOccupations: never,
    joinWorld: never, occupyTile: never, abandonTile: never,
    startMarch: never, recallMarch: never,
    listFamilies: never, getFamily: never, createFamily: never,
    joinFamily: never, leaveFamily: never, kickMember: never,
    setRole: never, dissolveFamily: never,
    sendFamilyMessage: never, getFamilyChannel: never,
    listAuctions: never, getMyListings: never,
    createAuction: never, buyAuction: never, cancelAuction: never,
    listSects: never, getSect: never, createSect: never,
    joinSect: never, leaveSect: never, dissolveSect: never,
    allySect: never, unallySect: never, voteRemoveSectLeader: never,
    sendSectMessage: never, getSectChannel: never,
  } as unknown as WorldApiClient;
}

/**
 * Drive a drag gesture (down + a few over-slop moves via the real InputManager dispatch path —
 * same as a real pointermove burst) and assert render() only fires once the next update() tick
 * drains the dirty flag, not once per move event.
 */
function assertScrollDragThrottled(scene: any, input: InputManager): void {
  const renderSpy = vi.spyOn(scene, 'render');

  input._emitDown(W / 2, H / 2);
  // Several raw pointermove events in the same gesture — this is exactly the burst a real
  // trackpad/touch surface can deliver well above the display refresh rate.
  input._emitMove(W / 2, H / 2 + 20);
  input._emitMove(W / 2, H / 2 + 40);
  input._emitMove(W / 2, H / 2 + 60);
  expect(renderSpy).not.toHaveBeenCalled();

  scene.update(1 / 60);
  expect(renderSpy).toHaveBeenCalledTimes(1);

  // A second frame with no further movement must not re-render.
  scene.update(1 / 60);
  expect(renderSpy).toHaveBeenCalledTimes(1);

  scene.destroy();
}

/**
 * Same contract as assertScrollDragThrottled(), but drags upward (decreasing y — the
 * gesture a user makes to scroll a list *down*). FriendsScene/ChatScene's onPointerMove only
 * flags scrollDirty when the requested offset actually differs from the current scrollY; at
 * scrollY=0 a downward drag clamps right back to 0 and never dirties, so those two scenes need
 * the opposite direction from the FamilyScene-style ScrollTapGesture scenes above.
 */
function assertScrollDragThrottledUpward(scene: any, input: InputManager): void {
  const renderSpy = vi.spyOn(scene, 'render');

  input._emitDown(W / 2, H / 2);
  input._emitMove(W / 2, H / 2 - 20);
  input._emitMove(W / 2, H / 2 - 40);
  input._emitMove(W / 2, H / 2 - 60);
  expect(renderSpy).not.toHaveBeenCalled();

  scene.update(1 / 60);
  expect(renderSpy).toHaveBeenCalledTimes(1);

  scene.update(1 / 60);
  expect(renderSpy).toHaveBeenCalledTimes(1);

  scene.destroy();
}

describe('scroll-drag render throttle (2026-07-15 perf fix)', () => {
  it('FamilyScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new FamilyScene(createLayout(W, H), input, {
      onBack() {}, onOpenSect() {}, onNavTab() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    }) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('SectScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new SectScene(createLayout(W, H), input, {
      onBack() {}, onNavTab() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
      getCoins: () => 100000, refreshWallet: async () => {},
    }) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('AuctionScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new AuctionScene(createLayout(W, H), input, {
      onBack() {}, worldApi: stubWorldApi(),
    }) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('CityScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new CityScene(createLayout(W, H), input, {
      onBack() {},
      worldApi: {
        getMe: () => new Promise(() => {}),
        upgradeBuilding: () => new Promise(() => {}),
        speedupBuild: () => new Promise(() => {}),
      } as unknown as WorldApiClient,
      worldId: 'world:1:0',
    }) as any;
    // Start the drag well below the (short, 10-building) card grid — an empty decorative
    // area, not a building card — so the gesture scrolls instead of opening a detail modal.
    const y = scene.h - 20;
    const renderSpy = vi.spyOn(scene, 'render');
    input._emitDown(W / 2, y);
    input._emitMove(W / 2, y - 20);
    input._emitMove(W / 2, y - 40);
    input._emitMove(W / 2, y - 60);
    expect(renderSpy).not.toHaveBeenCalled();
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('ShopScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new ShopScene(createLayout(W, H), input, {
      onBack() {},
      getCoins: () => 1000,
      getOwnedSkins: () => [],
      loadItems: async () => [],
      buy: async () => ({ ok: true }),
      recharge: async () => ({ ok: true }),
      openGacha() {},
    }) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('EquipmentScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const save = makeNewSave('acc_test');
    const input = new InputManager();
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(W, H), input, cb) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('CardScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const save = makeNewSave('acc_test');
    const input = new InputManager();
    const scene = new CardScene(createLayout(W, H), input, {
      onBack() {},
      getSave: () => save,
      fuseCards: async () => ({ ok: true }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [],
      getEquippedSkin: () => null,
      equipSkin() {},
    }) as any;
    assertScrollDragThrottled(scene, input);
  });

  it('DeckBuilderScene: drag-scroll renders once per frame, not once per pointermove', () => {
    const input = new InputManager();
    const scene = new DeckBuilderScene(createLayout(W, H), input, {
      onSave() {}, onBack() {},
      getCurrentDeck: () => undefined,
      getCurrentElo: () => 1000,
    }) as any;
    // DeckBuilderScene's drag starts on down inside the list region, not anywhere on screen —
    // handleDown gates on y being within [listStartY, listStartY + listH]. Use that band instead
    // of the shared W/2,H/2 helper.
    const renderSpy = vi.spyOn(scene, 'render');
    const y = scene.listStartY + 10;
    input._emitDown(W / 2, y);
    input._emitMove(W / 2, y + 20);
    input._emitMove(W / 2, y + 40);
    expect(renderSpy).not.toHaveBeenCalled();
    scene.update(1 / 60);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    scene.destroy();
  });

  it('FriendsScene: friends-list drag-scroll renders once per frame, not once per pointermove (2026-07-18 fix)', async () => {
    const friends: FriendView[] = Array.from({ length: 30 }, (_, i) => ({
      publicId: String(100000000 + i), displayName: `Friend${i}`, online: i % 2 === 0,
    }));
    const input = new InputManager();
    const scene = new FriendsScene(createLayout(W, H), input, {
      onBack() {}, onOpenRoom() {},
      loadFriends: async () => friends,
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {},
      claimMail: async () => true, deleteMail: async () => {},
    }) as any;
    // Flush the refresh() microtasks queued by the constructor so the 30-row friends list
    // (and its non-zero maxScroll) is actually rendered before we drive the drag.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scene.maxScroll).toBeGreaterThan(0);
    // Drag upward (decreasing y) from scrollY=0 so the requested scroll offset actually
    // changes (a downward drag would clamp to the same 0 and never dirty the scroll).
    assertScrollDragThrottledUpward(scene, input);
  });

  it('FriendsScene: scrollY reflects the final drag position (not an intermediate one) once drained', async () => {
    const friends: FriendView[] = Array.from({ length: 30 }, (_, i) => ({
      publicId: String(100000000 + i), displayName: `Friend${i}`, online: i % 2 === 0,
    }));
    const input = new InputManager();
    const scene = new FriendsScene(createLayout(W, H), input, {
      onBack() {}, onOpenRoom() {},
      loadFriends: async () => friends,
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {},
      claimMail: async () => true, deleteMail: async () => {},
    }) as any;
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scene.maxScroll).toBeGreaterThan(0);

    input._emitDown(W / 2, H / 2);
    input._emitMove(W / 2, H / 2 - 20);
    input._emitMove(W / 2, H / 2 - 40);
    input._emitMove(W / 2, H / 2 - 60); // dy = -60 total from down
    scene.update(1 / 60); // single drained render should reflect the LAST move, not an intermediate one

    expect(scene.scrollY).toBe(Math.min(scene.maxScroll, 60));
    scene.destroy();
  });

  it('FriendsScene: a released drag does not fire the row tap it started on', async () => {
    const friends: FriendView[] = Array.from({ length: 30 }, (_, i) => ({
      publicId: String(100000000 + i), displayName: `Friend${i}`, online: i % 2 === 0,
    }));
    const input = new InputManager();
    const opened: string[] = [];
    const scene = new FriendsScene(createLayout(W, H), input, {
      onBack() {}, onOpenRoom() {},
      loadFriends: async () => friends,
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {}, blockUser: async () => {},
      loadConversations: async () => [], openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }), markMailRead: async () => {},
      claimMail: async () => true, deleteMail: async () => {},
    }) as any;
    // Stub in a spy so we can tell whether a profile hit fired without relying on ProfilePopup internals.
    (scene as any).openFriendProfile = (id: string) => opened.push(id);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scene.maxScroll).toBeGreaterThan(0);

    input._emitDown(W / 2, H / 2);
    input._emitMove(W / 2, H / 2 - 20); // exceeds DRAG_THRESHOLD -> dragging = true
    input._emitUp(W / 2, H / 2 - 20);

    expect(opened).toEqual([]);
    scene.destroy();
  });

  it('ChatScene: message-thread drag-scroll renders once per frame, not once per pointermove (2026-07-18 fix)', async () => {
    const messages: ChatMessageView[] = Array.from({ length: 40 }, (_, i) => ({
      messageId: `m${i}`, convId: 'c1', fromPublicId: '123456789', body: `hello ${i}`, kind: 'text', ts: i,
    }));
    const input = new InputManager();
    const scene = new ChatScene(createLayout(W, H), input, {
      onBack() {}, peerName: 'Bob', peerPublicId: '123456789', myPublicId: '987654321',
      resolveConvId: async () => 'c1',
      loadMessages: async () => messages,
      send: async () => ({ messageId: 'mx', ts: 0 }),
      markRead: async () => {},
    }) as any;
    // Flush the load() microtasks queued by the constructor so the 40-message thread (and its
    // non-zero maxScroll) is actually rendered before we drive the drag.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(scene.maxScroll).toBeGreaterThan(0);
    // ChatScene starts pinned to the bottom (scrollY === maxScroll), so — unlike FriendsScene,
    // which starts at scrollY=0 — a *downward* drag is what actually changes the offset here.
    assertScrollDragThrottled(scene, input);
  });

  it('ChatScene: scrollY reflects the final drag position (not an intermediate one) once drained', async () => {
    const messages: ChatMessageView[] = Array.from({ length: 40 }, (_, i) => ({
      messageId: `m${i}`, convId: 'c1', fromPublicId: '123456789', body: `hello ${i}`, kind: 'text', ts: i,
    }));
    const input = new InputManager();
    const scene = new ChatScene(createLayout(W, H), input, {
      onBack() {}, peerName: 'Bob', peerPublicId: '123456789', myPublicId: '987654321',
      resolveConvId: async () => 'c1',
      loadMessages: async () => messages,
      send: async () => ({ messageId: 'mx', ts: 0 }),
      markRead: async () => {},
    }) as any;
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const maxScroll0 = scene.maxScroll;
    expect(maxScroll0).toBeGreaterThan(0);

    input._emitDown(W / 2, H / 2);
    input._emitMove(W / 2, H / 2 + 20);
    input._emitMove(W / 2, H / 2 + 40);
    input._emitMove(W / 2, H / 2 + 60); // dy = +60 total from down -> scrolls up (away from bottom)
    scene.update(1 / 60); // single drained render should reflect the LAST move, not an intermediate one

    expect(scene.scrollY).toBe(Math.max(0, maxScroll0 - 60));
    scene.destroy();
  });
});
