import * as PIXI from 'pixi.js-legacy';
import numberJsonUrl from '../assets/numbers.json';
import numberPngUrl from '../assets/numbers.png';
import backgroundPng from '../assets/background.png';
import boomJsonUrl from '../assets/boom.json';
import boomPngUrl from '../assets/boom.png';
import { IAssetsManager } from './IAssetsManager';

type BundleLoader = () => Promise<void>;

export class WebAssetsManager implements IAssetsManager {
  private textures: Record<string, PIXI.Texture> = {};
  private loadedBundles = new Set<string>();

  private bundleLoaders: Record<string, BundleLoader> = {
    ui: () => this.loadUI(),
    effects: () => this.loadEffects(),
  };

  public async loadBundle(keys: string[]): Promise<void> {
    const pending = keys.filter((k) => !this.loadedBundles.has(k));
    if (pending.length === 0) return;
    await Promise.all(pending.map((k) => this.bundleLoaders[k]?.()));
    pending.forEach((k) => this.loadedBundles.add(k));
  }

  private async loadUI(): Promise<void> {
    const res = await fetch(numberJsonUrl);
    const atlas = await res.json();
    const baseTexture = PIXI.BaseTexture.from(numberPngUrl);
    this.parseAtlas(atlas, baseTexture);

    const bg = PIXI.BaseTexture.from(backgroundPng);
    this.textures['background.png'] = new PIXI.Texture(bg);
  }

  private async loadEffects(): Promise<void> {
    const res = await fetch(boomJsonUrl);
    const atlas = await res.json();
    const baseTexture = PIXI.BaseTexture.from(boomPngUrl);
    this.parseAtlas(atlas, baseTexture);
  }

  private parseAtlas(atlas: any, baseTexture: PIXI.BaseTexture): void {
    for (const key in atlas.frames) {
      const frame = atlas.frames[key].frame;
      this.textures[key] = new PIXI.Texture(
        baseTexture,
        new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
      );
    }
  }

  public GetTexture(key: string): PIXI.Texture {
    const texture = this.textures[key];
    if (!texture) {
      throw new Error(`Missing texture: ${key}`);
    }
    return texture;
  }
}
