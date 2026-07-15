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
import { marginLineX } from '../../src/render/sketchUi';
import { CardCodexScene } from '../../src/scenes/CardCodexScene';
import { StatsScene } from '../../src/scenes/StatsScene';
import { RoomScene, CODE_ALPHABET } from '../../src/scenes/RoomScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import { ResultScene } from '../../src/scenes/ResultScene';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
import { AuctionScene } from '../../src/scenes/AuctionScene';
import { EquipmentScene } from '../../src/scenes/EquipmentScene';
import type { EquipmentCallbacks, EquipResult } from '../../src/scenes/EquipmentScene';
import type { PlayerStats } from '../../src/game/types';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import { makeNewSave, type SaveData, type EquipSlot } from '../../src/game/meta/SaveData';

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
 * Equipment fixture (EQUIPMENT_DESIGN §11): one card ('card1', lichuang) wearing a fine weapon
 * (eqEquippedFine), plus two unequipped bag items — a common weapon (eqBagCommon, doubles as the
 * common-rarity reforge material) and a fine weapon (eqBagFine, the reforge target used below).
 * Materials/coins are set high so afford checks never gate the tests.
 */
function buildEquipSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 999, lead: 999, binding: 999 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, xp: 0, gear: { weapon: 'eqEquippedFine' }, locked: false },
  };
  save.equipmentInv = {
    eqEquippedFine: { id: 'eqEquippedFine', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }] },
    eqBagCommon: { id: 'eqBagCommon', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [{ id: 'm_atk', value: 10 }] },
    eqBagFine: { id: 'eqBagFine', defId: 'wp_pen', rarity: 'fine', level: 0, affixes: [{ id: 'm_atk', value: 20 }] },
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

/**
 * Build → update twice → destroy. Asserts the container is real, nothing throws, and —
 * crucially — that destroy() actually tears the display tree down.
 *
 * Regression guard for the recurring "UI-switch freeze": scenes that only unsubscribed
 * input in destroy() left every child (boiling-line titles, building/unit fx) alive with
 * its `PIXI.Ticker.shared` closure still running, which accumulated across navigations and
 * eventually stalled the app. A destroyed container has removed + destroyed all children,
 * so `.destroyed === true` is the invariant every scene must uphold.
 */
function exercise(scene: Scene): void {
  expect(scene.container).toBeInstanceOf(PIXI.Container);
  scene.update(1 / 30);
  scene.update(1 / 30);
  scene.destroy();
  expect(scene.container.destroyed).toBe(true);
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
        onRename: async (name: string) => ({ ok: true, name }),
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
        getFatePoints: () => 0,
        loadPools: async () => [],
        draw: async () => ({ ok: true, results: [] }),
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
        onOpenTeams() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        playerName: 'Tester',
        accountId: 'acc_test',
      }),
  },
  {
    name: 'FamilyScene',
    build: (w, h) =>
      new FamilyScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        onOpenSect() {},
        onNavTab() {},
        worldApi: stubWorldApi(),
        worldId: 'world:1:0',
        myAccountId: 'acc_test',
        playerName: 'Tester',
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
      }),
  },
  {
    name: 'AuctionScene',
    build: (w, h) =>
      new AuctionScene(createLayout(w, h), new InputManager(), {
        onBack() {},
        worldApi: stubWorldApi(),
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
    const headerHits = (scene as any).hits.filter((hh: any) => hh.rect.y === 0);
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
    const headerHits = (scene as any).hits.filter((hh: any) => hh.rect.y === 0);
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
    const layer = (scene as any).worldOfflineBadgeLayer as PIXI.Container;
    expect(layer).toBeInstanceOf(PIXI.Container);
    expect(layer.children).toHaveLength(0);
    scene.destroy();
  });

  it('applyWorldAvailable(false) draws the offline badge', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(false);
    const layer = (scene as any).worldOfflineBadgeLayer as PIXI.Container;
    expect(layer.children.length).toBeGreaterThan(0);
    scene.destroy();
  });

  it('applyWorldAvailable(true) keeps the badge layer empty', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(true);
    const layer = (scene as any).worldOfflineBadgeLayer as PIXI.Container;
    expect(layer.children).toHaveLength(0);
    scene.destroy();
  });

  it('badge is cleared after switching false → true', () => {
    const scene = buildLobby();
    scene.applyWorldAvailable(false);
    expect((scene as any).worldOfflineBadgeLayer.children.length).toBeGreaterThan(0);
    scene.applyWorldAvailable(true);
    expect((scene as any).worldOfflineBadgeLayer.children).toHaveLength(0);
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

      const worldRect    = (scene as any).worldPillarRect  as { x: number; y: number; w: number; h: number };
      const btnRect      = (scene as any).btnRect         as { x: number; y: number; w: number; h: number };
      const campaignRect = (scene as any).campaignBtnRect as { x: number; y: number; w: number; h: number };
      const dailyRect    = (scene as any).dailyBtnRect    as { x: number; y: number; w: number; h: number };

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

      const r = (scene as any).worldPillarRect as { x: number; y: number; w: number; h: number };
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(layout.designHeight);

      scene.destroy();
    });
  }
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
function buildRoomCodeEntry(w: number, h: number) {
  const layout = createLayout(w, h);
  const scene = new RoomScene(layout, new InputManager(), {
    onBack() {}, createRoom() {}, joinRoom() {}, setReady() {},
    startMatch() {}, createRanked() {}, cancelQueue() {}, available: true,
  });
  (scene as any).onJoinPressed(); // → 'codeEntry' view, re-renders the keypad
  return { scene, layout };
}

describe('RoomScene — code-entry keypad', () => {
  it('charset is 10 digits + 11 letters (skips I/O/L), 21 chars = 3 rows', () => {
    // Must match server matchsvc CODE_ALPHABET — its test asserts the same literal.
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKM');
    expect(CODE_ALPHABET).toHaveLength(21);
    expect(CODE_ALPHABET).not.toMatch(/[IOL]/);
  });

  for (const [label, [w, h]] of [
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ] as const) {
    it(`all keys + actions stay within bounds — ${label}`, () => {
      const { scene, layout } = buildRoomCodeEntry(w, h);
      const dw = layout.designWidth, dh = layout.designHeight;
      const hits = (scene as any).hits as Array<{ rect: { x: number; y: number; w: number; h: number } }>;
      // back + 21 keypad chars + clear/⌫/confirm = 25 tappable areas, all on-screen.
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
});

// ── EquipmentScene: mixin-split wiring ───────────────────────────────────────
// EquipmentScene.ts (client-modules split, see claudedocs) is assembled from 5 domain
// mixins over EquipmentSceneBase: Inventory → Craft → Detail → Assign → Reforge. The
// cross-mixin call points below (base.render() dispatching into each domain; the detail
// modal invoking Assign's beginAssign / Reforge's openReforgeSelect; Assign's card picker
// calling back into Detail's doEquip) type-check purely because base.ts declares their
// signatures via interface merging — a wrong mixin order, a missing mixin in the
// EquipmentScene.ts chain, or a typo'd method name would still compile but throw or
// silently no-op at runtime. These tests drive the real render dispatch + hit rects to
// prove the wiring actually resolves to working methods, not just satisfies the compiler.
describe('EquipmentScene — mixin-split wiring', () => {
  it('craft tab: base.render() dispatches to CraftMixin.renderCraft, and the Craft button calls cb.craft', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).activeTab = 'craft';
    (scene as any).render();
    // renderCraft must have populated hitRects with a Craft button for every affordable def.
    const hits = (scene as any).hitRects as Array<{ action: () => void }>;
    expect(hits.length).toBeGreaterThan(1);
    await (scene as any).doCraft('wp_pencil');
    expect(calls.craft).toEqual(['wp_pencil']);
    scene.destroy();
  });

  it('detail modal (active-card mode): the Unequip button wired by DetailMixin.openDetail calls cb.equip', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).openDetail('eqEquippedFine');
    expect((scene as any).modalOpen).toBe(true);
    const modalHits = (scene as any).modalHits as Array<{ action: () => void }>;
    // Button order for this fixture (fine, level 0, equipped, no reforge material since
    // it's equipped, not salvageable since equipped): [Enhance, Unequip, panel-inert, outside-close].
    expect(modalHits.length).toBe(4);
    modalHits[1].action();
    await Promise.resolve();
    expect(calls.equip).toEqual([['weapon', null, 'card1']]);
    expect(calls.enhance).toEqual([]); // sanity: we hit Unequip, not Enhance
    scene.destroy();
  });

  it('bag mode: Detail → Assign(beginAssign) → base.render(renderAssign) → Assign(doEquipTo) → Detail(doEquip) → cb.equip', async () => {
    const { cb, calls } = buildEquipCallbacks(''); // '' activeCardInstanceId = bag mode
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).openDetail('eqBagCommon'); // unequipped common item
    // Button order: [Enhance, Equip, Salvage, panel-inert, outside-close] (common rarity has no
    // reforge material tier, so no Reforge button).
    const modalHits = (scene as any).modalHits as Array<{ action: () => void }>;
    expect(modalHits.length).toBe(5);
    modalHits[1].action(); // Equip → bag mode → beginAssign('eqBagCommon', 'weapon')
    expect((scene as any).assign).toEqual({ instId: 'eqBagCommon', slot: 'weapon' });
    expect((scene as any).modalOpen).toBe(false); // beginAssign closes the detail modal
    // render() dispatched to AssignMixin.renderAssign, which laid out one row per card (only card1).
    // renderSidebar() also always runs (even in assign mode) and only pushes a hit for the
    // INACTIVE sub-tab (drawSidebarTabs skips the active one) — so [back, Craft tab, card1 row].
    const hits = (scene as any).hitRects as Array<{ action: () => void }>;
    expect(hits.length).toBe(3);
    hits[2].action(); // → doEquipTo('card1') → doEquip('weapon', 'eqBagCommon', 'card1')
    await Promise.resolve();
    expect(calls.equip).toEqual([['weapon', 'eqBagCommon', 'card1']]);
    expect((scene as any).assign).toBeNull();
    scene.destroy();
  });

  it('reforge flow: Detail → Reforge(openReforgeSelect) → base.showConfirm → Reforge(doReforge) → cb.reforge', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).openDetail('eqBagFine'); // unequipped fine item; eqBagCommon qualifies as its reforge material
    // Button order: [Enhance, Equip, Reforge, Salvage, panel-inert, outside-close].
    let modalHits = (scene as any).modalHits as Array<{ action: () => void }>;
    expect(modalHits.length).toBe(6);
    modalHits[2].action(); // Reforge → openReforgeSelect(eqBagFine)
    expect((scene as any).modalOpen).toBe(true);
    modalHits = (scene as any).modalHits;
    modalHits[0].action(); // material row (eqBagCommon) → confirmReforge → showConfirm
    modalHits = (scene as any).modalHits;
    expect(modalHits.length).toBe(2); // showConfirm's [OK, Cancel]
    modalHits[0].action(); // OK → doReforge
    await Promise.resolve();
    expect(calls.reforge).toEqual([['eqBagFine', 'eqBagCommon']]);
    scene.destroy();
  });

  it('salvage flow: Detail → base.showConfirm → Detail(doSalvage) → cb.salvage', async () => {
    const { cb, calls } = buildEquipCallbacks('card1');
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    (scene as any).openDetail('eqBagCommon'); // unequipped common item, no reforge tier
    // Button order: [Enhance, Equip, Salvage, panel-inert, outside-close].
    let modalHits = (scene as any).modalHits as Array<{ action: () => void }>;
    expect(modalHits.length).toBe(5);
    modalHits[2].action(); // Salvage → confirmSalvage → showConfirm
    modalHits = (scene as any).modalHits;
    expect(modalHits.length).toBe(2); // showConfirm's [OK, Cancel]
    modalHits[0].action(); // OK → doSalvage
    await Promise.resolve();
    expect(calls.salvage).toEqual([['eqBagCommon']]);
    scene.destroy();
  });

  // initialFilterSlot (CardScene gear-slot tap → jump straight to that slot's filter tab, instead
  // of landing on "All"). The seeding happens in EquipmentSceneBase's constructor: verify the
  // default, that each slot value round-trips, and that render() honors the seeded filter without
  // throwing (the full build+render already ran in the constructor).
  it('initialFilterSlot: defaults to "all" when absent, and seeds filterSlot when provided', () => {
    const { cb: defCb } = buildEquipCallbacks('card1');
    const defScene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), defCb);
    expect((defScene as any).filterSlot).toBe('all');
    defScene.destroy();

    for (const slot of ['weapon', 'armor', 'trinket'] as const) {
      const { cb } = buildEquipCallbacks('card1');
      const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), { ...cb, initialFilterSlot: slot });
      expect((scene as any).filterSlot).toBe(slot);
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
