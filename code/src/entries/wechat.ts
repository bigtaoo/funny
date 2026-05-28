// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

import { createGameEngine } from '../game/GameEngine';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { GameRenderer } from '../render/GameRenderer';

async function main(): Promise<void> {
  const platform = new WechatPlatform();
  const { width, height } = platform.getScreenSize();

  const engine = createGameEngine({ seed: Date.now(), players: [{ id: 0 }, { id: 1 }] });
  const renderer = new GameRenderer(engine, {
    width,
    height,
    canvas: platform.getCanvas(),
    devicePixelRatio: platform.devicePixelRatio,
  });

  await renderer.init();
  platform.setupInput(renderer.app);
  platform.onAppReady();

}

main().catch(console.error);
