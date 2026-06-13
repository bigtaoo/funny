import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { RoomScene } from './scenes/RoomScene';
import { ResultScene } from './scenes/ResultScene';
import { OwnerId, PlayerStats } from './game/types';
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine } from './game';
import type { MatchStartInfo } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n } from './i18n';
import { LocalSaveStore, SaveManager } from './game/meta';
import { ApiClient } from './net/ApiClient';
import { getApiBaseUrl, getGameWsUrl } from './net/config';
import { NetSession } from './net/NetSession';

/** flags key — set after the first-launch intro has been seen (was the standalone nw_seen_intro key). */
const SEEN_INTRO_FLAG = 'seen_intro';

export async function startApp(platform: IPlatform): Promise<void> {
  // i18n must be ready before any scene builds its texts
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

  // ── SaveManager (S0): local-first save + optional cloud sync ────────────────
  const baseUrl = getApiBaseUrl(platform.storage);
  const api = baseUrl ? new ApiClient(baseUrl) : undefined;
  const saveManager = new SaveManager({
    store: new LocalSaveStore(platform.storage),
    api,
    getCredential: () => platform.getAuthCredential(),
  });
  // Cloud sync is offline-first and non-blocking: failures keep the local save.
  void saveManager.bootstrap();

  // ── NetSession (S1): online friendly room + lockstep transport ──────────────
  // Built only when both a REST base (for JWT auth) and a WS endpoint are
  // configured; otherwise the room UI still opens but actions show "unavailable".
  const wsUrl = getGameWsUrl(platform.storage);
  let netSession: NetSession | null = null;
  function getNetSession(): NetSession | null {
    if (netSession) return netSession;
    if (!api || !wsUrl) return null;
    netSession = new NetSession(platform, wsUrl, api, () => platform.getAuthCredential());
    netSession.handlers.onMatchStart = (info) => goGameNet(info);
    return netSession;
  }

  const { width: screenW, height: screenH } = platform.getScreenSize();

  const app = new PIXI.Application({
    width:           screenW,
    height:          screenH,
    backgroundColor: 0xf5f0e8,
    view:            platform.getCanvas(),
    antialias:       false,
    resolution:      platform.devicePixelRatio,
    autoDensity:     true,
  });

  // ── ScalingManager ────────────────────────────────────────────────────────
  let layout: ILayout = createLayout(screenW, screenH);
  const scaling = new ScalingManager(app, layout);
  const manager = new SceneManager(app, scaling.gameLayer);

  // ── InputManager ──────────────────────────────────────────────────────────
  const input = new InputManager();
  platform.setupInput(app, input, (sx, sy) => scaling.toDesignSpace(sx, sy));

  platform.onAppReady();
  await platform.onLoadingComplete();

  // ── Resize (lobby only) ───────────────────────────────────────────────────
  let inLobby = false;

  const onResize = (): void => {
    if (!inLobby) return;
    const w = platform.getScreenSize().width;
    const h = platform.getScreenSize().height;
    app.renderer.resize(w, h);
    layout = createLayout(w, h);
    scaling.resize(w, h, layout);
    goLobby();
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  function goIntro(): void {
    inLobby = false;
    manager.goto(new IntroScene(layout, input, {
      onFinish() {
        saveManager.setFlag(SEEN_INTRO_FLAG, true);
        goLobby();
      },
    }));
  }

  function goLobby(): void {
    inLobby = true;
    platform.onGameplayStop();
    manager.goto(new LobbyScene(layout, input, {
      onStartGame(_opponentName: string) { goGame(); },
      onStartCampaign(levelIndex: number) { goCampaign(CAMPAIGN_LEVEL_ORDER[levelIndex]); },
      onOpenRoom() { goRoom(); },
    }));
    window.addEventListener('resize', onResize);
  }

  function goRoom(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    const session = getNetSession();
    const scene = new RoomScene(layout, input, {
      available: session !== null,
      onBack() {
        session?.close();
        if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
        goLobby();
      },
      createRoom() { session?.createRoom(); },
      joinRoom(code: string) { session?.joinRoom(code); },
      setReady(ready: boolean) { session?.setReady(ready); },
      startMatch() { session?.startMatch(); },
    });

    if (session) {
      // Route server room events to the live scene; keep onMatchStart on app.
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onRoomState: (s) => scene.applyRoomState(s),
        onRoomError: (e) => scene.applyRoomError(e),
        onPeerDc:    (p) => scene.applyPeerDc(p),
        onNetState:  (s) => scene.applyNetState(s),
      };
      session.connect();
    }

    manager.goto(scene);
  }

  function goGame(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        goResult(winner, stats);
      },
      onExitToLobby() { goLobby(); },
    }));
  }

  function goCampaign(levelId: string | undefined): void {
    const level = levelId ? getLevel(levelId) : null;
    if (!level) { goLobby(); return; }
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        goResult(winner, stats);
      },
      onExitToLobby() { goLobby(); },
    }, { level }));
  }

  // Online lockstep match (S1-8): the engine is built from the server's
  // match_start (seed/mode) and driven by NetSession's NetInputSource.
  // NOTE: GameRenderer renders from the owner-0 (bottom) perspective, so the
  // joiner (localSide 1) currently sees a non-flipped board — proper per-side
  // perspective is S1-9 work; same-machine host play verifies end to end.
  function goGameNet(info: MatchStartInfo): void {
    const session = netSession;
    if (!session) { goLobby(); return; }
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    // Drop the RoomScene UI handlers (that scene is about to be destroyed); the
    // session keeps routing frame_batch to its NetInputSource regardless. Keep
    // onMatchStart so a late re-fire can't strand us.
    session.handlers = { onMatchStart: (i) => goGameNet(i) };
    const engine = createGameEngine(
      { seed: info.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      session.input,
    );
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S1-5: report a deterministic end-state hash for desync detection.
        session.reportResult(matchStateHash(winner, stats));
        goResult(winner, stats);
      },
      onExitToLobby() { session.close(); goLobby(); },
    }, { engine }));
  }

  async function goResult(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    await platform.showMidgameAd();
    manager.goto(new ResultScene(layout.designWidth, layout.designHeight, winner, stats, {
      onPlayAgain() { goLobby(); },
    }));
  }

  // First launch → background-story intro; afterwards straight to lobby.
  // The flag lives in SaveData.flags now (LocalSaveStore absorbs the legacy nw_seen_intro key).
  if (saveManager.getFlag(SEEN_INTRO_FLAG)) {
    goLobby();
  } else {
    goIntro();
  }
}

/**
 * Deterministic end-state hash for the S1-5 result handshake. Both clients run
 * the same engine on the same frame stream, so the final winner + per-player
 * stats are byte-identical; the server only checks the two strings match.
 */
function matchStateHash(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): string {
  const payload = JSON.stringify({ winner, stats });
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
