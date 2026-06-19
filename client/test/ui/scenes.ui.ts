// Scene startup smoke tests — does each scene construct, update and destroy without
// throwing, in both portrait and landscape layouts? The headless PIXI adapter
// (test/harness/pixiHeadless.ts, wired via vitest.ui.config.ts setupFiles) lets the
// real scene code build its PIXI tree and measure text in plain Node.
//
// Scope: menu / overlay scenes (the bulk of the UI). The two gameplay scenes
// (GameScene / ReplayScene) drive the full GameRenderer and are intentionally left
// out of this first pass — they belong to a heavier render smoke once the UI
// stabilises (post-launch, per the agreed plan).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { Scene } from '../../src/scenes/SceneManager';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

import { IntroScene } from '../../src/scenes/IntroScene';
import { LoginScene } from '../../src/scenes/LoginScene';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { SettingsScene } from '../../src/scenes/SettingsScene';
import { ShopScene } from '../../src/scenes/ShopScene';
import { GachaScene } from '../../src/scenes/GachaScene';
import { CampaignMapScene } from '../../src/scenes/CampaignMapScene';
import { LevelPrepScene } from '../../src/scenes/LevelPrepScene';
import { CollectionScene } from '../../src/scenes/CollectionScene';
import { StatsScene } from '../../src/scenes/StatsScene';
import { RoomScene } from '../../src/scenes/RoomScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import { ResultScene } from '../../src/scenes/ResultScene';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import type { PlayerStats } from '../../src/game/types';
import type { WorldApiClient } from '../../src/net/WorldApiClient';

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
  buildingSurvivalTicks: 0,
  goldSpent: 0,
});

/** Minimal WorldApiClient stub — all methods return never-resolving promises so the
 *  scene's async loadData() just hangs silently (all API calls are try/caught). */
function stubWorldApi(): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getTile: never, getMarches: never,
    joinWorld: never, occupyTile: never, abandonTile: never,
    startMarch: never, recallMarch: never,
    listFamilies: never, getFamily: never, createFamily: never,
    joinFamily: never, leaveFamily: never, kickMember: never,
    setRole: never, dissolveFamily: never,
    sendFamilyMessage: never, getFamilyChannel: never,
    listAuctions: never, getMyListings: never,
    createAuction: never, buyAuction: never, cancelAuction: never,
  } as unknown as WorldApiClient;
}

/** Build → update twice → destroy. Asserts the container is real and nothing throws. */
function exercise(scene: Scene): void {
  expect(scene.container).toBeInstanceOf(PIXI.Container);
  scene.update(1 / 30);
  scene.update(1 / 30);
  scene.destroy();
}

// Each entry builds one scene for a given (w, h). Kept as factories so we can run the
// whole set against both orientations.
const SCENES: Array<{ name: string; build: (w: number, h: number) => Scene }> = [
  {
    name: 'IntroScene',
    build: (w, h) => new IntroScene(createLayout(w, h), new InputManager(), { onFinish() {} }),
  },
  {
    name: 'LoginScene',
    build: (w, h) =>
      new LoginScene(createLayout(w, h), new InputManager(), {
        onLogin: async () => ({ ok: true }),
        onRegister: async () => ({ ok: true }),
        onPlayOffline() {},
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
        onRename: async () => ({ ok: true }),
        onLogin() {},
        onLogout() {},
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
      }),
  },
  {
    name: 'GachaScene',
    build: (w, h) =>
      new GachaScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getCoins: () => 1000,
        getPity: () => 0,
        loadPools: async () => [],
        draw: async () => ({ ok: true, results: [] }),
      }),
  },
  {
    name: 'CampaignMapScene',
    build: (w, h) =>
      new CampaignMapScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onSelectLevel() {},
        onOpenCollection() {},
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
        getMaterials: () => ({}),
        getUpgradeLevel: () => 0,
        isOnline: () => true,
        tryUpgrade: async () => false,
        levelNumber: 1,
      }),
  },
  {
    name: 'CollectionScene',
    build: (w, h) =>
      new CollectionScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        getSkins: () => [],
        getEquipped: () => null,
        equip() {},
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
        loadFriends: async () => [],
        loadRequests: async () => ({ incoming: [], outgoing: [] }),
        search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
        addFriend: async () => {},
        respond: async () => {},
        removeFriend: async () => {},
        blockUser: async () => {},
        loadConversations: async () => [],
        openChat() {},
        loadMail: async () => ({ mail: [], unread: 0 }),
        markMailRead: async () => {},
        claimMail: async () => true,
        deleteMail: async () => {},
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
        { onPlayAgain() {}, onWatchReplay() {} },
        0,
        { delta: 16, after: 1016, rankAfter: 'bronze' },
      ),
  },
  {
    name: 'WorldMapScene',
    build: (w, h) =>
      new WorldMapScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onOpenFamily() {},
        onOpenAuction() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        playerName: 'Tester',
      }),
  },
  {
    name: 'FamilyScene',
    build: (w, h) =>
      new FamilyScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        myAccountId: 'acc_test',
      }),
  },
  {
    name: 'AuctionScene',
    build: (w, h) =>
      new AuctionScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
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
        exercise(s.build(w, h));
      });
    }
  });
}
