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
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave } from '../../src/game/meta/SaveData';

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
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getMarches: never,
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
      feedCards: async () => ({ ok: true }),
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
});
