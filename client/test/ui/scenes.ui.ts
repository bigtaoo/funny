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
import { RoomScene, CODE_ALPHABET } from '../../src/scenes/RoomScene';
import { FriendsScene } from '../../src/scenes/FriendsScene';
import { ChatScene } from '../../src/scenes/ChatScene';
import { ResultScene } from '../../src/scenes/ResultScene';
import { WorldMapScene } from '../../src/scenes/WorldMapScene';
import { FamilyScene } from '../../src/scenes/FamilyScene';
import { SectScene } from '../../src/scenes/SectScene';
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
        levelNumber: 1,
        staminaCost: 1,
        getStamina: () => ({ current: 120, regenAt: 0 }),
        onBuyStamina() {},
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
      onOpenCollection() {},
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
    // hits[0] = back button, hits[1] = collection button (both in header).
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
      onOpenCollection() {},
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

  it('back-to-lobby works without any frame advance (ticker-stall resilience)', () => {
    // The header "back" on the chapter page flips to the TOC, whose back calls
    // onBack(). Both steps must work with zero update() calls — proving neither the
    // level select nor the path back to the lobby depends on the flip settling.
    let backHits = 0;
    const input = new InputManager();
    const scene = new CampaignMapScene(layout, input, {
      onBack() { backHits++; },
      onSelectLevel() {},
      onOpenCollection() {},
      getStars: () => ({}),
      getCleared: () => [],
      isOnline: () => true,
      getPendingLevels: () => [],
    });
    const headerBack = () => (scene as any).hits.find((hh: any) => hh.rect.x === 0 && hh.rect.y === 0);
    // 1) chapter page → tap back → flips toward TOC (no frame advance).
    let b = headerBack(); expect(b).toBeDefined();
    input._emitDown(b.rect.x + 2, b.rect.y + 2);
    // The flip toward the TOC is now genuinely in progress (we never advanced it)…
    expect((scene as any).flip).not.toBeNull();
    // …yet hits must stay live (this.hits = incoming page's hits) so the TOC's back
    // still calls onBack() — proving taps work MID-FLIP, not just after it settles.
    b = headerBack(); expect(b).toBeDefined();
    input._emitDown(b.rect.x + 2, b.rect.y + 2);
    expect(backHits).toBe(1);
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
      onOpenCollection() {},
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
