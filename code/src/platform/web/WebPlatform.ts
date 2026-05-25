import { IPlatform, IStorage } from '../IPlatform';

export class WebPlatform implements IPlatform {
  private canvas: HTMLCanvasElement;
  readonly storage: IStorage = localStorage;

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

  onAppReady(): void {
    // Lock to portrait on mobile via CSS
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#f5f0e8';
  }
}
