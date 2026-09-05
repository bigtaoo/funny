import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers, ShareResult, TextInputOptions, ITextInput } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import { getOrCreateDeviceId } from '../uuid';
import { BrowserGameSocket } from '../../net/BrowserGameSocket';
import type { Locale } from '../../i18n';
import type { SafeAreaInsets } from '../../layout/ILayout';
import { getNativeBilling, type IapKind } from '../iap';
import { getNativeAds } from '../nativeAds';
import { isNativeShell } from '../nativeShell';
import { openDomTextInput } from './domTextInput';
// Web coin recharge. Everything Paddle-shaped lives behind this one import so the `mobile` build
// can replace the whole channel with a stub (webpack.config.js) — see paddleCheckout.ts's header.
import { PaddleCheckout } from './paddleCheckout';

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

  /**
   * Reads env(safe-area-inset-*) via a probe element. Values are 0 on displays
   * without insets (desktop, non-notched phones) and when the page lacks
   * viewport-fit=cover. Reused for every resize — the probe is created once.
   */
  private safeAreaProbe: HTMLDivElement | null = null;
  getSafeAreaInsets(): SafeAreaInsets {
    let probe = this.safeAreaProbe;
    if (!probe) {
      probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
        'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
        'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
      document.body.appendChild(probe);
      this.safeAreaProbe = probe;
    }
    const s = getComputedStyle(probe);
    const px = (v: string): number => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      top:    px(s.paddingTop),
      right:  px(s.paddingRight),
      bottom: px(s.paddingBottom),
      left:   px(s.paddingLeft),
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

  openTextInput(opts: TextInputOptions): ITextInput {
    return openDomTextInput(opts);
  }

  async onLoadingComplete(): Promise<void> { /* no-op */ }
  onGameplayStart(): void { /* no-op */ }
  onGameplayStop(): void  { /* no-op */ }
  async showMidgameAd(): Promise<void> { /* no-op */ }

  /**
   * True once the Capacitor iOS shell's native AdMob bridge (`window.NWAds`, AppDelegate.swift) is
   * present. Plain browser (a.gamestao.com/Paddle channel, no native bridge) stays false — no
   * placeholder ad is ever shown there until Google's Ad Placement API is wired up (IAP_CREDENTIALS.md §2.1).
   */
  hasRewardedAd(): boolean {
    return getNativeAds() !== null;
  }

  showRewardedAd(accountId: string): Promise<{ adToken: string; platform: string } | null> {
    const bridge = getNativeAds();
    if (!bridge) return Promise.resolve(null);
    return bridge.showRewarded(accountId).catch(() => null);
  }

  async getAuthCredential(): Promise<AuthCredential> {
    return { kind: 'device', deviceId: getOrCreateDeviceId(this.storage) };
  }

  connectSocket(url: string, handlers: SocketHandlers): IGameSocket {
    return new BrowserGameSocket(url, handlers);
  }

  async shareReplay(shareCode: string, title: string): Promise<ShareResult> {
    const url = `${window.location.origin}${window.location.pathname}?r=${encodeURIComponent(shareCode)}`;
    const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title, url });
        return { method: 'native', url };
      } catch { /* user dismissed the sheet or it failed → fall through to clipboard */ }
    }
    // No native share API (typical on desktop) → copy the link to the clipboard.
    try {
      await navigator.clipboard.writeText(url);
      return { method: 'clipboard', url };
    } catch {
      // Clipboard blocked (insecure context / denied permission) → surface the raw link so the
      // player can copy it by hand. window.prompt pre-selects the value for a quick Ctrl+C.
      try { window.prompt(title, url); } catch { /* headless / no window.prompt */ }
      return { method: 'manual', url };
    }
  }

  getLaunchShareCode(): string | null {
    return new URLSearchParams(window.location.search).get('r');
  }

  // ── In-app coin recharge (COMMERCIAL_DESIGN §IAP client) ────────────────────

  /** Web checkout channel; a throwing stub in the `mobile` build (see the import above). */
  private readonly paddle = new PaddleCheckout();

  /**
   * Native bridge (Capacitor WKWebView/WebView) wins; plain browser → Paddle.
   *
   * Inside the native shell a missing/malformed bridge does NOT fall through to Paddle: the web
   * checkout must be unreachable in a store build (App Review 3.1.1 — see nativeShell.ts), so the
   * answer there is `null` and every recharge entry point disappears instead (the shop nav gates
   * all of them on `iapKind() !== null`, same as WeChat/CrazyGames). A store build that can't sell
   * is a bug to fix; a store build that sells through Paddle is an app that gets pulled.
   */
  iapKind(): IapKind | null {
    const native = getNativeBilling();
    if (native) return native.kind;
    return isNativeShell() ? null : 'paddle';
  }

  nativeIapPurchase(tierId: string): Promise<{ receipt: string }> {
    const native = getNativeBilling();
    if (!native) return Promise.reject(new Error('no native billing bridge'));
    return native.purchase(tierId);
  }

  async openPaddleCheckout(transactionId: string, clientToken: string): Promise<{ completed: boolean }> {
    // Second lock on the same door as iapKind() above, at the point that would load paddle.js into
    // the WKWebView. The `mobile` build replaces PaddleCheckout with a throwing stub, so this is
    // belt-and-braces for the web bundle running somewhere unexpected — but this method is public
    // on IPlatform, and a future caller reaching it directly must not be the thing that puts a web
    // checkout in front of an App Store user.
    if (isNativeShell()) throw new Error('paddle checkout is unavailable in the native shell');
    return this.paddle.open(transactionId, clientToken);
  }

  onAppReady(): void {
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.backgroundColor = '#f5f0e8';
  }
}
