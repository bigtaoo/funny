import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import { getOrCreateDeviceId } from '../uuid';
import { BrowserGameSocket } from '../../net/BrowserGameSocket';
import type { Locale } from '../../i18n';
import type { IapKind } from '../iap';

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

  async getAuthCredential(): Promise<AuthCredential> {
    return { kind: 'device', deviceId: getOrCreateDeviceId(this.storage) };
  }

  connectSocket(url: string, handlers: SocketHandlers): IGameSocket {
    return new BrowserGameSocket(url, handlers);
  }

  async shareReplay(shareCode: string, title: string): Promise<void> {
    const url = `${window.location.origin}${window.location.pathname}?r=${encodeURIComponent(shareCode)}`;
    const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (nav.share) {
      await nav.share({ title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
  }

  getLaunchShareCode(): string | null {
    return new URLSearchParams(window.location.search).get('r');
  }

  // ── In-app coin recharge ────────────────────────────────────────────────────
  // CrazyGames uses its own portal monetization (ads / CrazyGames coins), not Paddle
  // or app-store IAP — the shop's Coins tab stays hidden on this platform.
  iapKind(): IapKind | null { return null; }
  openPaddleCheckout(): Promise<{ completed: boolean }> {
    return Promise.reject(new Error('paddle checkout not supported on CrazyGames'));
  }
  nativeIapPurchase(): Promise<{ receipt: string }> {
    return Promise.reject(new Error('native IAP not supported on CrazyGames'));
  }
}
