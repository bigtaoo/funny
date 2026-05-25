import { GameEngine } from '../game/GameEngine';
import { WebPlatform } from '../platform/web/WebPlatform';
import { GameRenderer } from '../render/GameRenderer';

async function main(): Promise<void> {
  const platform = new WebPlatform('game-canvas');
  const { width, height } = platform.getScreenSize();

  const engine = new GameEngine();
  const renderer = new GameRenderer(engine, {
    width,
    height,
    canvas: platform.getCanvas(),
  });

  await renderer.init();
  platform.onAppReady();

  engine.start();
}

main().catch(console.error);
