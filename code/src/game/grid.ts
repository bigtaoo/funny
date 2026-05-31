import * as PIXI from 'pixi.js-legacy';
import { grid_count_h, grid_count_w, grid_size, index, offset_x } from './helper';
import { AssetsManager } from '../assetsManager/assetsManager';
import { OFFSET_Y } from './consts';
import { UIElement } from '../inputSystem/uiElement';
import { Input } from '../inputSystem/inputManager';
import { display } from './display';

export class Grid {
  private Container: PIXI.Container;
  private Grids: Map<number, PIXI.Sprite> = new Map();
  private selectedImage: PIXI.Sprite | undefined;

  constructor(container: PIXI.Container) {
    this.Container = container;
  }

  public DrawGrids(): void {
    const w = grid_count_w();
    const h = grid_count_h();
    for (let i = 0; i < w; ++i) {
      for (let j = 0; j < h; ++j) {
        const c = index(i, j);
        const s = new PIXI.Sprite(AssetsManager().GetTexture('Blue.png'));
        s.x = i * grid_size() + offset_x();
        s.y = j * grid_size() + OFFSET_Y;
        s.width = grid_size();
        s.height = grid_size();
        this.Container.addChild(s);
        this.Grids.set(c, s);

        const uiButton = new UIElement({
          zIndex: 10,
          sprite: s,
          onTap: () => {
            if (!s.visible) return;
            display.OnClick(c);
          },
        });
        Input.registerUI(uiButton);
      }
    }
  }

  public DrawSelectedImage(index: number): void {
    if (this.selectedImage === undefined) {
      this.selectedImage = new PIXI.Sprite(AssetsManager().GetTexture('select.png'));
      this.selectedImage.width = grid_size();
      this.selectedImage.height = grid_size();
      this.Container.addChild(this.selectedImage);
    }
    this.selectedImage.visible = true;
    const x = Math.floor(index / 1000);
    const y = index - x * 1000;
    this.selectedImage.x = x * grid_size() + offset_x();
    this.selectedImage.y = y * grid_size() + OFFSET_Y;
  }

  public HideSelctedImage(): void {
    if (this.selectedImage !== undefined) {
      this.selectedImage.visible = false;
    }
  }

  public HideGrid(index: number): void {
    const grid = this.Grids.get(index);
    if (grid !== undefined) {
      grid.visible = false;
    }
  }
}
