// SLG world-map navigation: entry/shard resolve, world map, siege replay, defense/team editors,
// city, family/sect hubs, auction house. Extracted from createAppCore.
import * as analytics from '../../analytics';
import { ENGINE_VERSION } from '../../game';
import type { Replay, LevelDefinition } from '../../game';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { WorldApiClient } from '../../net/WorldApiClient';
import { allEquippedSkins } from '../../game/meta/skinDefs';
import type { WorldMapView } from '../../scenes/WorldMapScene';
import type { AppCtx, Nav } from '../appCtx';
import { TOKEN_KEY } from '../appConstants';
import { genUuid } from '../../platform/uuid';

type WorldNav = Pick<Nav,
  'goWorldEntry' | 'goAuctionFromLobby' | 'goWorldMap' | 'goSiegeReplay' | 'goDefenseEditor' |
  'goFamilyHub' | 'goSectHub' | 'goAuctionHouse'>;

export function createWorldNav(ctx: AppCtx): WorldNav {
  const { api, saveManager, platform, state, views, nav, getNetSession, playerName, resolveWorldShard } = ctx;

  /**
   * Sell one surplus skin instance to the system for coins (ITEM_IDENTITY_DESIGN.md task1,
   * 2026-08-08) — shared by both AuctionScene entry points below. `api` is only ever undefined when
   * fully offline, which both showAuction entry points already gate on (token check before opening the
   * scene at all) — this throws instead of silently no-op'ing so the picker's catch surfaces an error
   * toast rather than pretending the sale happened.
   */
  async function sellSkin(skinId: string): Promise<{ credited: number }> {
    if (!api) throw new Error('offline');
    const { credited, save } = await api.sellSkin(skinId, genUuid());
    saveManager.adoptServer(save);
    analytics.track('skin_sell', { skin_id: skinId, credited });
    return { credited };
  }

  function goWorldEntry(): void {
    // Note: getWorldBaseUrl() returns '' in Docker/production (same-origin nginx proxy,
    // where /world/* is forwarded to worldsvc). Do NOT guard on empty string — it is valid.
    const token = platform.storage.getItem(TOKEN_KEY);
    if (!token) { analytics.track('login_gate_hit', { scene: 'WorldMapScene' }); nav.goLogin(); return; }
    const worldApi = new WorldApiClient(platform.storage);
    state.inLobby = false;
    resolveWorldShard(worldApi, (worldId) => goWorldMap(worldApi, worldId));
  }

  // AUCTION_DESIGN dual-entry: reach the auction house straight from the lobby (the other entry is
  // the world-map toolbar button). The market is account-scoped and worldId-free (§9 auction task 7) — no
  // shard resolution needed, so we open AuctionScene directly with a back-to-lobby handler.
  function goAuctionFromLobby(): void {
    const token = platform.storage.getItem(TOKEN_KEY);
    if (!token) { analytics.track('login_gate_hit', { scene: 'AuctionScene' }); nav.goLogin(); return; }
    const worldApi = new WorldApiClient(platform.storage);
    state.inLobby = false;
    analytics.track('screen_view', { scene: 'AuctionScene' });
    views.showAuction({
      onBack() { nav.goLobby(); },
      worldApi,
      getSave: () => saveManager.get(),
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      reloadSave: async () => { await saveManager.refresh(); },
      myAccountId: saveManager.get().accountId,
      sellSkin,
    });
  }

  function goWorldMap(worldApi: WorldApiClient, worldId: string): void {
    state.inLobby = false;

    // The WorldMapScene stays `current` (alive, mounted, ticking) for the whole SLG session — every
    // panel opened from it (City/team editor/defense editor/auction/social hub) mounts as an overlay
    // (SceneManager.pushOverlay via `{ overlay: true }`) instead of replacing it, so returning to the
    // map is a pop with no teardown+rebuild (ADR-044, extended from City-only to all SLG panels).
    // `view` is captured by the callbacks/closures below; they only fire after showWorldMap assigns it.
    let view: WorldMapView;

    // (Re)bind the gateway push handlers to the live map handle (march/tile/under-attack/siege
    // incremental refresh, §14.5). Called on entry and again by returnToMap — an overlay like the
    // social/sect hub rebinds session.handlers to its own set, so popping back must restore the map's.
    const bindMapNet = (): void => {
      const session = getNetSession();
      if (session) {
        session.handlers = {
          onMatchStart: (info) => nav.goGameNet(info),
          onMarchUpdate: (m) => view.applyMarchUpdate(m),
          onTileUpdate:  (tu) => view.applyTileUpdate(tu),
          onUnderAttack: (u) => view.applyUnderAttack(u),
          onSiegeResult: (s) => view.applySiegeResult(s),
          onNationMsg:   (n) => view.applyNationMsg(n),
        };
        session.connect();
      }
    };

    // Close an SLG panel and reveal the live map underneath: pop the overlay (map resumes, no rebuild)
    // and re-bind the map's push handlers (see bindMapNet). This is what every panel's back button runs
    // except City's (see returnFromCityToMap below) — world chat / the world-tile defense editor / the
    // (account-scoped, worldId-free) auction house never touch playerWorld.troops/cardState, so there's
    // nothing on `me` for them to leave stale.
    const returnToMap = (): void => { views.hideOverlay(); bindMapNet(); };

    // City-only variant: additionally re-fetches `me` (cardState/troops). City's "edit team" detour is
    // the one path that can change a team's carried troops (the formation editor's "Fill troops" /
    // distributeTroops) without the still-alive map ever re-reading it (ADR-044 — the map never tears
    // down+rebuilds to pick that up on its own). Without this, a team just given troops there keeps
    // reading its stale (often 0) troop count back on the map and silently drops out of the
    // occupy/attack team picker ("No teams yet") — see slg-worldmap-me-stale-after-overlay-return memory.
    const returnFromCityToMap = (): void => { views.hideOverlay(); bindMapNet(); view.refreshMe(); };

    // Home Desk (CityScene) as an overlay; its "edit team" detour swaps in the formation editor as a
    // sibling overlay (map still alive underneath), and backing out of that rebuilds the City overlay.
    const openCity = (): void => {
      views.showCity({
        onBack: returnFromCityToMap,
        onEditTeam(teamId, teamName) {
          views.showDefenseEditor({
            onBack: openCity,
            getSave: () => saveManager.get(),
            onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
            worldApi,
            worldId,
            target: { mode: 'attack', teamId, teamName },
          }, { overlay: true });
        },
        worldApi,
        worldId,
        getCoins: () => saveManager.get().wallet.coins,
        getSave: () => saveManager.get(),
        onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      }, { overlay: true });
    };

    view = views.showWorldMap({
      onBack() { nav.goLobby({ fade: true }); }, // exiting the SLG — one of the transitions that cross-fade
      // Social overlay (world chat tab) — also the entry point to family management,
      // since FriendsScene's family tab already delegates to goFamilyHub once the
      // player has joined a family (§25 HUD relayout: dropped the standalone Family button).
      onOpenChat() { nav.goFriends({ defaultTab: 'world', onBack: returnToMap, overlay: true }); },
      onOpenAuction() { goAuctionHouse(worldApi, worldId, { overlay: true, onBack: returnToMap }); },
      onReplaySiege(siegeId) { void goSiegeReplay(worldApi, worldId, siegeId); },
      onOpenDefense(tileKey) { goDefenseEditor(worldApi, worldId, tileKey, { overlay: true, onBack: returnToMap }); },
      onOpenCity() { openCity(); },
      worldApi,
      worldId,
      playerName: playerName(),
      accountId: saveManager.get().accountId,
      getCoins: () => saveManager.get().wallet.coins,
      getSave: () => saveManager.get(),
      storage: platform.storage,
    });
    bindMapNet();
  }

  /**
   * Watch a settled siege replay (G3-2c §16.3). worldsvc has already run the authoritative battle
   * headlessly and persisted the result — this is **pure presentation replay** (non-authoritative,
   * no recording upload, no judge): fetch `/replay` (seed + LevelDefinition reconstructed from both
   * sides' formations) → re-run in siege spectator mode with the same seed + an empty
   * ReplayInputSource, reproducing exactly what worldsvc executed. Both attackers and defenders
   * can watch.
   */
  async function goSiegeReplay(worldApi: WorldApiClient, worldId: string, siegeId: string): Promise<void> {
    let level: LevelDefinition;
    let seed = 0;
    let attackerName = '';
    let defenderName = '';
    // 2026-08-12 fix: the attacker's card/equipment/academy inputs the real settlement used to
    // resolve unitBlueprints — see ReplayScene's constructor doc comment for why these must ride
    // along, or a card-army replay can reconstruct a materially different (even outcome-flipping)
    // fight from plain baseline blueprints. Loosely typed on the wire (openapi-world.yml declares
    // them as free-form objects, same as `level`); cast to the engine's real shape here.
    let cardInstances: EngineCardInstance[] | undefined;
    let equipmentInv: EngineEquipInv | undefined;
    let siegeAcademy: { hp: number; damage: number; siege: number } | undefined;
    try {
      const data = await worldApi.getSiegeReplay(worldId, siegeId);
      level = data.level as unknown as LevelDefinition;
      seed = data.seed;
      attackerName = data.attackerName;
      defenderName = data.defenderName;
      cardInstances = data.cardInstances as unknown as EngineCardInstance[] | undefined;
      equipmentInv = data.equipmentInv as unknown as EngineEquipInv | undefined;
      siegeAcademy = data.siegeAcademy;
    } catch {
      goWorldMap(worldApi, worldId);
      return;
    }
    state.inLobby = false;
    analytics.track('siege_replay', { siege_id: siegeId });
    // Pure pre-placement with no live commands → empty frames; endFrame is set to the battle
    // timeout plus a buffer as the playback upper bound (game-over will actually stop it first).
    const SIEGE_TIMEOUT_FALLBACK = 10 * 60 * 30; // §16.1 DRAFT, matches server default
    const endFrame = (level.battleTimeoutTicks ?? SIEGE_TIMEOUT_FALLBACK) + 600;
    // Owner→side mapping (§16.3): attacker = owner0 = bottom, defender = owner1 = top. Empty names
    // (unresolved / PvE defender) leave ReplayScene to draw its generic placeholders.
    const replay: Replay = {
      engineVersion: ENGINE_VERSION,
      mode: 'siege',
      seed,
      frames: [],
      endFrame,
      meta: { players: { bottom: attackerName, top: defenderName } },
    };
    views.showReplay(
      replay, { onExit() { goWorldMap(worldApi, worldId); } }, level, allEquippedSkins(saveManager.get().equipped),
      cardInstances, equipmentInv, siegeAcademy,
    );
  }

  /**
   * Open the simplified defense editor (C3) for a tile. `opts.overlay` keeps the WorldMapScene alive
   * underneath (opened from the map); `opts.onBack` is where its back button lands (the map-return
   * pop for the overlay case). Omitting both falls back to the plain full-scene rebuild via goWorldMap.
   */
  function goDefenseEditor(
    worldApi: WorldApiClient,
    worldId: string,
    tileKey: string,
    opts?: { overlay?: boolean; onBack?: () => void },
  ): void {
    state.inLobby = false;
    views.showDefenseEditor({
      onBack: opts?.onBack ?? (() => goWorldMap(worldApi, worldId)),
      worldApi,
      worldId,
      target: { mode: 'defense', tileKey },
    }, { overlay: opts?.overlay });
  }

  // onExit is where the whole social hub (friends/family/sect/world/mail) returns to when the
  // user backs all the way out — the scene that originally opened it (lobby / world map / ...).
  // Defaults to the world map since that's the only entry point today that doesn't thread one
  // through (e.g. a future direct "family" button on the map itself). `overlay` keeps the SLG map
  // alive underneath when the hub was opened from the world map (see goWorldMap.returnToMap).
  function goFamilyHub(worldApi: WorldApiClient, worldId: string, onExit: () => void = () => goWorldMap(worldApi, worldId), overlay = false): void {
    const myAccountId = saveManager.get().accountId;
    const view = views.showFamily({
      onBack: onExit,
      onOpenSect() { goSectHub(worldApi, worldId, onExit, overlay); },
      onNavTab(tab) {
        if (tab === 'family') return;
        if (tab === 'sect') { goSectHub(worldApi, worldId, onExit, overlay); return; }
        nav.goFriends({ defaultTab: tab, onBack: onExit, overlay });
      },
      worldApi,
      worldId,
      myAccountId,
      playerName: playerName(),
      addFriend: async (publicId) => { await api!.requestFriend(publicId); },
      getFriendPublicIds: async () => new Set((await api!.getFriends()).map((f) => f.publicId)),
      openChat: (peerPublicId, peerName) => nav.goChat(peerPublicId, peerName, { overlay, onBack: () => goFamilyHub(worldApi, worldId, onExit, overlay) }),
    }, { overlay });
    // Keep the gateway connected + forward live family-channel messages into the scene
    // (socialsvc → gateway → here). Offline → REST history poll. Mirrors goSectHub below.
    const session = getNetSession();
    if (session) {
      session.handlers = {
        onMatchStart: (info) => nav.goGameNet(info),
        onFamilyMsg: (f) => view.applyFamilyMsg({
          id: `push:${f.ts}:${f.fromPublicId}`,
          senderId: f.fromPublicId,
          senderName: f.fromName,
          body: f.text,
          ts: f.ts,
        }),
      };
      session.connect();
    }
  }

  function goSectHub(worldApi: WorldApiClient, worldId: string, onExit: () => void = () => goWorldMap(worldApi, worldId), overlay = false): void {
    const myAccountId = saveManager.get().accountId;
    const view = views.showSect({
      onBack: onExit,
      onNavTab(tab) {
        if (tab === 'sect') return;
        if (tab === 'family') { goFamilyHub(worldApi, worldId, onExit, overlay); return; }
        nav.goFriends({ defaultTab: tab, onBack: onExit, overlay });
      },
      worldApi,
      worldId,
      myAccountId,
      playerName: playerName(),
      getCoins: () => saveManager.get().wallet.coins,
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      refreshWallet: async () => { await saveManager.refresh(); },
    }, { overlay });
    // Keep the gateway connected + forward live sect-channel messages into the scene
    // (S8-4b: worldsvc → Redis pub/sub → gateway → here). Offline → REST history poll.
    const session = getNetSession();
    if (session) {
      session.handlers = {
        onMatchStart: (info) => nav.goGameNet(info),
        onSectMsg: (s) => view.applySectMsg({
          id: `push:${s.ts}:${s.fromPublicId}`,
          senderId: s.fromPublicId,
          senderName: s.fromName,
          body: s.text,
          ts: s.ts,
        }),
      };
      session.connect();
    }
  }

  function goAuctionHouse(worldApi: WorldApiClient, worldId: string, opts?: { overlay?: boolean; onBack?: () => void }): void {
    views.showAuction({
      onBack: opts?.onBack ?? (() => goWorldMap(worldApi, worldId)),
      worldApi,
      getSave: () => saveManager.get(),
      onSaveChanged: (listener: () => void) => saveManager.subscribe(listener),
      reloadSave: async () => { await saveManager.refresh(); },
      myAccountId: saveManager.get().accountId,
      sellSkin,
    }, { overlay: opts?.overlay });
  }

  return {
    goWorldEntry, goAuctionFromLobby, goWorldMap, goSiegeReplay, goDefenseEditor,
    goFamilyHub, goSectHub, goAuctionHouse,
  };
}
