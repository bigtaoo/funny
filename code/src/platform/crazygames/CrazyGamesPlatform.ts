import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import type { Locale } from '../../i18n';

/**
 * CrazyGames platform adapter.
 *
 * Extends the standard web platform with CrazyGames HTML5 SDK v3 integration.
 * SDK docs: https://docs.crazygames.com/sdk/html5/
 *
 * The SDK script must be loaded in index.html before the game bundle:
 *   <script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>
 */

// ─── SDK type shim ────────────────────────────────────────────────────────────

declare global {
  interface Window {
    CrazyGames?: {
      SDK: {
        init(): Promise<void>;
        game: {
          gameplayStart(): void;
          gameplayStop(): void;
          sdkGameLoadingStop?(): void; // optional — may not exist in all versions
        };
        ad: {
          requestAd(
            type: 'midgame' | 'rewarded',
            callbacks: { adFinished?(): void; adError?(e: unknown): void },
          ): void;
        };
      };
    };
  }
}

// ─── CrazyGamesPlatform ───────────────────────────────────────────────────────

export class CrazyGamesPlatform implements IPlatform {
  private canvas: HTMLCanvasElement;
  readonly storage: IStorage = localStorage;
  readonly devicePixelRatio: number = window.devicePixelRatio || 1;
  readonly supportedLocales: readonly Locale[] = ['zh', 'en', 'de'];

  private sdk: NonNullable<typeof window.CrazyGames>['SDK'] | null = null;

  constructor(canvasId = 'game-canvas') {
    let canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      document.body.appendChild(canvas);
    }
    this.canvas = canvas;
  }

  getCanvas(): HTMLCanvasElement { return this.canvas; }

  getScreenSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  getLanguage(): string {
    return navigator.language || 'en';
  }

  setupInput(
    _app: PIXI.Application,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ): void {
    new WebAdapter(this.canvas ?? document.querySelector('canvas')!, input, toDesign);
  }

  onAppReady(): void {
    this.canvas.style.display      = 'block';
    this.canvas.style.touchAction  = 'none';
    document.body.style.margin     = '0';
    document.body.style.overflow   = 'hidden';
    document.body.style.background = '#f5f0e8';
  }

  // ── SDK lifecycle ──────────────────────────────────────────────────────────

  async onLoadingComplete(): Promise<void> {
    try {
      this.sdk = window.CrazyGames?.SDK ?? null;
      if (!this.sdk) return;
      await this.sdk.init();
      this.sdk.game.sdkGameLoadingStop?.();
    } catch (e) {
      console.warn('[CrazyGames] init failed:', e);
    }
  }

  onGameplayStart(): void {
    try { this.sdk?.game.gameplayStart(); } catch { /* ignore */ }
  }

  onGameplayStop(): void {
    try { this.sdk?.game.gameplayStop(); } catch { /* ignore */ }
  }

  showMidgameAd(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sdk) { resolve(); return; }
      try {
        this.sdk.ad.requestAd('midgame', { adFinished: resolve, adError: () => resolve() });
      } catch { resolve(); }
    });
  }
}
