// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { GameEngine } from '../game/GameEngine';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { GameRenderer } from '../render/GameRenderer';

async function main(): Promise<void> {
  const platform = new WechatPlatform();
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
