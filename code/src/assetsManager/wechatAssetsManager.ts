import * as PIXI from 'pixi.js-legacy';
import numbersJson from '../assets/numbers.json';
import { IAssetsManager } from './IAssetsManager';

type BundleLoader = () => Promise<void>;

export class WechatAssetsManager implements IAssetsManager {
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

  private loadImageWX(src: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const img = wx.createImage();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  private createBaseTexture(img: any): PIXI.BaseTexture {
    const resource = new PIXI.CanvasResource(img);
    return new PIXI.BaseTexture(resource);
  }

  private parseAtlas(atlas: any, baseTexture: PIXI.BaseTexture): void {
    for (const frameName in atlas.frames) {
      const frame = atlas.frames[frameName].frame;
      this.textures[frameName] = new PIXI.Texture(
        baseTexture,
        new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h),
      );
    }
  }

  private async loadUI(): Promise<void> {
    const img = await this.loadImageWX('assets/numbers.png');
    const baseTexture = this.createBaseTexture(img);
    this.parseAtlas(numbersJson, baseTexture);

    const bgImg = await this.loadImageWX('assets/background.png');
    const bgBase = this.createBaseTexture(bgImg);
    this.textures['background.png'] = new PIXI.Texture(bgBase);
  }

  private async loadEffects(): Promise<void> {
    // boom.json is not bundled for wechat — load via fetch or inline if needed
    const res = await new Promise<any>((resolve, reject) => {
      wx.request({
        url: 'assets/boom.json',
        success: (r: any) => resolve(r.data),
        fail: reject,
      });
    });
    const img = await this.loadImageWX('assets/boom.png');
    const baseTexture = this.createBaseTexture(img);
    this.parseAtlas(res, baseTexture);
  }

  public GetTexture(key: string): PIXI.Texture {
    const texture = this.textures[key];
    if (!texture) {
      throw new Error(`Missing texture: ${key}`);
    }
    return texture;
  }
}
