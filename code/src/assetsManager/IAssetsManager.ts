import * as PIXI from 'pixi.js-legacy';

export interface IAssetsManager {
  GetSpriteFromNumberAtlas(key: string): PIXI.Sprite;
  GetTexture(key: string): PIXI.Texture;
}
