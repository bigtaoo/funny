import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage } from '../IPlatform';

export class WebPlatform implements IPlatform {
  private canvas: HTMLCanvasElement;
  readonly storage: IStorage = localStorage;

  /** Use window.devicePixelRatio for crisp rendering on HiDPI screens */
  readonly devicePixelRatio: number = window.devicePixelRatio || 1;

  constructor(canvasId = 'game-canvas') {
    let canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      document.body.appendChild(canvas);
    }
    this.canvas = canvas;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getScreenSize(): { width: number; height: number } {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  /**
   * Web: no-op.
   * PIXI's EventSystem attaches PointerEvent listeners to the canvas element
   * automatically during Application construction, so interactive containers
   * already work out of the box.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setupInput(_app: PIXI.Application): void {
    // nothing to do
  }

  onAppReady(): void {
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#f5f0e8';
  }
}
