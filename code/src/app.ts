import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { RoomScene } from './scenes/RoomScene';
import { ResultScene, type EloResult } from './scenes/ResultScene';
import { ReplayScene } from './scenes/ReplayScene';
import { OwnerId, PlayerStats } from './game/types';
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine, ownerToSide } from './game';
import type { MatchStartInfo, Replay } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n } from './i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from './game/meta';
import { ApiClient } from './net/ApiClient';
import { getApiBaseUrl, getGameWsUrl } from './net/config';
import { NetSession } from './net/NetSession';
import { MatchMode } from './net/proto/transport';

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

  // ── ReplayStore (S1-RP): local ring of recent recorded matches ──────────────
  const replayStore = new ReplayStore(platform.storage);

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
      createRanked() { session?.createRanked(); },
      cancelQueue() { session?.cancelQueue(); },
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

  /** Persist a just-finished local match's recording; returns it for the result screen. */
  function keepReplay(replay: Replay | undefined): Replay | undefined {
    if (!replay) return undefined;
    try {
      replayStore.save(replay, replay.meta?.recordedAt ?? Date.now());
    } catch { /* storage full / unavailable — replay still watchable this session */ }
    return replay;
  }

  function goGame(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner, stats, replay) {
        goResult(winner, stats, 0, keepReplay(replay));
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
      onGameEnd(winner, stats, replay) {
        goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() { goLobby(); },
    }, { level }));
  }

  // Replay playback (S1-RP): spectator GameRenderer driven by a ReplayInputSource.
  function goReplay(replay: Replay): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new ReplayScene(layout, input, replay, {
      onExit() { goLobby(); },
    }));
  }

  // Online lockstep match (S1-8 / S1-9): the engine is built from the server's
  // match_start (seed/mode) and driven by NetSession's NetInputSource. The
  // render layout is built for *this client's* side, so the joiner (localSide 1)
  // gets a 180°-flipped board with their own base / hand / HUD at the bottom.
  function goGameNet(info: MatchStartInfo): void {
    const session = netSession;
    if (!session) { goLobby(); return; }
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();

    const localOwner = info.localSide as OwnerId;
    const side       = ownerToSide(localOwner);
    const { width, height } = platform.getScreenSize();
    const netLayout  = createLayout(width, height, side);

    const engine = createGameEngine(
      { seed: info.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      session.input,
    );

    // Ranked needs the server-authoritative ELO (arrives in match_over) before
    // showing the result. Friendly shows the result immediately on local end.
    const isRanked = info.mode === MatchMode.RANKED;
    let netResultShown = false;
    let lastElo: EloResult | undefined;
    let pending: { winner: OwnerId | null; stats: [PlayerStats, PlayerStats] } | null = null;
    let eloWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finishNet = (
      winner: OwnerId | null,
      stats: [PlayerStats, PlayerStats],
      elo?: EloResult,
    ): void => {
      if (netResultShown) return;
      netResultShown = true;
      if (eloWaitTimer) { clearTimeout(eloWaitTimer); eloWaitTimer = null; }
      void goResult(winner, stats, localOwner, undefined, elo);
    };

    const scene = new GameScene(netLayout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S1-5: report end-state hash + claimed winner (ranked needs the winner;
        // server settles ELO only when both clients agree on hash + winner).
        session.reportResult(matchStateHash(winner, stats), winner ?? 0);
        if (isRanked) {
          // Hold the result until the server's match_over (ELO) arrives; if the
          // server is silent, fall back after 6s and show without ELO.
          pending = { winner, stats };
          eloWaitTimer = setTimeout(() => finishNet(winner, stats, lastElo), 6000);
        } else {
          finishNet(winner, stats);
        }
      },
      // Server-driven end (opponent timeout / desync) — no hash to report.
      onNetMatchOver(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        finishNet(winner, stats, lastElo);
      },
      onExitToLobby() { session.close(); goLobby(); },
    }, { engine, net: true });

    // Route server room/net events to the live game scene's status overlay; the
    // session keeps feeding frame_batch to its NetInputSource regardless. Keep
    // onMatchStart so a late re-fire can't strand us.
    session.handlers = {
      onMatchStart: (i) => goGameNet(i),
      onNetState:   (s) => scene.applyNetState(s),
      onPeerDc:     (p) => scene.applyPeerDc(p),
      onMatchOver:  (m) => {
        lastElo = m.elo ? { delta: m.elo.delta, after: m.elo.after, rankAfter: m.elo.rankAfter } : undefined;
        scene.applyMatchOver(m); // may fire onNetMatchOver (server-driven end)
        // Base-win path: local end already fired onGameEnd and is waiting on ELO.
        if (pending) finishNet(pending.winner, pending.stats, lastElo);
      },
    };

    manager.goto(scene);
  }

  async function goResult(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    localOwner: OwnerId = 0,
    replay?: Replay,
    elo?: EloResult,
  ): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    await platform.showMidgameAd();
    manager.goto(new ResultScene(layout.designWidth, layout.designHeight, winner, stats, {
      onPlayAgain() { goLobby(); },
      // Offer "watch replay" only for locally-recorded matches.
      ...(replay ? { onWatchReplay: () => goReplay(replay) } : {}),
    }, localOwner, elo));
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
