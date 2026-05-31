import * as PIXI from 'pixi.js-legacy';
import { Effect } from './effect';
import { AssetsManager } from '../assetsManager/assetsManager';
import { get_pos, grid_size } from './helper';
import { ObjectPool } from '../cache/ObjectPool';

export class EffectManager {
  private container: PIXI.Container;
  private pool: ObjectPool<Effect>;
  private activeEffects: Set<Effect> = new Set();

  constructor(container: PIXI.Container) {
    this.container = container;

    this.pool = new ObjectPool<Effect>(
      () => {
        const sprite = new PIXI.Sprite(AssetsManager().GetTexture('boom-0.png'));
        sprite.width = grid_size();
        sprite.height = grid_size();
        sprite.visible = false;
        this.container.addChild(sprite);
        return new Effect(sprite);
      },
      (effect) => effect.Reset(),
      5,
    );
  }

  public PlayEffect(index: number): void {
    const effect = this.pool.acquire();
    const { x, y } = get_pos(index);
    effect.Play(x, y);
    this.activeEffects.add(effect);
  }

  public Update(delta: number): void {
    for (const effect of this.activeEffects) {
      effect.Update(delta);
      if (!effect.IsVisible()) {
        this.activeEffects.delete(effect);
        this.pool.release(effect);
      }
    }
  }
}
