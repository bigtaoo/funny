import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { ResultScene } from './scenes/ResultScene';
import { OwnerId, PlayerStats } from './game/types';
import { getLevel, CAMPAIGN_LEVEL_ORDER } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n } from './i18n';
import { LocalSaveStore, SaveManager } from './game/meta';
import { ApiClient } from './net/ApiClient';
import { getApiBaseUrl } from './net/config';

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
    }));
    window.addEventListener('resize', onResize);
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
