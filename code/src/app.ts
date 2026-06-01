/**
 * app.ts — platform-agnostic game bootstrap.
 *
 * Each platform entry (web.ts, crazygames.ts, wechat.ts, …) creates the
 * appropriate IPlatform implementation and passes it here.
 */

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { ResultScene } from './scenes/ResultScene';
import { OwnerId, PlayerStats } from './game/types';

export async function startApp(platform: IPlatform): Promise<void> {
  const { width, height } = platform.getScreenSize();

  const app = new PIXI.Application({
    width,
    height,
    backgroundColor: 0xf5f0e8,
    view:            platform.getCanvas(),
    antialias:       false,
    resolution:      platform.devicePixelRatio,
    autoDensity:     true,
  });

  platform.setupInput(app);
  platform.onAppReady();

  // Signal the platform that loading is done (shows game, hides loading screen, etc.)
  await platform.onLoadingComplete();

  const manager = new SceneManager(app);

  function goLobby(): void {
    platform.onGameplayStop();
    manager.goto(new LobbyScene(width, height, {
      onStartGame(_opponentName: string) { goGame(); },
    }));
  }

  function goGame(): void {
    platform.onGameplayStart();
    manager.goto(new GameScene(width, height, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        goResult(winner, stats);
      },
      onExitToLobby() {
        goLobby();
      },
    }));
  }

  async function goResult(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): Promise<void> {
    platform.onGameplayStop();
    await platform.showMidgameAd();
    manager.goto(new ResultScene(width, height, winner, stats, {
      onPlayAgain() { goLobby(); },
    }));
  }

  goLobby();
}
