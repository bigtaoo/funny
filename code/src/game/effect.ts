import * as PIXI from 'pixi.js-legacy';
import { AssetsManager } from '../assetsManager/assetsManager';

export class Effect {
  private atlasSprites: PIXI.Texture[] = [];
  private sprite: PIXI.Sprite;
  private time: number = 0;
  private nextTime: number = 0;
  private frameTime: number = 0;
  private spriteIndex: number = 0;

  constructor(sprite: PIXI.Sprite) {
    this.sprite = sprite;

    for (let i = 0; i < 7; ++i) {
      const s = AssetsManager().GetTexture(`boom-${i}.png`);
      this.atlasSprites.push(s);
    }
    this.frameTime = 70;
  }

  public Play(x: number, y: number): void {
    this.time = 0;
    this.nextTime = this.frameTime;
    this.spriteIndex = 0;
    this.sprite.texture = this.atlasSprites[0];
    this.sprite.visible = true;
    this.sprite.x = x;
    this.sprite.y = y;
  }

  public Update(delta: number): void {
    // console.log('time: ', this.time, ' delta: ', delta);
    this.time += delta;
    if (this.time < this.nextTime) {
      return;
    }
    this.nextTime += this.frameTime;
    this.spriteIndex++;
    if (this.spriteIndex >= this.atlasSprites.length) {
      this.sprite.visible = false;
      return;
    }
    this.sprite.texture = this.atlasSprites[this.spriteIndex];
    // console.log('sprite: ', this.sprite)
  }

  public IsVisible(): boolean {
    return this.sprite.visible;
  }
}
