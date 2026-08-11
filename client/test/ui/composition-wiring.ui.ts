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
    getMarches: never, getOccupations: never,
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
    const hooks = (core as Record<string, unknown>).allianceHooks as Record<string, () => Promise<void>>;
    expect(hooks.openManageAllies).not.toBeUndefined();
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
    (scene.destroy as () => void)();
  });
});
