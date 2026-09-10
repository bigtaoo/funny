import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers, ShareResult, TextInputOptions, ITextInput } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import { getOrCreateDeviceId } from '../uuid';
import { BrowserGameSocket } from '../../net/BrowserGameSocket';
import type { Locale } from '../../i18n';
import type { SafeAreaInsets } from '../../layout/ILayout';
import type { ViewportGeometry } from '../../layout/viewportGeometry';
import { readSafeAreaInsets, observeSafeAreaInsets } from './safeAreaProbe';
import { getNativeBilling, type IapKind } from '../iap';
import { getNativeAds } from '../nativeAds';
import { reportAnomaly } from '../../net/anomaly';
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
   * Reads env(safe-area-inset-*) via a probe element (platform/web/safeAreaProbe.ts). Values are 0
   * on displays without insets (desktop, non-notched phones) and when the page lacks
   * viewport-fit=cover. Reused for every resize — the probes are created once.
   */
  getSafeAreaInsets(): SafeAreaInsets {
    return readSafeAreaInsets();
  }

  /** Push instead of poll — see safeAreaProbe.ts's header for why guessing when to re-read failed. */
  onSafeAreaInsetsChanged(cb: (insets: SafeAreaInsets) => void): () => void {
    return observeSafeAreaInsets(cb);
  }

  /**
   * On-device geometry readout (layout/viewportGeometry.ts). Every number here is one this layer can
   * see and the shared code cannot: `screen`, `visualViewport` and `window.inner*` are DOM, and
   * app.ts is on the WeChat reachable graph where none of them exist.
   */
  getViewportGeometry(): ViewportGeometry {
    const vv = window.visualViewport ?? null;
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      screenW: screen.width,
      screenH: screen.height,
      visualW: vv ? vv.width : -1,
      visualH: vv ? vv.height : -1,
      visualOffsetTop: vv ? vv.offsetTop : -1,
      dpr: window.devicePixelRatio || 1,
      insets: readSafeAreaInsets(),
      nativeShell: isNativeShell(),
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

  /**
   * Runs the native rewarded-ad flow, resolving null on every failure — the caller only needs
   * "did the player earn a reward", and DailyScene turns null into one generic message.
   *
   * That message used to be the ONLY trace a failure left. The native bridge rejects with a real
   * reason ('ad_not_ready', or AdMob's own error text from didFailToPresent), and this `.catch()`
   * dropped it on the floor; the matching NSLog is unreadable on a TestFlight build with no Mac
   * attached, which is the only place this code runs. So "no ad is available" (AdMob no-fill,
   * expected until the app is live on the App Store) and "the ad unit id is wrong" looked
   * identical from a phone, and neither could be told apart from a bridge that never loaded.
   *
   * Now every failure files one `type=ad` anomaly, which lands in Loki with the build version and
   * device context already attached — queryable next to the crash/perf channels:
   *   {source="client", kind="anomaly"} | logfmt | type="ad"
   * Reporting is best-effort and never changes what the caller sees.
   *
   * NOTE the other two platforms with real ads still swallow their reasons: WechatPlatform's three
   * resolve(null) sites and CrazyGamesPlatform's. Not wired here because WeChat's ad unit id is
   * still unset (hasRewardedAd() is false, the tab is hidden), so there is nothing to observe yet.
   */
  showRewardedAd(accountId: string): Promise<{ adToken: string; platform: string } | null> {
    const bridge = getNativeAds();
    if (!bridge) {
      // Unreachable through the Ads tab (hasRewardedAd() gates it on the same probe), so if this
      // ever shows up in Loki the bridge disappeared between the two calls — worth seeing.
      reportAnomaly('ad', 'rewarded ad requested with no native bridge');
      return Promise.resolve(null);
    }
    return bridge.showRewarded(accountId).then(
      (ad) => ad,
      (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        reportAnomaly('ad', `rewarded ad failed: ${reason}`, { kind: bridge.kind });
        return null;
      },
    );
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

  nativeIapPurchase(tierId: string, appAccountToken?: string): Promise<{ receipt: string }> {
    const native = getNativeBilling();
    if (!native) return Promise.reject(new Error('no native billing bridge'));
    return native.purchase(tierId, appAccountToken);
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
