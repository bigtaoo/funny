// Scene startup smoke tests — does each scene construct, update and destroy without
// throwing, in both portrait and landscape layouts? The headless PIXI adapter
// (test/harness/pixiHeadless.ts, wired via vitest.ui.config.ts setupFiles) lets the
// real scene code build its PIXI tree and measure text in plain Node.
//
// Scope: menu / overlay scenes (the bulk of the UI). The two gameplay scenes
// (GameScene / ReplayScene) drive the full GameRenderer and are intentionally left
// out of this first pass — they belong to a heavier render smoke once the UI
// stabilises (post-launch, per the agreed plan).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import * as log from '../../src/net/log';
import type { Scene } from '../../src/scenes/SceneManager';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

import { IntroScene } from '../../src/scenes/IntroScene';
import { IllustratedInterludeScene } from '../../src/scenes/IllustratedInterludeScene';
import { LoginScene } from '../../src/scenes/LoginScene';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { ShopScene } from '../../src/scenes/ShopScene';
import { GachaScene } from '../../src/scenes/GachaScene';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';
import { LevelPrepScene } from '../../src/scenes/LevelPrepScene';
import { marginLineX } from '../../src/render/sketchUi';
import { CardCodexScene } from '../../src/scenes/CardCodexScene';
import { StatsScene } from '../../src/scenes/StatsScene';
import { TitlesScene } from '../../src/scenes/TitlesScene';
import { RoomScene, CODE_ALPHABET } from '../../src/scenes/RoomScene';
import { codeEntryLayout } from '../../src/scenes/RoomScene/views';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import { ResultScene } from '../../src/scenes/ResultScene';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { CityScene } from '../../src/scenes/CityScene';
import { EquipmentScene } from '../../src/scenes/EquipmentScene';
import type { EquipmentCallbacks, EquipResult } from '../../src/scenes/EquipmentScene';
import { EQUIPMENT_INV_CAP } from '../../src/game/meta/equipmentDefs';
import { BattlePassScene } from '../../src/scenes/BattlePassScene';
import { DeckBuilderScene } from '../../src/scenes/DeckBuilderScene';
import { LeaderboardScene } from '../../src/scenes/LeaderboardScene';
import { AchievementScene } from '../../src/scenes/AchievementScene';
import { DailyScene } from '../../src/scenes/DailyScene';
import { EventScene } from '../../src/scenes/EventScene';
import { RechargeScene } from '../../src/scenes/RechargeScene';
import { DefenseEditorScene } from '../../src/scenes/DefenseEditorScene';
import { CardScene } from '../../src/scenes/CardScene';
import type { PlayerStats, UnitType } from '@nw/engine/types';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave, type SaveData, type EquipSlot } from '../../src/game/meta/SaveData';
import { createFakeTextInput } from '../harness/fakeTextInput';

// In-memory storage so initI18n (which persists the locale) has somewhere to write.
const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];

const zeroStats = (owner: 0 | 1): PlayerStats => ({
  owner,
  damageDealtToBase: 0,
  damageTakenByBase: 0,
  unitsSent: 0,
  unitsKilled: 0,
  spellHits: 0,
  killsByType: {},
  castsByType: {},
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

/** Minimal WorldApiClient stub — all methods return never-resolving promises so the
 *  scene's async loadData() just hangs silently (all API calls are try/caught). */
function stubWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getMarches: never, getOccupations: never, getSiegeHolds: never, getStationed: never, getTeams: never,
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

/** stubWorldApi() plus the defense-editor-specific endpoints it doesn't cover. */
function stubDefenseWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    ...stubWorldApi(),
    getDefense: never, setDefense: never,
    getTeams: never, getMe: never, setTeams: never,
    distributeTroops: never,
  } as unknown as WorldApiClient;
}

/**
 * Equipment fixture (EQUIPMENT_DESIGN §11): one card ('card1', lichuang) wearing a fine weapon
 * (eqEquippedFine), plus unequipped bag items — a common weapon (eqBagCommon, doubles as the
 * common-rarity reforge material), a fine weapon (eqBagFine, the reforge target used below), and
 * an epic weapon (eqBagEpic, level 0 — never salvageable per ADR-050 regardless of level).
 * Materials/coins are set high so afford checks never gate the tests.
 */
function buildEquipSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 999, lead: 999, binding: 999 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, gear: { weapon: 'eqEquippedFine' }, locked: false },
  };
  save.equipmentInv = {
    eqEquippedFine: { id: 'eqEquippedFine', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }] },
    eqBagCommon: { id: 'eqBagCommon', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 10 }] },
    eqBagFine: { id: 'eqBagFine', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }] },
    eqBagEpic: { id: 'eqBagEpic', defId: 'wp_highlighter', rarity: 'epic', level: 0, affixes: [{ id: 'm_atk', value: 40 }] },
  };
  return save;
}

/** Spied EquipmentCallbacks over `buildEquipSave()`; every call is recorded in `calls` for assertions. */
function buildEquipCallbacks(activeCardInstanceId: string) {
  const calls = {
    craft: [] as string[],
    enhance: [] as Array<[string, boolean | undefined]>,
    salvage: [] as string[][],
    equip: [] as Array<[EquipSlot, string | null, string]>,
    reforge: [] as Array<[string, string]>,
  };
  const save = buildEquipSave();
  const ok: EquipResult = { ok: true };
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async (defId) => { calls.craft.push(defId); return ok; },
    enhance: async (id, useProtect) => { calls.enhance.push([id, useProtect]); return { ok: true, success: true, level: 1 }; },
    salvage: async (ids) => { calls.salvage.push(ids); return ok; },
    equip: async (slot, id, cardId) => { calls.equip.push([slot, id, cardId]); return ok; },
    reforge: async (targetId, materialId) => { calls.reforge.push([targetId, materialId]); return ok; },
    activeCardInstanceId,
  };
  return { cb, calls, save };
}

/** Every PIXI.Text baseTexture reachable from `root` (recursing sub-containers) — collect
 * BEFORE the teardown under test, since a Text's own `.texture` reference goes away on destroy. */
function collectTextBaseTextures(root: PIXI.Container): PIXI.BaseTexture[] {
  const out: PIXI.BaseTexture[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.texture.baseTexture);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/**
 * Build → update twice → destroy. Asserts the container is real, nothing throws, and —
 * crucially — that destroy() actually tears the display tree down.
 *
 * Regression guard for the recurring "UI-switch freeze": scenes that only unsubscribed
 * input in destroy() left every child (boiling-line titles, building/unit fx) alive with
 * its `PIXI.Ticker.shared` closure still running, which accumulated across navigations and
 * eventually stalled the app. A destroyed container has removed + destroyed all children,
 * so `.destroyed === true` is the invariant every scene must uphold.
 *
 * 2026-08-03: also asserts every PIXI.Text's canvas baseTexture is actually freed, not just
 * structurally detached — see claudedocs/client-memory-leak.md §8.5/§8.6/§8.7. This is what
 * lets a scene simply being registered here (as opposed to a scene-specific hand test) stand
 * in as its Text-teardown regression coverage.
 */
function exercise(scene: Scene): void {
  expect(scene.container).toBeInstanceOf(PIXI.Container);
  scene.update(1 / 30);
  scene.update(1 / 30);
  const textBaseTextures = collectTextBaseTextures(scene.container);
  scene.destroy();
  expect(scene.container.destroyed).toBe(true);
  expect(textBaseTextures.every((b) => b.destroyed)).toBe(true);
}

/**
 * Wraps InputManager's four subscribe methods for the duration of one scene's life and reports how
 * many subscriptions are still live. `destroy()` must leave zero.
 *
 * The dynamic half of `test/input-subscription-cleanup.test.ts`. That one is a source scan: it
 * proves every `input.onX(...)` result is handed to `unsubs.push(...)`, which is where the original
 * TitlesScene leak was. What it cannot see is the other end — a scene that pushes correctly but
 * whose `destroy()` never drains the array, or drains only one of two arrays, or subscribes through
 * a widget that keeps its own list. InputManager outlives every scene (it is owned by the app), so
 * a handler left behind stays bound to a destroyed scene and fires on later taps that land on its
 * stale hit-rects.
 *
 * Newly load-bearing since 2026-09-14: rotating the phone now tears down and rebuilds every menu
 * screen (app/sceneMounts.ts), so a scene that leaks one handler per life leaks one per rotation
 * rather than one per visit.
 *
 * Patches the prototype rather than taking an instance, because each SCENES entry constructs its
 * own InputManager inside the factory — there is nothing to hand in.
 */
function trackInputSubscriptions(): { live: () => number; restore: () => void } {
  type Sub = (fn: unknown) => () => void;
  const proto = InputManager.prototype as unknown as Record<string, Sub>;
  const originals = new Map<string, Sub>();
  let live = 0;
  for (const m of ['onDown', 'onMove', 'onUp', 'onWheel']) {
    const original = proto[m]!;
    originals.set(m, original);
    proto[m] = function patched(this: unknown, fn: unknown): () => void {
      const unsub = original.call(this, fn);
      live += 1;
      let released = false;
      // Idempotent: a scene that calls its unsub twice must not drive the count negative and hide
      // a second, genuinely leaked handler.
      return () => { if (!released) { released = true; live -= 1; } unsub(); };
    };
  }
  return {
    live: () => live,
    restore: () => { for (const [m, original] of originals) proto[m] = original; },
  };
}

// Each entry builds one scene for a given (w, h). Kept as factories so we can run the
// whole set against both orientations.
const SCENES: Array<{ name: string; build: (w: number, h: number) => Scene }> = [
  {
    name: 'IntroScene',
    build: (w, h) => new IntroScene(createLayout(w, h), new InputManager(), { onFinish() {} }),
  },
  {
    name: 'IllustratedInterludeScene',
    build: (w, h) =>
      new IllustratedInterludeScene(
        // A literal string (unlike a real webpack asset import) isn't intercepted by any
        // asset-stubbing transform, so it must already be a data: URL — PIXI's
        // determineCrossOrigin() short-circuits before touching `document` (absent in this
        // headless environment) only for `data:` URLs; see vitest.ui.config.ts's stubBinaryAssets.
        createLayout(w, h), new InputManager(), 'data:image/png;base64,', 'campaign.realLayer.ch1', { onFinish() {} },
      ),
  },
  {
    name: 'LoginScene',
    build: (w, h) =>
      new LoginScene(createLayout(w, h), new InputManager(), {
        onLogin: async () => ({ ok: true }),
        onRegister: async () => ({ ok: true }),
        onPlayOffline() {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'LobbyScene (online)',
    build: (w, h) =>
      new LobbyScene(createLayout(w, h), new InputManager(), {
        onStartGame() {},
        onStartRanked() {},
        online: true,
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenSocial() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        playerName: 'Tester',
        pvp: { rank: 'bronze', elo: 1000 },
      }),
  },
  {
    name: 'LobbyScene (offline)',
    build: (w, h) =>
      new LobbyScene(createLayout(w, h), new InputManager(), {
        onStartGame() {},
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        playerName: 'Guest',
      }),
  },
  {
    name: 'SettingsScene',
    build: (w, h) =>
      new SettingsScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        playerName: 'Tester',
        publicId: '123456789',
        pvp: { rank: 'bronze', elo: 1000 },
        renameCost: 500,
        getCoins: () => 1000,
        onRename: async (name: string) => ({ ok: true, name }),
        onLogin() {},
        onLogout() {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'ShopScene',
    build: (w, h) =>
      new ShopScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getCoins: () => 1000,
        getOwnedSkins: () => [],
        loadItems: async () => [],
        buy: async () => ({ ok: true }),
        recharge: async () => ({ ok: true }),
        openGacha() {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'GachaScene',
    build: (w, h) =>
      new GachaScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getCoins: () => 1000,
        getPity: () => 0,
        getFatePoints: () => 0,
        loadPools: async () => [],
        draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
        redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
      }),
  },
  {
    name: 'CampaignMapScene',
    build: (w, h) =>
      new CampaignMapScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onSelectLevel() {},
        onOpenEquipment() {},
        getStars: () => ({}),
        getCleared: () => [],
        isOnline: () => true,
        getPendingLevels: () => [],
      }),
  },
  {
    name: 'LevelPrepScene',
    build: (w, h) =>
      new LevelPrepScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onStart() {},
        levelNumber: 1,
        staminaCost: 1,
        getStamina: () => ({ current: 120, regenAt: 0 }),
        onBuyStamina() {},
      }),
  },
  {
    name: 'CardCodexScene',
    build: (w, h) =>
      new CardCodexScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getOwnedUnitTypes: () => new Set(),
      }),
  },
  {
    name: 'StatsScene',
    build: (w, h) =>
      new StatsScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getStats: () => ({
          pvp: { rank: 'bronze', elo: 1000, wins: 12, losses: 5, streak: 3 },
          cleared: 2,
          totalLevels: 4,
          stars: 5,
          skinsOwned: 1,
          materials: { scrap: 30, lead: 10, binding: 4 },
        }),
      }),
  },
  {
    name: 'RoomScene',
    build: (w, h) =>
      new RoomScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        createRoom() {},
        joinRoom() {},
        setReady() {},
        startMatch() {},
        createRanked() {},
        cancelQueue() {},
        available: true,
      }),
  },
  {
    name: 'FriendsScene',
    build: (w, h) =>
      new FriendsScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onOpenRoom() {},
        myPublicId: '',
        getProfileExtra: async () => ({}),
        loadFriends: async () => [],
        loadRequests: async () => ({ incoming: [], outgoing: [] }),
        search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
        addFriend: async () => {},
        respond: async () => {},
        removeFriend: async () => {},
        blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
        loadConversations: async () => [],
        openChat() {},
        loadMail: async () => ({ mail: [], unread: 0 }),
        markMailRead: async () => {},
        claimMail: async () => true,
        deleteMail: async () => {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'ChatScene',
    build: (w, h) =>
      new ChatScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        peerName: 'Bob',
        peerPublicId: '123456789',
        myPublicId: '987654321',
        resolveConvId: async () => null,
        loadMessages: async () => [],
        send: async () => ({ messageId: 'm1', ts: 0 }),
        markRead: async () => {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'ResultScene (win + ELO)',
    build: (w, h) =>
      new ResultScene(
        w,
        h,
        0,
        [zeroStats(0), zeroStats(1)],
        { onPlayAgain() {}, onBack() {}, onWatchReplay() {} },
        0,
        { delta: 16, after: 1016, rankAfter: 'bronze' },
      ),
  },
  {
    name: 'WorldMapScene',
    build: (w, h) =>
      new WorldMapScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onOpenChat() {},
        onOpenAuction() {},
        onReplaySiege() {},
        onOpenCity() {},
        onOpenDefense() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        playerName: 'Tester',
        accountId: 'acc_test',
        storage: memStore,
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'FamilyScene',
    build: (w, h) =>
      new FamilyScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onOpenSect() {},
        onNavTab() {},
        async addFriend() {},
        async getFriendPublicIds() { return new Set<string>(); },
        openChat() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        myAccountId: 'acc_test',
        playerName: 'Tester',
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'SectScene',
    build: (w, h) =>
      new SectScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onNavTab() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        myAccountId: 'acc_test',
        playerName: 'Tester',
        getCoins: () => 100000,
        refreshWallet: async () => {},
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'AuctionScene',
    build: (w, h) =>
      new AuctionScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubWorldApi(),
        openTextInput: createFakeTextInput().openTextInput,
      }),
  },
  {
    name: 'CityScene',
    build: (w, h) =>
      new CityScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
      }),
  },
  {
    name: 'EquipmentScene (active card)',
    build: (w, h) => new EquipmentScene(createLayout(w, h), new InputManager(), buildEquipCallbacks('card1').cb),
  },
  {
    name: 'EquipmentScene (bag mode)',
    build: (w, h) => new EquipmentScene(createLayout(w, h), new InputManager(), buildEquipCallbacks('').cb),
  },
  {
    // Regression coverage for the 2026-08-03 fix (destroy() called tearDownChildren but never
    // container.destroy({children:true})) — this generic exercise() below asserts
    // container.destroyed===true for every registered scene, exactly the invariant that bug
    // violated. TitlesScene had never been added to this registry, so the bug shipped unnoticed.
    name: 'TitlesScene',
    build: (w, h) =>
      new TitlesScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        titles: [],
        equippedTitle: '',
        onEquip() {},
      }),
  },
  // 2026-08-03: the following 9 scenes were the ones client-memory-leak.md §8.5 listed as
  // "~24 remaining bare-destroy scenes, unverified leak risk". Registering them here re-verifies
  // that claim directly via exercise()'s Text-baseTexture check, rather than trusting the
  // pattern-matched "no tearDownChildren" heuristic that turned out to be a false positive for
  // CampaignMapScene (§8.6 point 3) — see §8.7 for the outcome.
  {
    name: 'BattlePassScene',
    build: (w, h) =>
      new BattlePassScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getCoins: () => 1000,
      }),
  },
  {
    name: 'DeckBuilderScene',
    build: (w, h) =>
      new DeckBuilderScene(createLayout(w, h), new InputManager(), {
        onSave() {},
        onBack() {},
        getCurrentDeck: () => undefined,
        getCurrentElo: () => 1000,
      }),
  },
  {
    name: 'LeaderboardScene',
    build: (w, h) =>
      new LeaderboardScene(createLayout(w, h), new InputManager(), {
        onBack() {},
      }),
  },
  {
    name: 'AchievementScene',
    build: (w, h) =>
      new AchievementScene(createLayout(w, h), new InputManager(), {
        onBack() {},
      }),
  },
  {
    name: 'DailyScene',
    build: (w, h) =>
      new DailyScene(createLayout(w, h), new InputManager(), {
        onBack() {},
      }),
  },
  {
    name: 'EventScene',
    build: (w, h) =>
      new EventScene(createLayout(w, h), new InputManager(), {
        onBack() {},
      }),
  },
  {
    name: 'RechargeScene',
    build: (w, h) =>
      new RechargeScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getCoins: () => 1000,
      }),
  },
  {
    name: 'DefenseEditorScene (defense mode)',
    build: (w, h) =>
      new DefenseEditorScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubDefenseWorldApi(),
        worldId: 'world:1:0',
        target: { mode: 'defense', tileKey: 'world:1:0:5:5' },
      }),
  },
  {
    name: 'CardScene',
    build: (w, h) =>
      new CardScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getSave: () => makeNewSave('acc_test'),
        fuseCards: async () => ({ ok: true }),
        fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
        setCardLock: async () => ({ ok: true }),
        getOwnedSkins: () => [],
        getEquippedSkin: (_unitType: UnitType) => null,
        equipSkin: (_unitType: UnitType, _skinId: string | null) => {},
      }),
  },
];

for (const [label, [w, h]] of [
  ['portrait', PORTRAIT],
  ['landscape', LANDSCAPE],
] as const) {
  describe(`scene startup smoke — ${label} ${w}x${h}`, () => {
    for (const s of SCENES) {
      it(`${s.name} builds, updates and destroys`, () => {
        const input = trackInputSubscriptions();
        try {
          exercise(s.build(w, h));
        } finally {
          input.restore(); // before the assertion, or one leaky scene poisons every later case
        }
        expect(input.live(), 'destroy() left an InputManager subscription behind').toBe(0);
      });
    }
  });
}

// ── Targeted regression tests ────────────────────────────────────────────────

/** Rects overlap iff they share any area. */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ── CampaignMapScene: tap detection ─────────────────────────────────────────
// Regression for the original "buttons unresponsive" bug: the scene previously
// used onDown+onMove+onUp with a TAP_SLOP movement guard. This caused:
//   1. UP coordinates drifting outside hit rects (wasTap=true but coord check fails)
//   2. Unreliable onUp delivery vs onDown
// Fix: fire on onDown (same pattern as all other scenes), guarded by this.flip.
describe('CampaignMapScene — tap detection', () => {
  const layout = createLayout(...PORTRAIT);
  const dh = layout.designHeight;

  function buildCampaign(onSelectLevel: (id: string) => void) {
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() {},
      onSelectLevel,
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    // Advance past the opening flip animation (FLIP_DUR = 0.42 s)
    scene.update(1.0);
    return { scene, input };
  }

  it('fires level select on DOWN at center of hit rect', () => {
    let hit: string | null = null;
    const { scene, input } = buildCampaign((id) => { hit = id; });
    const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
    // hits[0] = back button, hits[1] = equipment button (both in header).
    // Level node hits are below the header (rect.y >= tbH).
    const tbH = Math.round(dh * 0.12);
    const levelHit = hits.find(({ rect: r }) => r.y >= tbH);
    expect(levelHit).toBeDefined();
    const { x, y, w, h } = levelHit!.rect;
    input._emitDown(x + w / 2, y + h / 2);
    expect(hit).not.toBeNull();
    scene.destroy();
  });

  it('fires level select even when DOWN coordinates are near the hit rect edge', () => {
    // Regression: old onUp pattern would miss taps near button edges if the
    // pointerup coordinates drifted slightly outside the rect.
    let hit: string | null = null;
    const { scene, input } = buildCampaign((id) => { hit = id; });
    const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
    const tbH = Math.round(dh * 0.12);
    const levelHit = hits.find(({ rect: r }) => r.y >= tbH);
    expect(levelHit).toBeDefined();
    const { x, y, w, h } = levelHit!.rect;
    // Tap 2 px inside the right edge — an area the old onUp drift would miss.
    input._emitDown(x + w - 2, y + h / 2);
    expect(hit).not.toBeNull();
    scene.destroy();
  });

  it('is interactive immediately on construction — no opening-flip gate', () => {
    // Regression for the recurring "can't select level / can't return to lobby" bug: the scene used to
    // open on the TOC and auto-flip to the chapter, gating EVERY hit behind that
    // flip. The flip only settles from update(), so if the ticker stalled the scene
    // loaded but was completely dead. The fix lands directly on the chapter page —
    // hits must be live with NO update() / frame advance at all.
    let hit: string | null = null;
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() {},
      onSelectLevel: (id) => { hit = id; },
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    // Deliberately do NOT call scene.update(): a real ticker stall must not strand us.
    expect((scene as any).flip).toBeNull();
    const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number }; fn: () => void }>;
    expect(hits.length).toBeGreaterThan(0);
    const tbH = Math.round(dh * 0.12);
    const levelHit = hits.find(({ rect: r }) => r.y >= tbH);
    expect(levelHit).toBeDefined();
    const { x, y, w, h } = levelHit!.rect;
    input._emitDown(x + w / 2, y + h / 2);
    expect(hit).not.toBeNull();
    scene.destroy();
  });

  it('chapter-page back returns to the lobby directly, without any frame advance', () => {
    // The chapter page's header "back" used to flip to the TOC page first (see the
    // "Chapters" button test below for that flow); it now calls onBack() straight
    // away, so the player never gets stuck one level of navigation "deeper" than
    // expected. Must work with zero update() calls — ticker-stall resilience.
    let backHits = 0;
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() { backHits++; },
      onSelectLevel() {},
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    const headerBack = () => (scene as any).hits.find((hh: any) => hh.rect.x === 0 && hh.rect.y === 0);
    const b = headerBack(); expect(b).toBeDefined();
    input._emitDown(b.rect.x + 2, b.rect.y + 2);
    expect(backHits).toBe(1);
    // No flip was started — the chapter page never routes through the TOC anymore.
    expect((scene as any).flip).toBeNull();
    scene.destroy();
  });

  it('"Chapters" header button flips the chapter page to the notebook overview (TOC)', () => {
    // Since back now exits straight to the lobby, the chapter page needs its own
    // way back to the TOC/notebook overview — the "Chapters" button next to Gear.
    const { scene, input } = buildCampaign(() => {});
    expect((scene as any).mode).toBe('chapter');
    // Back sits flush at y=0 with its rect.h spanning the full header row; the
    // equipment/chapters pills (sketchButton bg, added by 8739154e) are vertically
    // centered within that same row instead, so "header row" now means y < headerH,
    // not y === 0.
    const backHit = (scene as any).hits.find((hh: any) => hh.rect.x === 0 && hh.rect.y === 0);
    const headerH = backHit.rect.h;
    const headerHits = (scene as any).hits.filter((hh: any) => hh.rect.y < headerH);
    // back + equipment + chapters = 3 hits pinned to the header row on a chapter page.
    expect(headerHits.length).toBe(3);
    // Both text buttons are right-anchored; "Chapters" sits immediately left of "Gear"
    // (buildHeader pushes equipment's hit before chapters', in right-to-left reading order).
    const rightAnchored = headerHits.filter((hh: any) => hh.rect.x !== 0).sort((a: any, b: any) => b.rect.x - a.rect.x);
    const chaptersHit = rightAnchored[1];
    expect(chaptersHit).toBeDefined();
    const { x, y, w, h } = chaptersHit.rect;
    input._emitDown(x + w / 2, y + h / 2);
    scene.update(1.0); // settle the flip (FLIP_DUR = 0.42s)
    expect((scene as any).mode).toBe('toc');
    scene.destroy();
  });

  it('the TOC/notebook-overview page itself has no "Chapters" button (nothing to flip to)', () => {
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() {},
      onSelectLevel() {},
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    // Force onto the TOC page: tap chapter-page back is now direct-to-lobby, so
    // reach the TOC via the internal flip helper the "Chapters" button itself uses.
    (scene as any).backToToc();
    scene.update(1.0);
    expect((scene as any).mode).toBe('toc');
    // See the "Chapters" header button test above for why header-row hits are
    // bounded by headerH rather than a strict y === 0 check.
    const backHit = (scene as any).hits.find((hh: any) => hh.rect.x === 0 && hh.rect.y === 0);
    const headerH = backHit.rect.h;
    const headerHits = (scene as any).hits.filter((hh: any) => hh.rect.y < headerH);
    // back + equipment only — no third "Chapters" hit on the TOC page.
    expect(headerHits.length).toBe(2);
    scene.destroy();
  });

  it('lands interactive on the in-progress chapter for a partially-cleared save', () => {
    // The opening page is whichever chapter holds the first uncleared level
    // (currentChapter). With ch1 fully cleared the book opens on ch2 — and that
    // landing must be immediately tappable too, with no update()/frame advance.
    const ch1Cleared = Array.from({ length: 10 }, (_, i) => `ch1_lv${i + 1}`);
    let hit: string | null = null;
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() {},
      onSelectLevel: (id) => { hit = id; },
      onOpenEquipment() {},
      getStars: () => ({}),
      getCleared: () => ch1Cleared,
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    expect((scene as any).flip).toBeNull();
    expect((scene as any).chapter).toBe(2);
    const tbH = Math.round(dh * 0.12);
    const levelHit = (scene as any).hits.find((hh: any) => hh.rect.y >= tbH);
    expect(levelHit).toBeDefined();
    input._emitDown(levelHit.rect.x + levelHit.rect.w / 2, levelHit.rect.y + levelHit.rect.h / 2);
    // The fired level must belong to chapter 2 (the chapter we actually landed on).
    expect(hit).toMatch(/^ch2_lv/);
    scene.destroy();
  });

  it('all level-node hit rects are within design height', () => {
    const { scene } = buildCampaign(() => {});
    const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
    for (const { rect: r } of hits) {
      expect(r.y + r.h).toBeLessThanOrEqual(dh);
    }
    scene.destroy();
  });
});

// ── LobbyScene: applyWorldAvailable badge behaviour ──────────────────────────
describe('LobbyScene — applyWorldAvailable', () => {
  const [w, h] = PORTRAIT;

  function buildLobby() {
    return new LobbyScene(createLayout(w, h), new InputManager(), {
      onStartGame() {},
      onStartRanked() {},
      online: true,
      onOpenCampaign() {},
      onOpenRoom() {},
      onOpenSocial() {},
      onOpenWorld() {},
      onOpenShop() {},
      onOpenCards() {},
      onOpenStats() {},
      onOpenProfile() {},
      playerName: 'Tester',
      pvp: { rank: 'bronze', elo: 1000 },
    });
  }

  it('initial state: worldOfflineBadgeLayer is empty (health not yet checked)', () => {
    const scene = buildLobby();
    const layer = (scene as any).core.worldOfflineBadgeLayer as PIXI.Container;
    expect(layer).toBeInstanceOf(PIXI.Container);
    expect(layer.children).toHaveLength(0);
    scene.destroy();
  });

  it('applyWorldAvailable(false) draws the offline badge', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(false);
    const layer = (scene as any).core.worldOfflineBadgeLayer as PIXI.Container;
    expect(layer.children.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('applyWorldAvailable(true) keeps the badge layer empty', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(true);
    const layer = (scene as any).core.worldOfflineBadgeLayer as PIXI.Container;
    expect(layer.children).toHaveLength(0);
    scene.destroy();
  });

  it('badge is cleared after switching false → true', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(false);
    expect((scene as any).core.worldOfflineBadgeLayer.children.length).toBeGreaterThan(0);
    scene.applyWorldAvailable(true);
    expect((scene as any).core.worldOfflineBadgeLayer.children).toHaveLength(0);
    scene.destroy();
  });

  it('calling applyWorldAvailable after destroy does not throw', () => {
    const scene = buildLobby();
    scene.destroy();
    expect(() => scene.applyWorldAvailable(false)).not.toThrow();
    expect(() => scene.applyWorldAvailable(true)).not.toThrow();
  });
});

// ── LobbyScene: hit rect layout does not overlap (world-map button accessibility regression) ──
// Regression: worldPillarRect is the world-map pillar card in the main layout (promoted from
// a bottom nav slot to a pillar card). If it overlaps btnRect / campaignBtnRect / dailyBtnRect,
// tapping the world map is intercepted and produces no response.
describe('LobbyScene — hit rects do not overlap', () => {
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`worldPillarRect does not overlap btnRect, campaignBtnRect, or dailyBtnRect — ${label}`, () => {
      const scene = new LobbyScene(createLayout(w, h), new InputManager(), {
        onStartGame() {},
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenWorld() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        onOpenDaily() {},
        playerName: 'Tester',
      });

      const worldRect    = (scene as any).core.worldPillarRect  as { x: number; y: number; w: number; h: number };
      const btnRect      = (scene as any).core.btnRect         as { x: number; y: number; w: number; h: number };
      const campaignRect = (scene as any).core.campaignBtnRect as { x: number; y: number; w: number; h: number };
      const dailyRect    = (scene as any).core.dailyBtnRect    as { x: number; y: number; w: number; h: number };

      expect(rectsOverlap(worldRect, btnRect)).toBe(false);
      expect(rectsOverlap(worldRect, campaignRect)).toBe(false);
      // dailyBtnRect is only set when onOpenDaily is wired (w > 0 check)
      if (dailyRect.w > 0) expect(rectsOverlap(worldRect, dailyRect)).toBe(false);

      scene.destroy();
    });

    it(`worldPillarRect has positive dimensions and lies within the design area — ${label}`, () => {
      const layout = createLayout(w, h);
      const scene = new LobbyScene(layout, new InputManager(), {
        onStartGame() {},
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenWorld() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        playerName: 'Tester',
      });

      const r = (scene as any).core.worldPillarRect as { x: number; y: number; w: number; h: number };
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(layout.designHeight);

      scene.destroy();
    });
  }
});

// ── LobbyScene: the engagement strip is a ROW in portrait, a COLUMN in landscape ─────────────
// Regression for 2026-09-15: the strip used to be a right-hand column in both orientations, which
// cost portrait 16% of its width (the axis a phone has least of) while 44% of the band between
// header and bottom nav sat empty. Portrait now lays the same shortcuts out as a row under the
// pillars. Three things have to hold for that to be worth anything, and each is a separate `it`
// below: the cells really are side by side under the pillars (not beside them), the content column
// really did get the width back, and the row does not run into the bottom nav.
describe('LobbyScene — engagement strip orientation', () => {
  type R = { x: number; y: number; w: number; h: number };
  /** An online lobby with every strip entry wired, plus a live event window → all five cells. */
  function stripLobby(w: number, h: number): LobbyScene {
    const scene = new LobbyScene(createLayout(w, h), new InputManager(), {
      onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
      onOpenCards() {}, onOpenStats() {}, onOpenProfile() {}, onOpenWorld() {},
      onOpenDaily() {}, onOpenMail() {}, onOpenEvents() {}, onOpenFeedback() {}, onOpenAuction() {},
      online: true,
      playerName: 'Tester',
    });
    // `onOpenEvents` alone is not enough — the events cell also needs a live window pushed in.
    scene.applyEventsAvailable(true);
    return scene;
  }
  const cells = (scene: LobbyScene): R[] => {
    const c = (scene as any).core;
    return [c.dailyBtnRect, c.mailStripRect, c.eventsBtnRect, c.feedbackStripRect, c.auctionStripRect] as R[];
  };

  it('portrait: all five cells share one y, below the pillars, and are centred on the content column', () => {
    const layout = createLayout(...PORTRAIT);
    const scene = stripLobby(...PORTRAIT);
    const r = cells(scene);
    const btn = (scene as any).core.btnRect as R;
    const campaign = (scene as any).core.campaignBtnRect as R;

    for (const cell of r) expect(cell.w).toBeGreaterThan(0);
    // A row: one shared y, ascending x, none of them overlapping.
    expect(new Set(r.map((c) => c.y)).size).toBe(1);
    for (let i = 1; i < r.length; i++) expect(r[i]!.x).toBeGreaterThan(r[i - 1]!.x + r[i - 1]!.w);
    // …under the pillars, not beside them.
    expect(r[0]!.y).toBeGreaterThanOrEqual(campaign.y + campaign.h);
    // …and centred on the content column, whose width the hero button reports.
    const leftSlack  = r[0]!.x - btn.x;
    const rightSlack = (btn.x + btn.w) - (r[r.length - 1]!.x + r[r.length - 1]!.w);
    expect(Math.abs(leftSlack - rightSlack)).toBeLessThanOrEqual(1);
    expect(leftSlack).toBeGreaterThanOrEqual(0);

    scene.destroy();
    expect(btn.w).toBe(Math.round(layout.designWidth * 0.90));
  });

  it('portrait: the row clears the bottom nav', () => {
    const layout = createLayout(...PORTRAIT);
    const scene = stripLobby(...PORTRAIT);
    const last = cells(scene)[4]!;
    // Same navH the lobby draws with (bottomNav.ts / mainContent.ts both round h*0.105).
    expect(last.y + last.h).toBeLessThanOrEqual(layout.designHeight - Math.round(layout.designHeight * 0.105));
    scene.destroy();
  });

  // The pillars sit on a shared hand-drawn backdrop that overhangs the content column by its own
  // pad on every side (mainContent.ts's `drawMainContent` → `pad`), so the column's own margin is
  // NOT the block's margin. That is what made the first cut of the strip-row change look wrong:
  // handing portrait's full 93% fraction to the content left the backdrop 13px from the paper's
  // edge, and nothing failed — it was caught by eye. Derived from the public pillar rects rather
  // than the scene's internals, so it stays honest about what a reader sees; the one coupling is
  // the 0.08 pad fraction, which has to move in lockstep with mainContent.ts if it ever changes.
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`the pillars' shared backdrop keeps a margin from both paper edges — ${label}`, () => {
      const layout = createLayout(w, h);
      const scene = stripLobby(w, h);
      const campaign = (scene as any).core.campaignBtnRect as R;
      const world    = (scene as any).core.worldPillarRect as R;
      const pad = Math.round(campaign.h * 0.08);
      const minMargin = Math.round(layout.designWidth * 0.02);

      expect(campaign.x - pad).toBeGreaterThanOrEqual(minMargin);
      expect(world.x + world.w + pad).toBeLessThanOrEqual(layout.designWidth - minMargin);

      scene.destroy();
    });
  }

  // The row is positioned by the same stack arithmetic as the hero and pillars (`stackH` / `gapB` /
  // the 0.40 upward bias). Re-tuning heroH or pillarH — the obvious next move for the whitespace
  // still left under the row — moves the row too, and the two things it can land on are the pillars
  // above it and the nav below it. Both are tap targets, so a collision costs a button, not just
  // looks. The pre-existing overlap block above only pairs worldPillarRect with dailyBtnRect, from
  // when the strip was a column beside the pillars; this pairs every cell with everything.
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`no strip cell overlaps the hero, the pillars, or a nav slot — ${label}`, () => {
      const scene = stripLobby(w, h);
      const c = (scene as any).core;
      const others: [string, R][] = [
        ['hero', c.btnRect], ['campaign', c.campaignBtnRect], ['world', c.worldPillarRect],
        ['cardsNav', c.cardsNavRect], ['shopNav', c.shopNavRect],
        ['statsNav', c.statsNavRect], ['socialNav', c.socialNavRect],
      ];
      for (const cell of cells(scene)) {
        for (const [name, other] of others) {
          if (other.w <= 0) continue;  // a gated slot leaves a zeroed rect behind
          expect([name, rectsOverlap(cell, other)]).toEqual([name, false]);
        }
      }
      scene.destroy();
    });
  }

  // `designHeight` is `max(1920, 1080 * h/w)` (PortraitLayout), so on a tall phone it grows without
  // bound while the content column stays 1080 wide. The cells are sized off `h` and the row's width
  // budget off `w`, so the taller the screen the harder the cells push against that budget — 21:9
  // wants 5x207 + 4x54 = 1251 out of 972 and has to clamp to 151. One aspect proves nothing here;
  // these three pin that the clamp holds and that the row still lands between pillars and nav.
  for (const [label, [w, h]] of [
    ['16:9', [800, 1422]], ['20:9', [800, 1778]], ['21:9', [800, 1867]],
  ] as const) {
    it(`the row fits between the pillars and the bottom nav — portrait ${label}`, () => {
      const layout = createLayout(w, h);
      const scene = stripLobby(w, h);
      const r = cells(scene);
      const btn = (scene as any).core.btnRect as R;
      const campaign = (scene as any).core.campaignBtnRect as R;
      const last = r[r.length - 1]!;

      for (const cell of r) expect(cell.w).toBe(cell.h);          // cells stay square through the clamp
      expect(r[0]!.y).toBeGreaterThanOrEqual(campaign.y + campaign.h);
      expect(last.y + last.h)
        .toBeLessThanOrEqual(layout.designHeight - Math.round(layout.designHeight * 0.105));
      // …and inside the content column, which is what the clamp is for.
      expect(r[0]!.x).toBeGreaterThanOrEqual(btn.x);
      expect(last.x + last.w).toBeLessThanOrEqual(btn.x + btn.w);

      scene.destroy();
    });
  }

  it('landscape: all five cells share one x, to the right of the content column', () => {
    const scene = stripLobby(...LANDSCAPE);
    const r = cells(scene);
    const btn = (scene as any).core.btnRect as R;

    expect(new Set(r.map((c) => c.x)).size).toBe(1);
    for (let i = 1; i < r.length; i++) expect(r[i]!.y).toBeGreaterThan(r[i - 1]!.y + r[i - 1]!.h);
    expect(r[0]!.x).toBeGreaterThanOrEqual(btn.x + btn.w);

    scene.destroy();
  });
});

// ── LobbyScene: content column widens to 90% in portrait, stays 82% in landscape ──
// Regression: hero button / pillar column used a single 82% width fraction for
// both orientations. Portrait screens read the fixed side margins as
// proportionally larger, so portrait widens; landscape is untouched.
// Portrait's fraction went 90% → 93% when the header's identity chip band collapsed to one row
// (see the "portrait identity row" describe block below), then back to 90% on 2026-09-15 when the
// engagement strip moved out of the right margin and into a row under the pillars: the whole
// fraction now reaches the content column, and at 93% the pillars' shared backdrop — which
// overhangs the column by its own pad — came within 13px of the paper's edge.
describe('LobbyScene — content column width follows orientation', () => {
  for (const [label, [w, h], expectedFrac] of [
    ['portrait', PORTRAIT, 0.90],
    ['landscape', LANDSCAPE, 0.82],
  ] as const) {
    it(`btnRect width is ${expectedFrac * 100}% of design width — ${label}`, () => {
      const layout = createLayout(w, h);
      const scene = new LobbyScene(layout, new InputManager(), {
        onStartGame() {},
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenWorld() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        // No onOpenDaily wired ⇒ hasSideStrip is false, so contentW === fullContentW
        // exactly and btnRect.w directly reflects the orientation fraction below.
        playerName: 'Tester',
      });

      const btnRect = (scene as any).core.btnRect as { x: number; y: number; w: number; h: number };
      expect(btnRect.w).toBe(Math.round(layout.designWidth * expectedFrac));

      scene.destroy();
    });
  }
});

// ── LobbyScene: hero/pillar buttons grow slightly in portrait ────────────────
// Regression for the header reflow below: collapsing the identity chip band from
// a two-row stack (coins over rank) to one row freed header height in portrait,
// which was spent on the hero/pillar buttons (both grow ~6%); landscape's header
// never had a stacked sub-row to begin with, so its fractions are untouched.
describe('LobbyScene — hero/pillar button size follows orientation', () => {
  for (const [label, [w, h], heroFrac, pillarFrac] of [
    ['portrait', PORTRAIT, 0.175, 0.165],
    ['landscape', LANDSCAPE, 0.165, 0.155],
  ] as const) {
    it(`btnRect/campaignBtnRect height match the orientation fraction — ${label}`, () => {
      const layout = createLayout(w, h);
      const scene = new LobbyScene(layout, new InputManager(), {
        onStartGame() {},
        onOpenCampaign() {},
        onOpenRoom() {},
        onOpenWorld() {},
        onOpenShop() {},
        onOpenCards() {},
        onOpenStats() {},
        onOpenProfile() {},
        playerName: 'Tester',
      });

      const btnRect      = (scene as any).core.btnRect         as { h: number };
      const campaignRect = (scene as any).core.campaignBtnRect as { h: number };
      expect(btnRect.h).toBe(Math.round(layout.designHeight * heroFrac));
      expect(campaignRect.h).toBe(Math.round(layout.designHeight * pillarFrac));

      scene.destroy();
    });
  }
});

// ── LobbyScene: portrait identity row — avatar/coins/rank sit side by side ───
// Regression for the header reflow: the brand lockup (logo + title) now gets its
// own row on top in portrait, with the profile chip (avatar+name), coin balance
// and ladder-rank badge packed into ONE row below it — coins/rank used to stack
// vertically in the top-right corner (landscape still does this; it shares one
// row with the centered lockup and has the width to spare). Covers both the
// row-collapse itself (same y, no overlap) and the right-alignment (rank chip
// flush to the header's right margin, coins chip immediately to its left).
describe('LobbyScene — identity chip row', () => {
  function buildOnlineLobby(w: number, h: number) {
    const layout = createLayout(w, h);
    const scene = new LobbyScene(layout, new InputManager(), {
      onStartGame() {},
      onOpenCampaign() {},
      onOpenRoom() {},
      onOpenWorld() {},
      onOpenShop() {},
      onOpenCards() {},
      onOpenStats() {},
      onOpenProfile() {},
      onOpenRecharge() {},
      onOpenLeaderboard() {},
      getCoins: () => 97757000,
      pvp: { rank: 'platinum', elo: 1376 },
      playerName: 'tao',
    });
    return { layout, scene };
  }

  it('portrait: coins chip and rank chip share the same row (no longer stacked)', () => {
    const { scene } = buildOnlineLobby(...PORTRAIT);

    const coinsRect = (scene as any).core.coinsChipRect as { x: number; y: number; w: number; h: number };
    const rankRect  = (scene as any).core.rankChipRect  as { x: number; y: number; w: number; h: number };

    expect(coinsRect.w).toBeGreaterThan(0);
    expect(rankRect.w).toBeGreaterThan(0);
    expect(coinsRect.y).toBe(rankRect.y); // exact same row, not just "close"
    expect(rectsOverlap(coinsRect, rankRect)).toBe(false);
    expect(coinsRect.x + coinsRect.w).toBeLessThanOrEqual(rankRect.x); // coins sits left of rank

    scene.destroy();
  });

  it('portrait: rank chip is right-aligned to the header margin, profile chip is clear of both', () => {
    const { layout, scene } = buildOnlineLobby(...PORTRAIT);

    const rankRect    = (scene as any).core.rankChipRect    as { x: number; y: number; w: number; h: number };
    const profileRect = (scene as any).core.profileChipRect as { x: number; y: number; w: number; h: number };

    // Right-aligned to the same margin the header block uses elsewhere (w - w*0.04).
    expect(rankRect.x + rankRect.w).toBeLessThanOrEqual(Math.round(layout.designWidth * 0.96));
    expect(rankRect.x + rankRect.w).toBeGreaterThan(Math.round(layout.designWidth * 0.9));
    // Profile chip (avatar+name) sits in the same identity row, to the left, clear of the chips.
    expect(rectsOverlap(profileRect, rankRect)).toBe(false);
    expect(profileRect.x).toBeLessThan(rankRect.x);

    scene.destroy();
  });

  it('landscape: coins chip and rank chip still stack vertically (unchanged)', () => {
    const { scene } = buildOnlineLobby(...LANDSCAPE);

    const coinsRect = (scene as any).core.coinsChipRect as { x: number; y: number; w: number; h: number };
    const rankRect  = (scene as any).core.rankChipRect  as { x: number; y: number; w: number; h: number };

    expect(coinsRect.y).not.toBe(rankRect.y);
    expect(rankRect.y).toBeGreaterThan(coinsRect.y); // rank sits below coins, per the 0.26/0.70 split
    expect(rectsOverlap(coinsRect, rankRect)).toBe(false);

    scene.destroy();
  });

  // Regression for the fmtCoins abbreviation removal (coins now render as the full
  // "97,757,000"-style number instead of a short "97757k") — the coins chip is sized
  // from the label's real pixel width (build.ts), so a long full-precision balance
  // grows the chip well beyond what any abbreviated string ever needed. Confirms that
  // growth still doesn't crowd out the profile chip on its left, even on a narrow
  // portrait phone with a near-max balance.
  it('portrait, narrow phone: a huge full-precision coin balance still does not overlap the profile chip', () => {
    const layout = createLayout(390, 844);
    const scene = new LobbyScene(layout, new InputManager(), {
      onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenWorld() {},
      onOpenShop() {}, onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
      onOpenRecharge() {}, onOpenLeaderboard() {},
      getCoins: () => 999_999_999,
      pvp: { rank: 'platinum', elo: 1376 },
      playerName: 'tao',
    });

    const profileRect = (scene as any).core.profileChipRect as { x: number; y: number; w: number; h: number };
    const coinsRect   = (scene as any).core.coinsChipRect   as { x: number; y: number; w: number; h: number };
    const rankRect     = (scene as any).core.rankChipRect     as { x: number; y: number; w: number; h: number };

    expect(rectsOverlap(profileRect, coinsRect)).toBe(false);
    expect(rectsOverlap(coinsRect, rankRect)).toBe(false);
    expect(profileRect.x + profileRect.w).toBeLessThanOrEqual(coinsRect.x);

    scene.destroy();
  });
});

// ── LevelPrepScene: layout invariants (regression for 6-row overflow bug) ────
describe('LevelPrepScene — layout invariants', () => {
  function buildPrep(w: number, h: number, staminaCurrent = 120) {
    const layout = createLayout(w, h);
    const input = new InputManager();
    const scene = new LevelPrepScene(layout, input, {
      onBack() {},
      onStart() {},
      levelNumber: 1,
      staminaCost: 1,
      getStamina: () => ({ current: staminaCurrent, regenAt: 0 }),
      onBuyStamina() {},
    });
    return { scene, layout };
  }

  /** Full-content build: brief + objective + rewards all present, so all three top panels render. */
  function buildPrepFull(w: number, h: number) {
    const layout = createLayout(w, h);
    const input = new InputManager();
    const scene = new LevelPrepScene(layout, input, {
      onBack() {},
      onStart() {},
      levelNumber: 1,
      objective: { kind: 'survive' },
      brief: 'A match they should have won easily — they win, but badly.',
      rewards: { coins: 100, materials: { scrap: 6, lead: 2 } },
      staminaCost: 1,
      getStamina: () => ({ current: 120, regenAt: 0 }),
      onBuyStamina() {},
    });
    return { scene, layout };
  }

  for (const [label, [w, h]] of [
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ] as const) {
    it(`all hit areas within design bounds — ${label}`, () => {
      const { scene, layout } = buildPrep(w, h);
      const dw = layout.designWidth, dh = layout.designHeight;
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      expect(hits.length).toBeGreaterThan(0);
      for (const { rect: r } of hits) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(dw);
        expect(r.y + r.h).toBeLessThanOrEqual(dh);
      }
      scene.destroy();
    });

    it(`no two hit areas overlap — ${label}`, () => {
      const { scene } = buildPrep(w, h);
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      for (let i = 0; i < hits.length; i++) {
        for (let j = i + 1; j < hits.length; j++) {
          const a = hits[i]!.rect, b = hits[j]!.rect;
          expect(rectsOverlap(a, b)).toBe(false);
        }
      }
      scene.destroy();
    });

    it(`hit areas within bounds when stamina insufficient — ${label}`, () => {
      const { scene, layout } = buildPrep(w, h, 0); // current=0, insufficient
      const dh = layout.designHeight;
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      for (const { rect: r } of hits) {
        expect(r.y + r.h).toBeLessThanOrEqual(dh);
      }
      scene.destroy();
    });

    it(`renders with brief + objective + rewards without throwing, hits stay in bounds — ${label}`, () => {
      const { scene, layout } = buildPrepFull(w, h);
      const dw = layout.designWidth, dh = layout.designHeight;
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      expect(hits.length).toBeGreaterThan(0);
      for (const { rect: r } of hits) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(dw);
        expect(r.y + r.h).toBeLessThanOrEqual(dh);
      }
      scene.destroy();
    });

    // Regression: drawBrief/drawObjective/drawRewards used to left-pad panels at `w * 0.06`,
    // which sits to the LEFT of the red notebook margin rule (`marginLineX(w) = w * 0.09`) — the
    // panel background + its accent bar rendered on top of the margin line instead of beside it.
    it(`brief / objective / rewards panels start at or right of the margin line — ${label}`, () => {
      const { scene, layout } = buildPrep(w, h);
      const dw = layout.designWidth;
      const mx = marginLineX(dw);

      const captureNewChildX = (fn: () => void): number => {
        const before = (scene as any).container.children.length;
        fn();
        const added = (scene as any).container.children.slice(before);
        expect(added.length).toBeGreaterThan(0);
        return added[0].x;
      };

      const briefX = captureNewChildX(() => {
        (scene as any).cb.brief = 'Some story brief text.';
        (scene as any).drawBrief(100);
      });
      const objectiveX = captureNewChildX(() => (scene as any).drawObjective({ kind: 'survive' }, 200));
      const rewardsX = captureNewChildX(() => (scene as any).drawRewards({ coins: 50, materials: { scrap: 3 } }, 300));

      expect(briefX).toBeGreaterThanOrEqual(mx);
      expect(objectiveX).toBeGreaterThanOrEqual(mx);
      expect(rewardsX).toBeGreaterThanOrEqual(mx);

      scene.destroy();
    });
  }
});

// ── RoomScene: code-entry keypad fits one screen ────────────────────────────
// Regression for "verification-code keypad overflow": the keypad had 31 chars × 7/row = 5 rows and
// cells sized purely off width, so in landscape the rows + Clear/⌫/Confirm row
// fell off the bottom (no scroll, canvas keypad rejects the OS keyboard). Fix:
// 21-char charset (10 digits + 11 letters) = 3 rows, cells bounded by the
// vertical budget. Charset must equal the server generator (matchsvc).
function buildRoomCodeEntry(w: number, h: number, joinRoom: (code: string) => void = () => {}) {
  const layout = createLayout(w, h);
  const scene = new RoomScene(layout, new InputManager(), {
    onBack() {}, createRoom() {}, joinRoom, setReady() {},
    startMatch() {}, createRanked() {}, cancelQueue() {}, available: true,
  });
  (scene as any).onJoinPressed(); // → 'codeEntry' view, re-renders the keypad
  return { scene, layout };
}

// Hit order inside the code-entry view is back, then one key per digit IN KEYPAD ORDER (which is
// the dial-pad's 1-9-0 in portrait, not the charset's 0-9), then clear / backspace / confirm.
// Every tap re-renders and rebuilds the array, so re-read it.
const roomHits = (scene: RoomScene) => (scene as any).hits as Array<{ fn: () => void }>;
const tapDigit = (scene: RoomScene, d: string): void => {
  const { keys } = codeEntryLayout((scene as any).w, (scene as any).h);
  roomHits(scene)[1 + keys.indexOf(d)]!.fn();
};
const tapClear = (scene: RoomScene): void => { roomHits(scene)[1 + CODE_ALPHABET.length]!.fn(); };
const tapBackspace = (scene: RoomScene): void => { roomHits(scene)[2 + CODE_ALPHABET.length]!.fn(); };
const tapConfirm = (scene: RoomScene): void => { roomHits(scene)[3 + CODE_ALPHABET.length]!.fn(); };
const entered = (scene: RoomScene): string => ((scene as any).codeChars as string[]).join('');

describe('RoomScene — code-entry keypad', () => {
  it('charset is the 10 digits (2 rows of 5 in landscape, a 3-wide dial-pad in portrait)', () => {
    // Must match server matchsvc CODE_ALPHABET — its test asserts the same literal.
    expect(CODE_ALPHABET).toBe('0123456789');
    expect(CODE_ALPHABET).toHaveLength(10);
    expect(CODE_ALPHABET).not.toMatch(/[^0-9]/);
  });

  for (const [label, [w, h]] of [
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ] as const) {
    it(`all keys + actions stay within bounds — ${label}`, () => {
      const { scene, layout } = buildRoomCodeEntry(w, h);
      const dw = layout.designWidth, dh = layout.designHeight;
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      // back + 10 keypad digits + clear/⌫/confirm = 14 tappable areas, all on-screen.
      expect(hits.length).toBe(1 + CODE_ALPHABET.length + 3);
      for (const { rect: r } of hits) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(dw);
        expect(r.y + r.h).toBeLessThanOrEqual(dh);
      }
      scene.destroy();
    });
  }

  it('keys append in tap order and stop at CODE_LEN', () => {
    const { scene } = buildRoomCodeEntry(...PORTRAIT);
    for (const d of '1234567') tapDigit(scene, d);
    expect(entered(scene)).toBe('123456'); // the 7th tap is swallowed, not wrapped around
    scene.destroy();
  });

  it('backspace drops the last digit, clear drops all of them', () => {
    const { scene } = buildRoomCodeEntry(...PORTRAIT);
    for (const d of '907') tapDigit(scene, d);
    tapBackspace(scene);
    expect(entered(scene)).toBe('90');
    tapClear(scene);
    expect(entered(scene)).toBe('');
    tapBackspace(scene); // backspace on an empty code is a no-op, not a throw
    expect(entered(scene)).toBe('');
    scene.destroy();
  });

  it('confirm only joins once the code is complete', () => {
    const joined: string[] = [];
    const { scene } = buildRoomCodeEntry(...PORTRAIT, (code) => joined.push(code));
    for (const d of '12345') tapDigit(scene, d);
    tapConfirm(scene);
    expect(joined).toEqual([]); // 5 digits — the button is drawn disabled and does nothing
    tapDigit(scene, '6');
    tapConfirm(scene);
    expect(joined).toEqual(['123456']);
    scene.destroy();
  });
});

// ── EquipmentScene: domain wiring ─────────────────────────────────────────────
// EquipmentScene.ts (client-modules split, see claudedocs) is a thin assembly composed of 5
// domain classes over EquipmentSceneCore: InventoryPanel / CraftPanel / DetailPanel / AssignPanel /
// ReforgePanel (2026-08-11: converted from the former `XMixin(Base)` inheritance chain to
// composition — see claudedocs/client-modules.md's split-form priority note). The cross-domain
// call points below (the assembly's render() dispatching into each panel; the detail modal
// invoking AssignPanel's beginAssign / ReforgePanel's openReforgeSelect; AssignPanel's card picker
// calling back into DetailPanel's doEquip via the lazy `core.doEquipHook`) exercise the real
// object graph wired up in EquipmentScene's constructor — a wrong construction order or a missing
// hook wire-up would still compile but throw or silently no-op at runtime. These tests drive the
// real render dispatch + hit rects to prove the wiring actually resolves to working methods, not
// just satisfies the compiler. See test/ui/composition-wiring.ui.ts for the identity-check
// counterpart (same core/detail/assign instances shared across every panel).
describe('EquipmentScene — domain wiring', () => {
  it('craft tab: the assembly render() dispatches to CraftPanel.renderCraft, and the Craft button calls cb.craft', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).core.activeTab = 'craft';
    (scene as any).render();
    // renderCraft must have populated hitRects with a Craft button for every affordable def.
    const hits = (scene as any).core.hitRects as Array<{ fn: () => void }>;
    expect(hits.length).toBeGreaterThan(1);
    await (scene as any).craft.doCraft('wp_pencil');
    expect(calls.craft).toEqual(['wp_pencil']);
    scene.destroy();
  });

  it('craft tab: a full equipment bag greys out every Craft button, and tapping one now explains why (equip.err.full) instead of silently doing nothing', async () => {
    const { cb, save, calls } = buildEquipCallbacks('card1');
    // Pad the bag up to EQUIPMENT_INV_CAP — same shape as buildEquipSave's fixture entries,
    // materials/rarity don't matter here, only the total instance count does (craft.ts's `full` gate).
    for (let i = Object.keys(save.equipmentInv).length; i < EQUIPMENT_INV_CAP; i++) {
      save.equipmentInv[`padding${i}`] = { id: `padding${i}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    }
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).core.activeTab = 'craft';
    (scene as any).render();
    const hits = (scene as any).core.hitRects as Array<{ owner?: string; fn: () => void }>;
    const pencilHit = hits.find((hh) => hh.owner === 'wp_pencil');
    expect(pencilHit).toBeDefined();
    const spy = vi.spyOn(log, 'showToastMessage');
    pencilHit!.fn();
    expect(calls.craft).toEqual([]); // full bag → tapping must NOT fire the craft request
    expect(spy).toHaveBeenCalledWith(expect.any(String), 'error'); // ...but must explain why (equip.err.full)
    scene.destroy();
  });

  it('instanceActions (equipped item): the Unequip action wired by DetailPanel calls cb.equip', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const save = (scene as any).core.cb.getSave();
    // Actions live on the grid cell now, not the (info-only) detail modal. For this fixture
    // (fine, level 0, equipped): Enhance (materials/coins are stocked) + Unequip; not salvageable
    // or reforgeable while equipped.
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqEquippedFine) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'unequip']);
    actions.find((a) => a.key === 'unequip')!.fn();
    await Promise.resolve();
    expect(calls.equip).toEqual([['weapon', null, 'card1']]);
    expect(calls.enhance).toEqual([]); // sanity: we hit Unequip, not Enhance
    scene.destroy();
  });

  it('instanceActions(Enhance) opens the (now info+confirm) detail modal instead of firing cb.enhance directly; the modal\'s confirm button fires it with the current protect toggle', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const save = (scene as any).core.cb.getSave();
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqEquippedFine) as Array<{ key: string; fn: () => void }>;
    actions.find((a) => a.key === 'enhance')!.fn();
    expect((scene as any).core.detailId).toBe('eqEquippedFine');
    expect((scene as any).core.modalOpen).toBe(true);
    expect(calls.enhance).toEqual([]); // opening the modal must not fire the request itself
    // No protect stones in the fixture → the toggle hit is omitted, so modalHits[0] is the confirm button.
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    modalHits[0].fn();
    await Promise.resolve();
    expect(calls.enhance).toEqual([['eqEquippedFine', undefined]]);
    scene.destroy();
  });

  it('bag mode: instanceActions(Equip) → AssignPanel(beginAssign) → assembly render(renderAssign) → AssignPanel(doEquipTo) → core.doEquipHook → DetailPanel(doEquip) → cb.equip', async () => {
    const { cb, calls } = buildEquipCallbacks(''); // '' activeCardInstanceId = bag mode
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const save = (scene as any).core.cb.getSave();
    // Unequipped common item: Enhance, Equip, Salvage (common rarity has no reforge tier → no Reforge).
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagCommon) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip', 'salvage']);
    actions.find((a) => a.key === 'equip')!.fn(); // Equip → bag mode → beginAssign('eqBagCommon', 'weapon')
    expect((scene as any).core.assign).toEqual({ instId: 'eqBagCommon', slot: 'weapon' });
    // render() dispatched to AssignPanel.renderAssign, which laid out one row per card (only card1).
    // renderSidebar() also always runs (even in assign mode) and only pushes a hit for the
    // INACTIVE sub-tab (drawSidebarTabs skips the active one) — so [back, Craft tab, card1 row].
    const hits = (scene as any).core.hitRects as Array<{ fn: () => void }>;
    expect(hits.length).toBe(3);
    hits[2].fn(); // → doEquipTo('card1') → doEquip('weapon', 'eqBagCommon', 'card1')
    await Promise.resolve();
    expect(calls.equip).toEqual([['weapon', 'eqBagCommon', 'card1']]);
    expect((scene as any).core.assign).toBeNull();
    scene.destroy();
  });

  it('reforge flow: instanceActions(Reforge) → ReforgePanel(openReforgeSelect) → core.showConfirm → ReforgePanel(doReforge) → cb.reforge', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const save = (scene as any).core.cb.getSave();
    // Unequipped fine item (eqBagCommon qualifies as its reforge material): Enhance, Equip, Reforge, Salvage.
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagFine) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip', 'reforge', 'salvage']);
    actions.find((a) => a.key === 'reforge')!.fn(); // Reforge → openReforgeSelect(eqBagFine)
    expect((scene as any).core.modalOpen).toBe(true);
    let modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    modalHits[0].fn(); // material row (eqBagCommon) → confirmReforge → showConfirm
    modalHits = (scene as any).core.modalHits;
    expect(modalHits.length).toBe(2); // showConfirm's [OK, Cancel]
    modalHits[0].fn(); // OK → doReforge
    await Promise.resolve();
    expect(calls.reforge).toEqual([['eqBagFine', 'eqBagCommon']]);
    scene.destroy();
  });

  it('regression (2026-08-03): reforge is omitted (not just greyed out) when coins are insufficient, and reappears once affordable', async () => {
    const { cb, save } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    // eqBagFine is 'fine' rarity → REFORGE_COIN_COST.fine === 80 (equipmentDefs.ts).
    save.wallet.coins = 79;
    let actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagFine) as Array<{ key: string }>;
    expect(actions.map((a) => a.key)).not.toContain('reforge');

    save.wallet.coins = 80;
    actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagFine) as Array<{ key: string }>;
    expect(actions.map((a) => a.key)).toContain('reforge');
    scene.destroy();
  });

  it('regression (2026-08-03): the reforge confirm dialog states the coin cost', async () => {
    const { cb, save } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagFine) as Array<{ key: string; fn: () => void }>;
    actions.find((a) => a.key === 'reforge')!.fn(); // → openReforgeSelect(eqBagFine)
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    modalHits[0].fn(); // material row (eqBagCommon) → confirmReforge → showConfirm
    const modalLayer = (scene as any).core.modalLayer as PIXI.Container;
    let sawCost = false;
    const walk = (c: PIXI.Container): void => {
      for (const ch of c.children) {
        if (ch instanceof PIXI.Text && ch.text.includes('80')) sawCost = true;
        if (ch instanceof PIXI.Container) walk(ch);
      }
    };
    walk(modalLayer);
    expect(sawCost).toBe(true); // REFORGE_COIN_COST.fine === 80, must appear in the confirm text
    scene.destroy();
  });

  it('salvage flow: instanceActions(Salvage) → core.showConfirm → DetailPanel(doSalvage) → cb.salvage', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const save = (scene as any).core.cb.getSave();
    // Unequipped common item, no reforge tier: Enhance, Equip, Salvage.
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagCommon) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip', 'salvage']);
    actions.find((a) => a.key === 'salvage')!.fn(); // Salvage → confirmSalvage → showConfirm
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    expect(modalHits.length).toBe(2); // showConfirm's [OK, Cancel]
    modalHits[0].fn(); // OK → doSalvage
    await Promise.resolve();
    expect(calls.salvage).toEqual([['eqBagCommon']]);
    scene.destroy();
  });

  it('salvage-all flow: a ×N stacked cell offers a batch "Salvage All" action alongside the single-item one', async () => {
    const { cb, calls, save } = buildEquipCallbacks('card1');
    // Duplicate eqBagCommon into a 3-item stack (same defId+rarity, +0, unequipped, unlocked).
    save.equipmentInv.eqBagCommon2 = { id: 'eqBagCommon2', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 10 }] };
    save.equipmentInv.eqBagCommon3 = { id: 'eqBagCommon3', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 10 }] };
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    // Action order: [Enhance, Equip, Salvage, Salvage All].
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagCommon) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip', 'salvage', 'salvageAll']);
    actions.find((a) => a.key === 'salvageAll')!.fn(); // Salvage All → confirmSalvageAll → showConfirm
    const modalHits = (scene as any).core.modalHits as Array<{ fn: () => void }>;
    expect(modalHits.length).toBe(2); // showConfirm's [OK, Cancel]
    modalHits[0].fn(); // OK → doSalvageAll
    await Promise.resolve();
    expect(calls.salvage).toEqual([['eqBagCommon', 'eqBagCommon2', 'eqBagCommon3']]);
    scene.destroy();
  });

  it('epic-rarity items never offer Salvage/Salvage All, even at +0 (ADR-050)', async () => {
    const { cb, save } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagEpic) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip']);
    scene.destroy();
  });

  it('a stack of duplicate epic items still offers no Salvage All (stacking alone must not bypass the rarity gate)', async () => {
    const { cb, save } = buildEquipCallbacks('card1');
    save.equipmentInv.eqBagEpic2 = { id: 'eqBagEpic2', defId: 'wp_highlighter', rarity: 'epic', level: 0, affixes: [{ id: 'm_atk', value: 40 }] };
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const actions = (scene as any).detail.instanceActions(save, save.equipmentInv.eqBagEpic) as Array<{ key: string; fn: () => void }>;
    expect(actions.map((a) => a.key)).toEqual(['enhance', 'equip']);
    scene.destroy();
  });

  // initialFilterSlot (CardScene gear-slot tap → jump straight to that slot's filter tab, instead
  // of landing on "All"). The seeding happens in EquipmentSceneBase's constructor: verify the
  // default, that each slot value round-trips, and that render() honors the seeded filter without
  // throwing (the full build+render already ran in the constructor).
  it('initialFilterSlot: defaults to "all" when absent, and seeds filterSlot when provided', () => {
    const { cb: defCb } = buildEquipCallbacks('card1');
    const defScene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), defCb);
    expect((defScene as any).core.filterSlot).toBe('all');
    defScene.destroy();

    for (const slot of ['weapon', 'armor', 'trinket'] as const) {
      const { cb } = buildEquipCallbacks('card1');
      const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), { ...cb, initialFilterSlot: slot });
      expect((scene as any).core.filterSlot).toBe(slot);
      // Re-render with the seeded filter live — proves it reaches renderInventory's filter path
      // (the all-weapon fixture under an armor filter exercises the empty branch) without throwing.
      expect(() => (scene as any).render()).not.toThrow();
      scene.destroy();
    }
  });
});

// ── ResultScene: top-left back chip ─────────────────────────────────────────
// Regression for "Fight Again has no explicit way back to the lobby" (05.07.2026
// UI pass): a permanent back chip was added at the top-left corner (shared
// drawFloatingBackButton visuals, see src/ui/widgets/SceneHeader.ts), independent
// of the primary "play again" CTA below it — which, since the PvE fix, may
// re-enter a match instead of returning to the lobby (see also
// test/game-nav-fight-again.test.ts / test/result-nav-onback.test.ts for the
// nav-layer half of this contract).
describe('ResultScene — top-left back chip', () => {
  function findBackChipHit(scene: Scene): PIXI.DisplayObject {
    const hit = scene.container.getChildByName('resultBackChip');
    if (!hit) throw new Error('back-chip hit-area not found among ResultScene children');
    return hit;
  }

  it('tapping the back chip calls cb.onBack(), independent of onPlayAgain', () => {
    let backCalls = 0;
    let playAgainCalls = 0;
    const scene = new ResultScene(
      PORTRAIT[0], PORTRAIT[1], 0,
      [zeroStats(0), zeroStats(1)],
      { onPlayAgain() { playAgainCalls++; }, onBack() { backCalls++; } },
    );

    (findBackChipHit(scene).emit as (event: string) => void)('pointertap');

    expect(backCalls).toBe(1);
    expect(playAgainCalls).toBe(0);
    scene.destroy();
  });

  it('renders the back chip on every result (win, loss, and draw)', () => {
    for (const winner of [0, 1, null] as const) {
      let backCalls = 0;
      const scene = new ResultScene(
        PORTRAIT[0], PORTRAIT[1], winner,
        [zeroStats(0), zeroStats(1)],
        { onPlayAgain() {}, onBack() { backCalls++; } },
      );
      (findBackChipHit(scene).emit as (event: string) => void)('pointertap');
      expect(backCalls).toBe(1);
      scene.destroy();
    }
  });
});

// ── ResultScene: outro tap-through must leave the result interactive ───────────
// Regression for the 2026-07-25 "victory screen buttons dead after a campaign
// level with a story outro" bug: buildOutroOverlay's tap-to-continue handler set
// `this.container.eventMode = 'none'` after the tap, before build() populated the
// SAME container with the real badges/buttons. PIXI's EventBoundary prunes hit
// testing for an entire subtree once an ancestor is eventMode:'none' (see
// @pixi/events EventBoundary._interactivePrune) — a bare `.emit('pointertap')` on
// the found node would pass even with the bug present (it bypasses hit-testing
// entirely, see ui-test-must-drive-real-hit-test memory), so this test drives a
// real `PIXI.EventBoundary(scene.container).hitTest(x,y)` instead, exactly like a
// live pointer event would.
describe('ResultScene — outro tap-through leaves buttons clickable', () => {
  function centerOf(node: PIXI.DisplayObject): { x: number; y: number } {
    const b = node.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }

  function emitTap(node: PIXI.DisplayObject, event: string): void {
    (node.emit as (event: string) => void)(event);
  }

  it('a real hit-test finds the primary CTA and back chip after the tap, and taps fire callbacks', () => {
    let playAgainCalls = 0;
    let backCalls = 0;
    const scene = new ResultScene(
      PORTRAIT[0], PORTRAIT[1], 0,
      [zeroStats(0), zeroStats(1)],
      { onPlayAgain() { playAgainCalls++; }, onBack() { backCalls++; } },
      0, undefined, undefined,
      ['Some outro story text.'], // outroTexts — arms the tap-through overlay path
    );

    // Before the tap: the outro overlay owns the screen, so the CTA doesn't exist yet.
    expect(scene.container.getChildByName('resultPrimaryCta')).toBeNull();

    // Simulate the tap-through (matches how buildOutroOverlay's own listener is wired:
    // a single full-screen `once('pointerdown')` on the container).
    emitTap(scene.container, 'pointerdown');

    const boundary = new PIXI.EventBoundary(scene.container);

    const cta = scene.container.getChildByName('resultPrimaryCta');
    if (!cta) throw new Error('primary CTA not found after outro tap-through');
    const ctaCenter = centerOf(cta);
    const ctaHit = boundary.hitTest(ctaCenter.x, ctaCenter.y);
    expect(ctaHit).not.toBeNull();
    emitTap(ctaHit as PIXI.DisplayObject, 'pointertap');
    expect(playAgainCalls).toBe(1);

    const backChip = scene.container.getChildByName('resultBackChip');
    if (!backChip) throw new Error('back chip not found after outro tap-through');
    const backCenter = centerOf(backChip);
    const backHit = boundary.hitTest(backCenter.x, backCenter.y);
    expect(backHit).not.toBeNull();
    emitTap(backHit as PIXI.DisplayObject, 'pointertap');
    expect(backCalls).toBe(1);

    scene.destroy();
  });

  it('leaves container.eventMode able to hit descendants (not "none") after the tap', () => {
    const scene = new ResultScene(
      PORTRAIT[0], PORTRAIT[1], 0,
      [zeroStats(0), zeroStats(1)],
      { onPlayAgain() {}, onBack() {} },
      0, undefined, undefined,
      ['Some outro story text.'],
    );
    emitTap(scene.container, 'pointerdown');
    // 'none' prunes the whole subtree (the exact bug); 'passive' (the container
    // default) and 'static'/'auto'/'dynamic' all still allow descendants to be hit.
    expect(scene.container.eventMode).not.toBe('none');
    scene.destroy();
  });
});
