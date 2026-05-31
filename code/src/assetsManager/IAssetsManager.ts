import * as PIXI from 'pixi.js-legacy';

export interface IAssetsManager {
  loadBundle(keys: string[]): Promise<void>;
  GetTexture(key: string): PIXI.Texture;
}
