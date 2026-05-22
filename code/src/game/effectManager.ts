import * as PIXI from 'pixi.js-legacy';
import { Effect } from './effect';
import { AssetsManager } from '../assetsManager/assetsManager';
import { get_pos, grid_size } from './helper';

export class EffectManager {
  private container: PIXI.Container;
  private effects: Effect[] = [];

  constructor(container: PIXI.Container) {
    this.container = container;
  }

  public PlayEffect(index: number) {
    let effect = this.effects.find((e) => !e.IsVisible());
    if (effect === undefined) {
      const sprite = AssetsManager().GetSpriteFromNumberAtlas('boom-1.png');
      sprite.width = grid_size();
      sprite.height = grid_size();
      this.container.addChild(sprite);
      effect = new Effect(sprite);
      this.effects.push(effect);
    }
    const { x, y } = get_pos(index);
    effect.Play(x, y);
  }

  public Update(delta: number): void {
    this.effects.forEach((e) => {
      if (e.IsVisible()) {
        e.Update(delta);
      }
    });
  }
}
