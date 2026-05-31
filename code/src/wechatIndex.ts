import * as PIXI from 'pixi.js-legacy';
import { WechatAssetsManager } from './assetsManager/wechatAssetsManager';
import { setAssetsManager, AssetsManager } from './assetsManager/assetsManager';
import { GameScene } from './game/gameScene';
import { Input } from './inputSystem/inputManager';
import { setupWeChatInput } from './inputSystem/wechatAdapter';

async function Init() {
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  const width = info.screenWidth;
  const height = info.screenHeight;

  const canvas = wx.createCanvas();
  const globalObj: any = typeof GameGlobal !== 'undefined' ? GameGlobal : null;
  if (globalObj) {
    globalObj.canvas = canvas;
  }

  const app = new PIXI.Application({
    view: canvas,
    width,
    height,
    backgroundColor: 0x1099bb,
    forceCanvas: true,
  });

  const wechatAssetsManager = new WechatAssetsManager();
  setAssetsManager(wechatAssetsManager);
  await AssetsManager().loadBundle(['ui', 'effects']);

  const container = new GameScene();
  app.stage.addChild(container);

  container.Resize(width, height);
  container.Draw();

  setupWeChatInput(Input);
}

Init();
