import type * as PIXI from 'pixi.js-legacy';
import { IPlatform, IStorage, AuthCredential, IGameSocket, SocketHandlers, ShareResult, TextInputOptions, ITextInput } from '../IPlatform';
import { InputManager } from '../../inputSystem/InputManager';
import { WebAdapter } from '../../inputSystem/WebAdapter';
import { getOrCreateDeviceId } from '../uuid';
import { BrowserGameSocket } from '../../net/BrowserGameSocket';
import type { Locale } from '../../i18n';
import type { IapKind } from '../iap';
import { openDomTextInput } from '../web/domTextInput';
import { setAudioSuspended } from '../../audio/audioSettings';

/**
 * CrazyGames platform adapter.
 *
 * Extends the standard web platform with CrazyGames HTML5 SDK v3 integration.
 * SDK docs: https://docs.crazygames.com/sdk/html5/
 *
 * The SDK script must be loaded in index.html before the game bundle:
 *   <script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>
 *
 * Portal-facing obligations this class carries, none of which the rest of the game knows about:
 *  * the loading window is opened and closed as a pair (constructor / `onLoadingComplete`);
 *  * gameplay is bracketed with `gameplayStart`/`gameplayStop` (called by app/nav);
 *  * **the game is silent while an ad plays** — `adStarted` suspends audio, and every exit from an
 *    ad (finish, error, throw, timeout) restores it. Portal QA checks this; a game playing its BGM
 *    over the advertiser's audio is the thing it checks for.
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
          sdkGameLoadingStart?(): void; // optional — may not exist in all versions
          sdkGameLoadingStop?(): void;  // ditto
        };
        ad: {
          requestAd(
            type: 'midgame' | 'rewarded',
            callbacks: { adStarted?(): void; adFinished?(): void; adError?(e: unknown): void },
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
  /** Resolves once `SDK.init()` has settled (either way). See {@link ready}. */
  private readonly initDone: Promise<void>;

  constructor(canvasId = 'game-canvas') {
    let canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = canvasId;
      document.body.appendChild(canvas);
    }
    this.canvas = canvas;
    this.initDone = this.ready();
  }

  /**
   * Initialise the SDK and open the loading window.
   *
   * Runs from the constructor, not from `onLoadingComplete()`, because the two loading calls are a
   * pair: `sdkGameLoadingStart()` has to be made while the game is *still loading* for
   * `sdkGameLoadingStop()` to close anything. Initialising only at the end of the preload — which
   * is what this class did until 2026-09-04 — left the portal never told that loading had begun.
   *
   * Never rejects: on a portal-less host (our own dev server) `window.CrazyGames` is simply absent
   * and every SDK call below degrades to a no-op, which is the same shape `showMidgameAd` relies on.
   */
  private async ready(): Promise<void> {
    try {
      this.sdk = window.CrazyGames?.SDK ?? null;
      if (!this.sdk) return;
      await this.sdk.init();
      this.sdk.game.sdkGameLoadingStart?.();
    } catch (e) {
      console.warn('[CrazyGames] init failed:', e);
      this.sdk = null;
    }
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

  openTextInput(opts: TextInputOptions): ITextInput {
    return openDomTextInput(opts);
  }

  // ── SDK lifecycle ──────────────────────────────────────────────────────────

  async onLoadingComplete(): Promise<void> {
    await this.initDone;
    try {
      this.sdk?.game.sdkGameLoadingStop?.();
    } catch (e) {
      console.warn('[CrazyGames] sdkGameLoadingStop failed:', e);
    }
  }

  onGameplayStart(): void {
    try { this.sdk?.game.gameplayStart(); } catch { /* ignore */ }
  }

  onGameplayStop(): void {
    try { this.sdk?.game.gameplayStop(); } catch { /* ignore */ }
  }

  /** Every match end awaits this before showing the result screen — an SDK that never calls either
   * callback (ad-blocked with no fill, transient SDK bug) must not freeze the result screen forever. */
  private static readonly MIDGAME_AD_TIMEOUT_MS = 8000;

  /** Upper bound on a rewarded ad — see the note in {@link showRewardedAd}. */
  private static readonly REWARDED_AD_TIMEOUT_MS = 90_000;

  showMidgameAd(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sdk) { resolve(); return; }
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        setAudioSuspended(false);
        resolve();
      };
      const timer = setTimeout(done, CrazyGamesPlatform.MIDGAME_AD_TIMEOUT_MS);
      try {
        this.sdk.ad.requestAd('midgame', {
          adStarted: () => setAudioSuspended(true),
          adFinished: () => { clearTimeout(timer); done(); },
          adError: () => { clearTimeout(timer); done(); },
        });
      } catch { clearTimeout(timer); done(); }
    });
  }

  /** CrazyGames always ships its own rewarded-ad SDK — the DailyScene "Ads" tab is always shown here. */
  hasRewardedAd(): boolean {
    return true;
  }

  /**
   * CrazyGames rewards ad completion itself (via its own revenue share), so there is no
   * platform-issued transaction id to verify server-side — submitted as `platform: 'dev'`
   * (open fallback, relies on the per-account cooldown + daily cap to prevent abuse, same as
   * every other 'dev' submission from a platform without a client signing key).
   */
  showRewardedAd(_accountId: string): Promise<{ adToken: string; platform: string } | null> {
    return new Promise((resolve) => {
      if (!this.sdk) { resolve(null); return; }
      let settled = false;
      const done = (v: { adToken: string; platform: string } | null): void => {
        if (settled) return;
        settled = true;
        setAudioSuspended(false);
        resolve(v);
      };
      // Same reasoning as MIDGAME_AD_TIMEOUT_MS, and now load-bearing for a second reason: with the
      // game muted for the duration, an SDK that calls neither callback would leave it muted for the
      // rest of the session, not merely leave the DailyScene spinner up. Generous enough that a real
      // rewarded video (15-30s) can never reach it; "no reward" is the safe answer if it ever does.
      const timer = setTimeout(() => done(null), CrazyGamesPlatform.REWARDED_AD_TIMEOUT_MS);
      try {
        this.sdk.ad.requestAd('rewarded', {
          adStarted: () => setAudioSuspended(true),
          adFinished: () => {
            clearTimeout(timer);
            done({ adToken: `cg-${Date.now()}-${Math.random().toString(36).slice(2)}`, platform: 'dev' });
          },
          adError: () => { clearTimeout(timer); done(null); },
        });
      } catch { clearTimeout(timer); done(null); }
    });
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
      } catch { /* dismissed / failed → fall through to clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      return { method: 'clipboard', url };
    } catch {
      try { window.prompt(title, url); } catch { /* no window.prompt */ }
      return { method: 'manual', url };
    }
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
