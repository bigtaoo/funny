import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import type { Locale } from '../../i18n';

export class WebPlatform implements IPlatform {
  private canvas: HTMLCanvasElement;
  readonly storage: IStorage = localStorage;
  readonly supportedLocales: readonly Locale[] = ['zh', 'en', 'de'];

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

  getLanguage(): string {
    return navigator.language || 'en';
  }

  setupInput(
    _app: PIXI.Application,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ): void {
    new WebAdapter(this.canvas, input, toDesign);
  }

  async onLoadingComplete(): Promise<void> { /* no-op */ }
  onGameplayStart(): void { /* no-op */ }
  onGameplayStop(): void  { /* no-op */ }
  async showMidgameAd(): Promise<void> { /* no-op */ }

  onAppReady(): void {
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#f5f0e8';
  }
}
