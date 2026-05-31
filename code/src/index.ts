import * as PIXI from 'pixi.js-legacy';
import { WebAssetsManager } from './assetsManager/webAssetsManager';
import { setAssetsManager, AssetsManager } from './assetsManager/assetsManager';
import { GameScene } from './game/gameScene';
import { Input } from './inputSystem/inputManager';
import { setupWebInput } from './inputSystem/webAdapter';

window.onload = async () => {
  const app = new PIXI.Application({
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: 0x1099bb,
  });

  const canvas = app.view as HTMLCanvasElement;
  document.body.appendChild(canvas);

  const webAssetsManager = new WebAssetsManager();
  setAssetsManager(webAssetsManager);
  await AssetsManager().loadBundle(['ui', 'effects']);

  const container = new GameScene();
  app.stage.addChild(container);

  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
    container.Resize(window.innerWidth, window.innerHeight);
  });

  container.Resize(window.innerWidth, window.innerHeight);
  container.Draw();

  app.ticker.add(() => {
    container.Update(app.ticker.elapsedMS);
  });

  setupWebInput(canvas, Input);
};
