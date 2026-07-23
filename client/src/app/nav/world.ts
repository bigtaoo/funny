// SLG world-map navigation: entry/shard resolve, world map, siege replay, defense/team editors,
// city, family/sect hubs, auction house. Extracted from createAppCore.
import * as analytics from '../../analytics';
import { ENGINE_VERSION } from '../../game';
import type { Replay, LevelDefinition } from '../../game';
import { WorldApiClient } from '../../net/WorldApiClient';
import type { WorldMapView } from '../../scenes/WorldMapScene';
import type { AppCtx, Nav } from '../appCtx';
import { TOKEN_KEY } from '../appConstants';

type WorldNav = Pick<Nav,
  'goWorldEntry' | 'goAuctionFromLobby' | 'goWorldMap' | 'goSiegeReplay' | 'goDefenseEditor' |
  'goFamilyHub' | 'goSectHub' | 'goAuctionHouse'>;

export function createWorldNav(ctx: AppCtx): WorldNav {
  const { api, saveManager, platform, state, views, nav, getNetSession, playerName, resolveWorldShard } = ctx;

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
      reloadSave: async () => { await saveManager.refresh(); },
      myAccountId: saveManager.get().accountId,
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
        };
        session.connect();
      }
    };

    // Close an SLG panel and reveal the live map underneath: pop the overlay (map resumes, no rebuild)
    // and re-bind the map's push handlers (see bindMapNet). This is what every panel's back button runs.
    const returnToMap = (): void => { views.hideOverlay(); bindMapNet(); };

    // Home Desk (CityScene) as an overlay; its "edit team" detour swaps in the formation editor as a
    // sibling overlay (map still alive underneath), and backing out of that rebuilds the City overlay.
    const openCity = (): void => {
      views.showCity({
        onBack: returnToMap,
        onEditTeam(teamId, teamName) {
          views.showDefenseEditor({
            onBack: openCity,
            getSave: () => saveManager.get(),
            worldApi,
            worldId,
            target: { mode: 'attack', teamId, teamName },
          }, { overlay: true });
        },
        worldApi,
        worldId,
        getCoins: () => saveManager.get().wallet.coins,
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
    try {
      const data = await worldApi.getSiegeReplay(worldId, siegeId);
      level = data.level as unknown as LevelDefinition;
      seed = data.seed;
      attackerName = data.attackerName;
      defenderName = data.defenderName;
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
    views.showReplay(replay, { onExit() { goWorldMap(worldApi, worldId); } }, level);
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
    views.showFamily({
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
      reloadSave: async () => { await saveManager.refresh(); },
      myAccountId: saveManager.get().accountId,
    }, { overlay: opts?.overlay });
  }

  return {
    goWorldEntry, goAuctionFromLobby, goWorldMap, goSiegeReplay, goDefenseEditor,
    goFamilyHub, goSectHub, goAuctionHouse,
  };
}
