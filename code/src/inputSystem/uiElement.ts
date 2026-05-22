import * as PIXI from 'pixi.js-legacy';

export class UIElement {
  zIndex: number = 0;
  visible: boolean = true;
  private sprite: PIXI.Sprite;

  private boundsProvider: () => DOMRect | PIXI.Rectangle;
  private onTap?: () => void;

  constructor(options: { zIndex?: number; sprite: PIXI.Sprite; onTap?: () => void }) {
    this.zIndex = options.zIndex ?? 0;
    this.sprite = options.sprite;
    this.boundsProvider = () => this.sprite.getBounds();
    this.onTap = options.onTap;
  }

  contains(x: number, y: number): boolean {
    const b = this.boundsProvider();

    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }

  handle(e: { type: string }) {
    if (e.type === 'tap' && this.onTap) {
      this.onTap();
    }
  }
}
