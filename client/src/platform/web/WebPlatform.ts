import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import { getOrCreateDeviceId } from '../uuid';
import { BrowserGameSocket } from '../../net/BrowserGameSocket';
import type { Locale } from '../../i18n';
import { getNativeBilling, type IapKind } from '../iap';

// ── Paddle.js (web coin recharge) type shim ──────────────────────────────────
interface PaddleCheckoutEvent { name?: string }
interface PaddleGlobal {
  Environment?: { set(env: 'sandbox' | 'production'): void };
  Initialize(opts: { token: string; eventCallback?: (ev: PaddleCheckoutEvent) => void }): void;
  Checkout: { open(opts: { transactionId: string; settings?: { displayMode?: string } }): void };
}
const PADDLE_JS_URL = 'https://cdn.paddle.com/paddle/v2/paddle.js';

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
    // No native share API → copy the link to the clipboard (primary path on desktop browsers).
    await navigator.clipboard.writeText(url);
  }

  getLaunchShareCode(): string | null {
    return new URLSearchParams(window.location.search).get('r');
  }

  // ── In-app coin recharge (COMMERCIAL_DESIGN §IAP client) ────────────────────

  /** Loaded once the token is known; re-initialized if the token (env) changes in dev. */
  private paddleToken: string | null = null;
  /** Active checkout event sink — Paddle.Initialize's single callback routes here. */
  private paddleEvent: ((ev: PaddleCheckoutEvent) => void) | null = null;

  /** Native bridge (Capacitor WKWebView/WebView) wins; plain browser → Paddle. */
  iapKind(): IapKind | null {
    return getNativeBilling()?.kind ?? 'paddle';
  }

  nativeIapPurchase(tierId: string): Promise<{ receipt: string }> {
    const native = getNativeBilling();
    if (!native) return Promise.reject(new Error('no native billing bridge'));
    return native.purchase(tierId);
  }

  async openPaddleCheckout(transactionId: string, clientToken: string): Promise<{ completed: boolean }> {
    const P = await this.loadPaddle(clientToken);
    return new Promise<{ completed: boolean }>((resolve) => {
      let completed = false;
      this.paddleEvent = (ev) => {
        if (ev.name === 'checkout.completed') completed = true;
        else if (ev.name === 'checkout.closed') { this.paddleEvent = null; resolve({ completed }); }
      };
      P.Checkout.open({ transactionId, settings: { displayMode: 'overlay' } });
    });
  }

  /** Inject Paddle.js on first use and Initialize with the seller client token. */
  private async loadPaddle(clientToken: string): Promise<PaddleGlobal> {
    const win = window as unknown as { Paddle?: PaddleGlobal };
    if (!win.Paddle) {
      await new Promise<void>((resolve, reject) => {
        const existing = document.querySelector('script[data-paddle]') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('paddle.js load failed')));
          return;
        }
        const s = document.createElement('script');
        s.src = PADDLE_JS_URL;
        s.async = true;
        s.dataset.paddle = '1';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('paddle.js load failed'));
        document.head.appendChild(s);
      });
    }
    const P = (window as unknown as { Paddle?: PaddleGlobal }).Paddle;
    if (!P) throw new Error('paddle.js unavailable after load');
    // Initialize once per token; sandbox tokens are prefixed `test_` (prod `live_`).
    if (this.paddleToken !== clientToken) {
      if (clientToken.startsWith('test_')) P.Environment?.set('sandbox');
      P.Initialize({ token: clientToken, eventCallback: (ev) => this.paddleEvent?.(ev) });
      this.paddleToken = clientToken;
    }
    return P;
  }

  onAppReady(): void {
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#f5f0e8';
  }
}
