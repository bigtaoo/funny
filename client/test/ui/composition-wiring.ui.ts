/**
 * composition-wiring.test.ts — regression coverage for the 2026-08-11 client-side mixin-chain →
 * composition conversion (see claudedocs/client-modules.md's split-form priority note). Converting
 * each `XMixin(Base)` inheritance chain into composition means every domain class now reaches its
 * shared state through an INJECTED `core` reference (`this.core.xxx`) instead of inherited
 * `this.xxx`. That's exactly the kind of change existing behavioral tests don't specifically pin —
 * a scene would still render and mostly behave correctly if its assembly constructor accidentally
 * built two independent `XxxCore` instances instead of sharing one; the symptom (state written
 * through one instance never visible through the other) only shows up as scattered, hard-to-place
 * bugs later. Mirrors server/auctionsvc/test/composition-wiring.test.ts's pattern: for every
 * converted assembly, assert every sibling domain class holds the EXACT SAME `core` (and, where one
 * domain depends on another, the exact same sibling) instance the facade itself holds — an identity
 * check, not a behavioral one, so it fails immediately and unambiguously if a future edit passes
 * `new XxxCore(...)` at two different call sites instead of reusing the one field.
 *
 * No PIXI renderer, no network — every fixture is the smallest constructor call that satisfies each
 * scene's required callbacks (same fixtures already used by test/ui/scenes.ui.ts and friends).
 */
import { describe, expect, it, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import type { WorldApiClient, TeamTemplate } from '../../src/net/WorldApiClient';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function stubWorldApi(overrides: Record<string, unknown> = {}): WorldApiClient {
  const never = () => new Promise<never>(() => {});
  return {
    getMe: never, getMap: never, getMapSparse: never, getTile: never, getTeams: never,
    getMarches: never, getOccupations: never, getStationed: never,
    ...overrides,
  } as unknown as WorldApiClient;
}

// ── net/ApiClient — 9 domain services over one ApiClientCore ─────────────────────

describe('ApiClient composition wiring', () => {
  it('shares exactly one ApiClientCore across every one of its 9 domain services', async () => {
    const { ApiClient } = await import('../../src/net/ApiClient');
    const client = new ApiClient('http://localhost') as unknown as Record<string, unknown>;
    const core = client.core;
    expect(core).toBeDefined();
    for (const svc of ['authSvc', 'pveSvc', 'equipmentSvc', 'shopSvc', 'gachaSvc', 'socialSvc', 'mailSvc', 'achievementsSvc', 'miscSvc']) {
      expect((client[svc] as Record<string, unknown>).core).toBe(core);
    }
  });
});

// ── net/WorldApiClient — 10 domain services over one WorldApiCore ────────────────

describe('WorldApiClient composition wiring', () => {
  it('shares exactly one WorldApiCore across every one of its 10 domain services', async () => {
    const { WorldApiClient } = await import('../../src/net/WorldApiClient');
    const client = new WorldApiClient(memStore) as unknown as Record<string, unknown>;
    const core = client.core;
    expect(core).toBeDefined();
    for (const svc of ['world', 'defenseTeams', 'siege', 'nationsSeason', 'slgShop', 'family', 'auction', 'sect', 'worldChannel', 'cityOps']) {
      expect((client[svc] as Record<string, unknown>).core).toBe(core);
    }
  });
});

// ── WorldMapPanels — 4 panels over one WorldMapPanelsCore ────────────────────────

describe('WorldMapPanels composition wiring', () => {
  it('shares exactly one WorldMapPanelsCore across hud/shop/territory/replay', async () => {
    const { WorldMapContext } = await import('../../src/scenes/worldmap/WorldMapContext');
    const { WorldMapPanels } = await import('../../src/scenes/worldmap/WorldMapPanels');
    const layout = { designWidth: 1280, designHeight: 800 } as unknown as ConstructorParameters<typeof WorldMapContext>[0];
    const cb = {
      onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
      onOpenDefense() {}, worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'tester',
      accountId: 'acc_test', storage: memStore,
    } as unknown as ConstructorParameters<typeof WorldMapContext>[1];
    const ctx = new WorldMapContext(layout, cb);
    const panels = new WorldMapPanels(ctx) as unknown as Record<string, unknown>;
    const core = panels.core;
    expect(core).toBeDefined();
    for (const p of ['hud', 'shop', 'territory', 'replay']) {
      expect((panels[p] as Record<string, unknown>).core).toBe(core);
    }
  });
});

// ── WorldMapRenderer — build/viewport/pool/city/fog/vignette/lifecycle over one Core ─────────

describe('WorldMapRenderer composition wiring', () => {
  it('shares exactly one WorldMapRendererCore across all 7 domain classes, with city→pool and the build/viewport/lifecycle→refreshMap bundle reaching the SAME instances', async () => {
    const { WorldMapContext } = await import('../../src/scenes/worldmap/WorldMapContext');
    const { WorldMapRenderer } = await import('../../src/scenes/worldmap/WorldMapRenderer');
    const layout = { designWidth: 1280, designHeight: 800 } as unknown as ConstructorParameters<typeof WorldMapContext>[0];
    const cb = {
      onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
      onOpenDefense() {}, worldApi: stubWorldApi(), worldId: 'world:1:0', playerName: 'tester',
      accountId: 'acc_test', storage: memStore,
    } as unknown as ConstructorParameters<typeof WorldMapContext>[1];
    const ctx = new WorldMapContext(layout, cb);
    const view = new WorldMapRenderer(ctx) as unknown as Record<string, unknown>;
    const core = view.core;
    expect(core).toBeDefined();
    for (const p of ['pool', 'city', 'fog', 'vignette', 'buildPanel', 'viewport', 'lifecycle']) {
      expect((view[p] as Record<string, unknown>).core).toBe(core);
    }
    // The chain's two genuine bidirectional pairs (both hubbed on the old pool.ts — pool↔city over
    // refreshCityLayer()/isBaseAnchor(), pool↔fog over renderOverlay()/invalidatePool(), see
    // WorldMapRenderer.ts's file-header comment) were resolved by hoisting the "refresh everything"
    // trigger to this assembly rather than adding lazy hooks: pool no longer references city or fog
    // at all. city.ts's one-directional dependency on pool (isBaseAnchor) is the only surviving
    // cross-domain reference among pool/city/fog — must be the SAME pool instance the facade holds.
    expect((view.city as Record<string, unknown>).pool).toBe(view.pool);
    // build.ts/viewport.ts/lifecycle.ts each need the pool+city+fog "refresh everything" bundle
    // mid-method (build()/setZoom()/bootstrap()) — injected as a `refreshMap` closure over the
    // assembly itself (safe: like every sibling here, those methods only ever run after `new
    // WorldMapRenderer(ctx)` has fully returned). build.ts/viewport.ts also need pool directly
    // (buildPool()); lifecycle.ts needs fog/vignette directly (its per-frame update() calls
    // fog.renderMapL3()/renderOverlay() and vignette.updateVignette() without the full bundle).
    expect((view.buildPanel as Record<string, unknown>).pool).toBe(view.pool);
    expect((view.viewport as Record<string, unknown>).pool).toBe(view.pool);
    expect((view.lifecycle as Record<string, unknown>).fog).toBe(view.fog);
    expect((view.lifecycle as Record<string, unknown>).vignette).toBe(view.vignette);
    expect((view.lifecycle as Record<string, unknown>).build).toBe(view.buildPanel);
  });
});

// ── GachaScene — page/odds/reveal over one GachaSceneCore ────────────────────────

describe('GachaScene composition wiring', () => {
  it('shares exactly one GachaSceneCore across page/odds/reveal, and reveal reaches odds via entryPictures', async () => {
    const { GachaScene } = await import('../../src/scenes/GachaScene');
    const scene = new GachaScene(createLayout(800, 1280), new InputManager(), {
      onBack() {},
      getCoins: () => 1000,
      getPity: () => 0,
      getFatePoints: () => 0,
      loadPools: async () => [],
      draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
      redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    expect((scene.page as Record<string, unknown>).core).toBe(core);
    expect((scene.odds as Record<string, unknown>).core).toBe(core);
    expect((scene.reveal as Record<string, unknown>).core).toBe(core);
    // reveal.ts's drawEntryPicture calls take a narrow `entryPictures` interface, not the whole
    // OddsPanel — but it must still be the SAME odds instance the facade holds.
    expect((scene.reveal as Record<string, unknown>).entryPictures).toBe(scene.odds);
    (scene.destroy as () => void)();
  });
});

// ── CityScene — renderPanel/modals over one CitySceneCore ────────────────────────

describe('CityScene composition wiring', () => {
  it('shares exactly one CitySceneCore across renderPanel/modals', async () => {
    const { CityScene } = await import('../../src/scenes/CityScene');
    const scene = new CityScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, worldApi: stubWorldApi(), worldId: 'world:1:0',
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    expect((scene.renderPanel as Record<string, unknown>).core).toBe(core);
    expect((scene.modals as Record<string, unknown>).core).toBe(core);
    (scene.destroy as () => void)();
  });
});

// ── DefenseEditorScene — data/renderPanel/input over one DefenseEditorSceneCore ──

describe('DefenseEditorScene composition wiring', () => {
  it('shares exactly one DefenseEditorSceneCore across data/renderPanel/input, and renderPanel reaches data via saveActions', async () => {
    const { DefenseEditorScene } = await import('../../src/scenes/DefenseEditorScene');
    const getTeams = vi.fn().mockResolvedValue([{ id: 't1', name: 'Team 1', army: [] } as TeamTemplate]);
    const getMe = vi.fn().mockResolvedValue({ cardState: {} });
    const worldApi = stubWorldApi({ getTeams, getMe });
    const scene = new DefenseEditorScene(createLayout(800, 1280), new InputManager(), {
      onBack: vi.fn(),
      worldApi,
      worldId: 'world:1:0',
      target: { mode: 'attack', teamId: 't1', teamName: 'Team 1' },
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    expect((scene.data as Record<string, unknown>).core).toBe(core);
    expect((scene.renderPanel as Record<string, unknown>).core).toBe(core);
    expect((scene.input as Record<string, unknown>).core).toBe(core);
    // renderPanel's `saveActions` narrow interface must be the SAME data instance, not a copy.
    expect((scene.renderPanel as Record<string, unknown>).saveActions).toBe(scene.data);
    // Core's 4 InputManager subscriptions (onDown/onMove/onUp routed via lazy handler closures,
    // onWheel inline) must have actually registered — see core.ts's file-header comment on why
    // these can't wire themselves at Core-construction time.
    expect((core as Record<string, unknown[]>).unsubs.length).toBe(4);
    (scene.destroy as () => void)();
  });
});

// ── ShopScene — actions/shop/coins over one ShopSceneCore ────────────────────────

describe('ShopScene composition wiring', () => {
  it('shares exactly one ShopSceneCore across actions/shop/coins, and shop/coins reach the SAME actions instance', async () => {
    const { ShopScene } = await import('../../src/scenes/ShopScene');
    const scene = new ShopScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, getCoins: () => 1000, getOwnedSkins: () => [],
      loadItems: async () => [], buy: async () => ({ ok: true }), openGacha() {},
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    expect((scene.actions as Record<string, unknown>).core).toBe(core);
    expect((scene.shop as Record<string, unknown>).core).toBe(core);
    expect((scene.coins as Record<string, unknown>).core).toBe(core);
    // shop.ts/coins.ts both depend on actions.ts (ActionHandlers) — must be the one shared instance.
    expect((scene.shop as Record<string, unknown>).actions).toBe(scene.actions);
    expect((scene.coins as Record<string, unknown>).actions).toBe(scene.actions);
    (scene.destroy as () => void)();
  });
});

// ── SectScene — data/modals/actions/input/renderPanel over one SectSceneCore ────

describe('SectScene composition wiring', () => {
  it('shares exactly one SectSceneCore across every domain class, with the actions→data/modals and input/renderPanel→actions chain reaching the SAME instances', async () => {
    const { SectScene } = await import('../../src/scenes/SectScene');
    const scene = new SectScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onNavTab() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
      getCoins: () => 0, refreshWallet: async () => {},
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['data', 'modals', 'actions', 'input', 'renderPanel']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    expect((scene.actions as Record<string, unknown>).data).toBe(scene.data);
    expect((scene.actions as Record<string, unknown>).modals).toBe(scene.modals);
    expect((scene.input as Record<string, unknown>).actions).toBe(scene.actions);
    expect((scene.renderPanel as Record<string, unknown>).actions).toBe(scene.actions);
    expect((scene.renderPanel as Record<string, unknown>).input).toBe(scene.input);
    // Core's header (renderHeader→drawHeaderTitle→drawHeaderAllianceButtons) reaches ActionsPanel's
    // ally/manage-allies/allies-view methods through the lazy `allianceHooks` the outer assembly
    // wires right after constructing ActionsPanel — must not still be the core.ts no-op default.
    // 2026-08-25: Core owns a SectRepaint for the incremental repaint paths, over that same core.
    expect(((core as Record<string, unknown>).repaint as Record<string, unknown>).core).toBe(core);
    const hooks = (core as Record<string, unknown>).allianceHooks as Record<string, () => Promise<void>>;
    expect(hooks.openManageAllies).not.toBeUndefined();
    // Same lazy-binding trick, separate field (family-emblem-art-prompts.md, 2026-08-14): calling it
    // reaches ActionsPanel.openEmblemPicker for real (not the core.ts no-op default, which would
    // return silently either way — the meaningful check is that it doesn't throw reaching into
    // `this.actions` before the assembly assigned it, the actual risk this lazy-hook pattern guards
    // against). No sect/leader loaded here, so the real method just early-returns without opening a modal.
    const emblemHooks = (core as Record<string, unknown>).emblemHooks as { openEmblemPicker: () => void };
    expect(() => emblemHooks.openEmblemPicker()).not.toThrow();
    expect((core as Record<string, unknown>).modalOpen).toBe(false);
    (scene.destroy as () => void)();
  });
});

// ── FamilyScene — data/actions/input/renderPanel over one FamilySceneCore ────────

describe('FamilyScene composition wiring', () => {
  it('shares exactly one FamilySceneCore across every domain class, with the actions/input→data and renderPanel→actions/input chain reaching the SAME instances', async () => {
    const { FamilyScene } = await import('../../src/scenes/FamilyScene');
    const scene = new FamilyScene(createLayout(1280, 800), new InputManager(), {
      onBack() {}, onOpenSect() {}, onNavTab() {},
      async addFriend() {}, async getFriendPublicIds() { return new Set<string>(); },
      openChat() {},
      worldApi: stubWorldApi(), worldId: 'world:1:0', myAccountId: 'acc_test', playerName: 'Tester',
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['data', 'actions', 'input', 'renderPanel']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    // actions.ts/input.ts both depend on data.ts (DataHandlers) — must be the one shared instance.
    // (The old mixin chain's one genuine bidirectional dependency, actions↔input over sending a
    // channel message, was resolved by moving both halves onto InputPanel — see
    // FamilyScene/core.ts's file-header comment — so input.ts has no dependency on actions.ts.)
    expect((scene.actions as Record<string, unknown>).data).toBe(scene.data);
    expect((scene.input as Record<string, unknown>).data).toBe(scene.data);
    expect((scene.renderPanel as Record<string, unknown>).actions).toBe(scene.actions);
    expect((scene.renderPanel as Record<string, unknown>).input).toBe(scene.input);
    // 2026-08-25: Core owns a FamilyRepaint for the incremental repaint paths, over that same core.
    expect(((core as Record<string, unknown>).repaint as Record<string, unknown>).core).toBe(core);
    // header.ts (drawn from Core, before ActionsPanel exists) opens the emblem-picker modal through
    // this same lazy-callback trick as `render` (family-emblem-art-prompts.md, 2026-08-14) — must
    // reach the real ActionsPanel.openEmblemPicker without throwing (no family loaded here, so it
    // just early-returns rather than opening a modal).
    expect(() => ((core as Record<string, unknown>).openEmblemPicker as () => void)()).not.toThrow();
    expect((core as Record<string, unknown>).modalOpen).toBe(false);
    (scene.destroy as () => void)();
  });
});

// ── FriendsScene — network + 5 tab panels over one FriendsSceneCore ──────────────

describe('FriendsScene composition wiring', () => {
  it('shares exactly one FriendsSceneCore across every domain class, and friendsList reaches the SAME network/search instances', async () => {
    const { FriendsScene } = await import('../../src/scenes/FriendsScene');
    const scene = new FriendsScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, onOpenRoom() {},
      myPublicId: '',
      getProfileExtra: async () => ({}),
      loadFriends: async () => [],
      loadRequests: async () => ({ incoming: [], outgoing: [] }),
      search: async () => ({ publicId: '123456789', displayName: 'Bob' }),
      addFriend: async () => {}, respond: async () => {}, removeFriend: async () => {},
      blockUser: async () => {}, reportUser: async () => {}, duelInvite: () => {}, duelRespond: () => {},
      openChat() {},
      loadMail: async () => ({ mail: [], unread: 0 }),
      markMailRead: async () => {}, claimMail: async () => true, deleteMail: async () => {},
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['network', 'friendsList', 'search', 'orgForm', 'worldChat', 'mail']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    expect((scene.friendsList as Record<string, unknown>).network).toBe(scene.network);
    expect((scene.friendsList as Record<string, unknown>).search).toBe(scene.search);
    expect((scene.orgForm as Record<string, unknown>).network).toBe(scene.network);
    expect((scene.worldChat as Record<string, unknown>).network).toBe(scene.network);
    expect((scene.mail as Record<string, unknown>).network).toBe(scene.network);
    // Core's switchTab/triggerTabLoads/apply* handlers reach NetworkPanel through the lazy `net`
    // field the outer assembly overwrites right after constructing NetworkPanel — must not still
    // be the core.ts no-op default (see core.ts's file-header comment).
    expect((core as Record<string, unknown>).net).toBe(scene.network);
    // 2026-08-20 split-offs: orgForm delegates the family browse/join flow to OrgBrowsePanel, and
    // Core owns a RepaintState for the incremental repaint paths — both over that same core.
    const orgForm = scene.orgForm as Record<string, unknown>;
    expect((orgForm.browse as Record<string, unknown>).core).toBe(core);
    expect((orgForm.browse as Record<string, unknown>).network).toBe(scene.network);
    expect(((core as Record<string, unknown>).repaint as Record<string, unknown>).core).toBe(core);
    (scene.destroy as () => void)();
  });
});

// ── GameRenderer — events/input over one GameRendererCore ────────────────────────

describe('GameRenderer composition wiring', () => {
  it('shares exactly one GameRendererCore across events/input, and Core reaches both back via its lazy events/input fields', async () => {
    const { GameRenderer } = await import('../../src/render/GameRenderer');
    const level = getLevel('ch1_lv1')!;
    const { engine } = createLocalMatch({ level });
    const renderer = new GameRenderer(
      engine, createLayout(800, 1280), new InputManager(),
    ) as unknown as Record<string, unknown>;
    const core = renderer.core as Record<string, unknown>;
    expect(core).toBeDefined();
    expect((renderer.events as Record<string, unknown>).core).toBe(core);
    expect((renderer.input as Record<string, unknown>).core).toBe(core);
    // Core's onDown/onMove/onUp wiring (and forceTutorialVictory/update/destroy) reach EventsPanel/
    // InputPanel through the lazy `events`/`input` back-references the outer assembly overwrites
    // right after constructing each — must be the SAME instances the facade itself holds, not a
    // second pair (see core.ts's file-header comment).
    expect(core.events).toBe(renderer.events);
    expect(core.input).toBe(renderer.input);
    // Non-spectator construction wires all 3 InputManager subscriptions (onDown/onMove/onUp).
    expect((core.unsubs as unknown[]).length).toBe(3);
    (renderer.init as () => void)();
    (renderer.destroy as () => void)();
  });
});

// ── AuctionScene — bid/trade/createListing/list over one AuctionSceneCore ────────

describe('AuctionScene composition wiring', () => {
  it('shares exactly one AuctionSceneCore across bid/trade/createListing/list, and list reaches bid/trade/createListing via the SAME instances', async () => {
    const { AuctionScene } = await import('../../src/scenes/AuctionScene');
    const scene = new AuctionScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, worldApi: stubWorldApi(),
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['bid', 'trade', 'createListing', 'list']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    // list.ts's row actions reach bid/trade/createListing through the SAME instances the facade holds,
    // not separate copies.
    expect((scene.list as Record<string, unknown>).bid).toBe(scene.bid);
    expect((scene.list as Record<string, unknown>).trade).toBe(scene.trade);
    expect((scene.list as Record<string, unknown>).createListing).toBe(scene.createListing);
    // Core's update()/ensureRefBand's async callback reach CreateListingPanel.openCreateForm through
    // the lazy `reopenCreateForm` field the outer assembly overwrites right after constructing it —
    // must not still be the core.ts no-op default.
    expect((core as Record<string, unknown>).reopenCreateForm).not.toBeUndefined();
    (scene.destroy as () => void)();
  });
});

// ── CardScene — list/skins/detail/feed/actions over one CardSceneCore ────────────

describe('CardScene composition wiring', () => {
  it('shares exactly one CardSceneCore across list/skins/detail/feed/actions, and detail reaches actions/feed + list reaches detail via the SAME instances', async () => {
    const { CardScene } = await import('../../src/scenes/CardScene');
    const { makeNewSave } = await import('../../src/game/meta/SaveData');
    const scene = new CardScene(createLayout(800, 1280), new InputManager(), {
      onBack() {},
      getSave: () => makeNewSave(),
      fuseCards: async () => ({ ok: true }),
      fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
      setCardLock: async () => ({ ok: true }),
      getOwnedSkins: () => [],
      getEquippedSkin: () => null,
      equipSkin() {},
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['list', 'skins', 'detail', 'feed', 'actions']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    // detail.ts depends on actions.ts (doSetLock/doRecover) and feed.ts (openFuseSelect) — must be
    // the SAME instances the facade holds, not separate copies.
    expect((scene.detail as Record<string, unknown>).actions).toBe(scene.actions);
    expect((scene.detail as Record<string, unknown>).feed).toBe(scene.feed);
    // list.ts depends on detail.ts (openDetail) — same instance.
    expect((scene.list as Record<string, unknown>).detail).toBe(scene.detail);
    // actions.ts depends on feed.ts (playFusionAnim) — same instance.
    expect((scene.actions as Record<string, unknown>).feed).toBe(scene.feed);
    // feed.ts's confirm-fuse button reaches ActionsPanel.doFuse through the lazy `core.doFuse` hook
    // the outer assembly overwrites right after constructing ActionsPanel — must not still be the
    // core.ts no-op default (see core.ts's file-header comment).
    expect((core as Record<string, unknown>).doFuse).not.toBeUndefined();
    (scene.destroy as () => void)();
  });
});

// ── EquipmentScene — inventory/craft/detail/assign/reforge over one EquipmentSceneCore ──────────

describe('EquipmentScene composition wiring', () => {
  it('shares exactly one EquipmentSceneCore across inventory/craft/detail/assign/reforge, and detail reaches assign/reforge + inventory reaches detail via the SAME instances', async () => {
    const { EquipmentScene } = await import('../../src/scenes/EquipmentScene');
    const { makeNewSave } = await import('../../src/game/meta/SaveData');
    const scene = new EquipmentScene(createLayout(1280, 800), new InputManager(), {
      onBack() {},
      getSave: () => makeNewSave(),
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['inventory', 'craft', 'detail', 'assign', 'reforge']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    // detail.ts depends on assign.ts (beginAssign/ownerCardId) and reforge.ts (openReforgeSelect) —
    // must be the SAME instances the facade holds, not separate copies.
    expect((scene.detail as Record<string, unknown>).assign).toBe(scene.assign);
    expect((scene.detail as Record<string, unknown>).reforge).toBe(scene.reforge);
    // inventory.ts depends on detail.ts (instanceActions/openDetail) — same instance.
    expect((scene.inventory as Record<string, unknown>).detail).toBe(scene.detail);
    // Two genuine bidirectional pairs surfaced during the conversion (see core.ts's file-header
    // comment): assign.ts's doEquipTo reaches DetailPanel.doEquip through the lazy `core.doEquipHook`
    // hook, and detail.ts's doEnhance reaches InventoryPanel.refreshInstanceCell through the lazy
    // `core.refreshInstanceCellHook` hook — both overwritten by the outer assembly right after
    // constructing the real target; must not still be the core.ts no-op defaults.
    expect((core as Record<string, unknown>).doEquipHook).not.toBeUndefined();
    expect((core as Record<string, unknown>).refreshInstanceCellHook).not.toBeUndefined();
    // backAction() (fired from the header Back button) reaches AssignPanel.cancelAssign through the
    // lazy `core.cancelAssignHook` hook while in assign mode — same pattern, third hook.
    expect((core as Record<string, unknown>).cancelAssignHook).not.toBeUndefined();
    (scene.destroy as () => void)();
  });
});

// ── LobbyScene — build/badges/overlays over one LobbySceneCore ───────────────────

describe('LobbyScene composition wiring', () => {
  it('shares exactly one LobbySceneCore across build/badges/overlays, and build reaches badges/overlays via the SAME instances', async () => {
    const { LobbyScene } = await import('../../src/scenes/LobbyScene');
    const scene = new LobbyScene(createLayout(800, 1280), new InputManager(), {
      onStartGame() {},
      onOpenCampaign() {},
      onOpenRoom() {},
      onOpenShop() {},
      onOpenCards() {},
      onOpenStats() {},
      onOpenProfile() {},
      playerName: 'Guest',
    }) as unknown as Record<string, unknown>;
    const core = scene.core;
    expect(core).toBeDefined();
    for (const p of ['build', 'badges', 'overlays']) {
      expect((scene[p] as Record<string, unknown>).core).toBe(core);
    }
    // build.ts depends one-way on badges.ts (paints the badge dots right after constructing fresh
    // layers) and overlays.ts (handleDown dispatches guide/settlement/toast dismissal through it) —
    // must be the SAME instances the facade holds, not separate copies. Neither badges.ts nor
    // overlays.ts holds a reference back to build.ts — see core.ts's file-header comment for how the
    // old build.ts↔badges.ts bidirectional pair (build() calling drawXBadge methods, badges.ts's
    // rebuild() calling back into build()) was resolved by moving rebuild() onto Core instead.
    expect((scene.build as Record<string, unknown>).badges).toBe(scene.badges);
    expect((scene.build as Record<string, unknown>).overlays).toBe(scene.overlays);
    // Core's rebuild() (fired from its own onSaveChanged/preloadTabIconTextures construction-time
    // hooks, and from badges.ts's applyEventsAvailable) reaches BuildPanel.build() through the lazy `buildHook`
    // field the outer assembly overwrites right after constructing BuildPanel — must not still be
    // the core.ts no-op default.
    expect((core as Record<string, unknown>).buildHook).not.toBeUndefined();
    (scene.destroy as () => void)();
  });
});
