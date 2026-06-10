import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { ResultScene } from './scenes/ResultScene';
import { OwnerId, PlayerStats } from './game/types';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n } from './i18n';

/** Storage flag — set after the first-launch intro has been seen. */
const SEEN_INTRO_KEY = 'nw_seen_intro';

export async function startApp(platform: IPlatform): Promise<void> {
  // i18n must be ready before any scene builds its texts
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

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
        platform.storage.setItem(SEEN_INTRO_KEY, '1');
        goLobby();
      },
    }));
  }

  function goLobby(): void {
    inLobby = true;
    platform.onGameplayStop();
    manager.goto(new LobbyScene(layout, input, {
      onStartGame(_opponentName: string) { goGame(); },
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

  async function goResult(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    await platform.showMidgameAd();
    manager.goto(new ResultScene(layout.designWidth, layout.designHeight, winner, stats, {
      onPlayAgain() { goLobby(); },
    }));
  }

  // First launch → background-story intro; afterwards straight to lobby
  if (platform.storage.getItem(SEEN_INTRO_KEY)) {
    goLobby();
  } else {
    goIntro();
  }
}
