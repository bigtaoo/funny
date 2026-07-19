// SLG world-map navigation: entry/shard resolve, world map, siege replay, defense/team editors,
// city, family/sect hubs, auction house. Extracted from createAppCore.
import * as analytics from '../../analytics';
import { ENGINE_VERSION } from '../../game';
import type { Replay, LevelDefinition } from '../../game';
import { WorldApiClient } from '../../net/WorldApiClient';
import type { AppCtx, Nav } from '../appCtx';
import { TOKEN_KEY } from '../appConstants';

type WorldNav = Pick<Nav,
  'goWorldEntry' | 'goAuctionFromLobby' | 'goWorldMap' | 'goSiegeReplay' | 'goDefenseEditor' |
  'goCity' | 'goFamilyHub' | 'goSectHub' | 'goAuctionHouse'>;

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
    const view = views.showWorldMap({
      onBack() { nav.goLobby({ fade: true }); }, // exiting the SLG — one of the transitions that cross-fade
      // Social overlay (world chat tab) — also the entry point to family management,
      // since FriendsScene's family tab already delegates to goFamilyHub once the
      // player has joined a family (§25 HUD relayout: dropped the standalone Family button).
      onOpenChat() { nav.goFriends({ defaultTab: 'world', onBack: () => goWorldMap(worldApi, worldId) }); },
      onOpenAuction() { goAuctionHouse(worldApi, worldId); },
      onReplaySiege(siegeId) { void goSiegeReplay(worldApi, worldId, siegeId); },
      onOpenDefense(tileKey) { goDefenseEditor(worldApi, worldId, tileKey); },
      onOpenCity() { goCity(worldApi, worldId); },
      worldApi,
      worldId,
      playerName: playerName(),
      accountId: saveManager.get().accountId,
      getCoins: () => saveManager.get().wallet.coins,
    });
    // Keep the gateway connected + forward SLG pushes into the live map handle
    // (march/tile/under-attack/siege incremental refresh, §14.5).
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

  /** Open the simplified defense editor (C3) for a tile; returns to the map on back. */
  function goDefenseEditor(worldApi: WorldApiClient, worldId: string, tileKey: string): void {
    state.inLobby = false;
    views.showDefenseEditor({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      worldId,
      target: { mode: 'defense', tileKey },
    });
  }

  function goCity(worldApi: WorldApiClient, worldId: string): void {
    state.inLobby = false;
    views.showCity({
      onBack() { goWorldMap(worldApi, worldId); },
      // Team card on the military page → that team's formation editor; back returns to the city.
      onEditTeam(teamId, teamName) {
        views.showDefenseEditor({
          onBack() { goCity(worldApi, worldId); },
          getSave: () => saveManager.get(),
          worldApi,
          worldId,
          target: { mode: 'attack', teamId, teamName },
        });
      },
      worldApi,
      worldId,
      getCoins: () => saveManager.get().wallet.coins,
    });
  }

  // onExit is where the whole social hub (friends/family/sect/world/mail) returns to when the
  // user backs all the way out — the scene that originally opened it (lobby / world map / ...).
  // Defaults to the world map since that's the only entry point today that doesn't thread one
  // through (e.g. a future direct "family" button on the map itself).
  function goFamilyHub(worldApi: WorldApiClient, worldId: string, onExit: () => void = () => goWorldMap(worldApi, worldId)): void {
    const myAccountId = saveManager.get().accountId;
    views.showFamily({
      onBack: onExit,
      onOpenSect() { goSectHub(worldApi, worldId, onExit); },
      onNavTab(tab) {
        if (tab === 'family') return;
        if (tab === 'sect') { goSectHub(worldApi, worldId, onExit); return; }
        nav.goFriends({ defaultTab: tab, onBack: onExit });
      },
      worldApi,
      worldId,
      myAccountId,
      playerName: playerName(),
      addFriend: async (publicId) => { await api!.requestFriend(publicId); },
    });
  }

  function goSectHub(worldApi: WorldApiClient, worldId: string, onExit: () => void = () => goWorldMap(worldApi, worldId)): void {
    const myAccountId = saveManager.get().accountId;
    const view = views.showSect({
      onBack: onExit,
      onNavTab(tab) {
        if (tab === 'sect') return;
        if (tab === 'family') { goFamilyHub(worldApi, worldId, onExit); return; }
        nav.goFriends({ defaultTab: tab, onBack: onExit });
      },
      worldApi,
      worldId,
      myAccountId,
      playerName: playerName(),
      getCoins: () => saveManager.get().wallet.coins,
      refreshWallet: async () => { await saveManager.refresh(); },
    });
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

  function goAuctionHouse(worldApi: WorldApiClient, worldId: string): void {
    views.showAuction({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      getSave: () => saveManager.get(),
      reloadSave: async () => { await saveManager.refresh(); },
      myAccountId: saveManager.get().accountId,
    });
  }

  return {
    goWorldEntry, goAuctionFromLobby, goWorldMap, goSiegeReplay, goDefenseEditor,
    goCity, goFamilyHub, goSectHub, goAuctionHouse,
  };
}
