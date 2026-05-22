import * as PIXI from 'pixi.js-legacy';
import numberJsonUrl from '../assets/numbers.json';
import numberPngUrl from '../assets/numbers.png';
import backgroundPng from '../assets/background.png';
import { IAssetsManager } from './IAssetsManager';
import boomJsonUrl from '../assets/boom.json';
import boomPngUrl from '../assets/boom.png';

export class WebAssetsManager implements IAssetsManager {
  private textures: Record<string, PIXI.Texture> = {};

  public async loadAssets(): Promise<void> {
    const numberRes = await fetch(numberJsonUrl);
    const numberAtlas = await numberRes.json();
    const numberBaseTexture = PIXI.BaseTexture.from(numberPngUrl);
    this.parseAtlas(numberAtlas, numberBaseTexture);

    const boomRes = await fetch(boomJsonUrl);
    const boomAtlas = await boomRes.json();
    const boomBaseTexture = PIXI.BaseTexture.from(boomPngUrl);
    this.parseAtlas(boomAtlas, boomBaseTexture);

    const background = PIXI.BaseTexture.from(backgroundPng);
    this.textures['background.png'] = new PIXI.Texture(background);
  }

  private parseAtlas(atlas: any, baseTexture: any) {
    const frames = atlas.frames;
    for (const key in frames) {
      const frame = frames[key].frame;
      const texture = new PIXI.Texture(
        baseTexture,
        new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h)
      );
      this.textures[key] = texture;
    }
  }

  public GetSpriteFromNumberAtlas(key: string): PIXI.Sprite {
    const texture = this.textures[key];

    if (!texture) {
      throw new Error(`Missing texture: ${key}`);
    }

    return new PIXI.Sprite(texture);
  }

  public GetTexture(key: string): PIXI.Texture {
    return this.textures[key];
  }
}

// export const webAssetsManager = new WebAssetsManager();
