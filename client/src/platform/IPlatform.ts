import type * as PIXI from 'pixi.js-legacy';
import type { InputManager } from '../inputSystem/InputManager';
import type { Locale } from '../i18n';
import type { IapKind } from './iap';
import type { SafeAreaInsets } from '../layout/ILayout';
import type { NetworkKind } from '../assets/prefetchPolicy';

/**
 * Outcome of {@link IPlatform.shareReplay}, so the caller can tell the player what happened:
 * - `native`    — handed to the OS share sheet (`navigator.share`); no extra feedback needed.
 * - `clipboard` — link copied to the clipboard; caller should confirm with a toast.
 * - `manual`    — clipboard was blocked; the platform showed the link for manual copy.
 * - `card`      — sent as an in-app card (WeChat); the host UI provides its own feedback.
 * `url` is the shareable link (absent for the WeChat card path).
 */
export interface ShareResult {
  method: 'native' | 'clipboard' | 'manual' | 'card';
  url?: string;
}

/**
 * Options for {@link IPlatform.openTextInput} (ASSET_PACKAGING §4.3/§4.4 item 1) — every scene that
 * needs free-text entry used to build its own hidden `<input>` directly, which works in the WeChat
 * dev-tools simulator (it has a `document`) but throws on a real device (it doesn't). This is the
 * single capability both platforms implement instead: Web/CrazyGames keep the hidden-`<input>`
 * trick (now centralized in `platform/web/domTextInput.ts`), WeChat drives its native
 * `wx.showKeyboard` keyboard.
 */
export interface TextInputOptions {
  /** Initial text shown in the field. */
  value: string;
  /** Character cap — enforced by the host `<input>` on web, requested from the host keyboard on WeChat. */
  maxLength: number;
  /** Masks entry as a web/CrazyGames `<input type=password>`. WeChat's system keyboard has no masked
   *  mode — ignored there (characters show in plain text); today only LoginScene's password fields
   *  pass this, and WeChat never routes to LoginScene (wx.login replaces it), so this is a latent gap
   *  rather than a live one — noted in ASSET_PACKAGING §4.4. */
  password?: boolean;
  /** Confirm-button label hint. Web/CrazyGames: the `enterkeyhint` attribute (mobile soft-keyboard
   *  label). WeChat: `wx.showKeyboard`'s `confirmType`. Purely cosmetic; default 'done'. */
  confirmType?: 'done' | 'next' | 'search' | 'go' | 'send';
  /** Fired on every keystroke with the field's current full value (mirrors the old `<input>` 'input'
   *  event). To filter/clip as the user types (e.g. an org-name width cap), call
   *  {@link ITextInput.setValue} with the corrected value from inside this callback. */
  onInput(value: string): void;
  /**
   * Fired when the platform's confirm affordance is used — Enter on web/CrazyGames, the system
   * keyboard's Confirm button on WeChat. Never auto-closes the field on either platform (matching a
   * plain `<input>`, which doesn't blur on Enter by itself) — call {@link ITextInput.close} from
   * here if this field should close on confirm; omit entirely for fields that don't act on Enter
   * (e.g. AuctionScene's buyer-id field).
   */
  onConfirm?(value: string): void;
  /**
   * Fired exactly once when the field is done — however that happens: the user tapped/typed away
   * (web 'blur' / WeChat's keyboard-dismiss), or the caller called {@link ITextInput.close}. This is
   * the single place to clean up scene state (matches the old hidden-`<input>` 'blur' handler every
   * call site had).
   */
  onComplete(): void;
}

/** Handle returned by {@link IPlatform.openTextInput}. */
export interface ITextInput {
  /** Overwrite the field's current value without treating it as a fresh user edit (does not itself
   *  invoke onInput) — for filtering/clipping mid-keystroke or clearing after a successful submit. */
  setValue(value: string): void;
  /** Dismiss the field now. Always invokes onComplete exactly once; a no-op if already closed. */
  close(): void;
}

/**
 * IPlatform — abstraction layer for platform-specific capabilities.
 * Implemented per-platform: WebPlatform, WechatPlatform, CrazyGamesPlatform, …
 */
export interface IPlatform {
  /** Returns the canvas element Pixi.js should render into */
  getCanvas(): HTMLCanvasElement;

  /** Screen dimensions in CSS pixels */
  getScreenSize(): { width: number; height: number };

  /**
   * Safe-area insets in CSS px (notch / Dynamic Island / home indicator / rounded
   * corners). Optional — platforms without insets (or that letterbox) may omit it;
   * the layout treats a missing value as all-zero. Web reads env(safe-area-inset-*).
   */
  getSafeAreaInsets?(): SafeAreaInsets;

  /**
   * Physical pixel ratio for the display.
   * Web: window.devicePixelRatio
   * WeChat: always 1 (canvas is already at physical resolution)
   */
  devicePixelRatio: number;

  /** Persistent key-value storage */
  storage: IStorage;

  /**
   * Current link type, used only to decide whether to run the speculative L1 prefetch
   * (ASSET_PACKAGING §14). Optional: platforms that don't implement it fall back to
   * `prefetchPolicy.navigatorNetworkKind` (the Chromium-only Network Information API), which is
   * what web/CrazyGames/mobile want anyway. WeChat overrides it because `navigator.connection`
   * does not exist in that runtime while `wx.getNetworkType` does.
   *
   * Must never reject — an unanswerable probe resolves `'unknown'`, i.e. "treat as a normal link".
   */
  getNetworkKind?(): Promise<NetworkKind>;

  /**
   * Raw system language tag, e.g. "zh-CN" / "en-US".
   * Web: navigator.language
   * WeChat: wx.getSystemInfoSync().language
   * Used by i18n to pick the default locale (player choice overrides it).
   */
  getLanguage(): string;

  /**
   * Locales this platform ships translations for.
   * Web / CrazyGames: ['zh', 'en', 'de']
   * WeChat: ['zh'] — the mini-game only needs Chinese.
   * i18n clamps the active locale to this set.
   */
  readonly supportedLocales: readonly Locale[];

  /**
   * Called once after the PIXI Application is created.
   * Creates the platform-specific input adapter and wires it to the InputManager.
   *
   * Web / CrazyGames: creates WebAdapter (canvas pointer events).
   * WeChat: creates WechatAdapter (wx.onTouch* events).
   *
   * The `toDesign` function converts screen CSS-pixel coords to design-space coords.
   */
  setupInput(
    app: PIXI.Application,
    input: InputManager,
    toDesign: (sx: number, sy: number) => { x: number; y: number },
  ): void;

  /** Called after Pixi app is created — platform may set up orientation lock etc. */
  onAppReady(): void;

  /**
   * Open a single-line text-entry surface (see {@link TextInputOptions}). Only one field is ever
   * open at a time in this app — opening a new one while another is still open closes the previous
   * one first (its onComplete fires), the same way focusing a new `<input>` steals focus from (and
   * blurs) whatever had it.
   */
  openTextInput(opts: TextInputOptions): ITextInput;

  // ── SDK lifecycle (ads, analytics) ──────────────────────────────────────────

  /** Called once after assets load — signals the platform that loading is done. */
  onLoadingComplete(): Promise<void>;

  /** Called when a gameplay session begins (match starts). */
  onGameplayStart(): void;

  /** Called when a gameplay session ends (game over / back to lobby). */
  onGameplayStop(): void;

  /**
   * Show a platform mid-game ad. Resolves when the ad finishes or is skipped.
   * No-op on platforms that don't support ads.
   */
  showMidgameAd(): Promise<void>;

  /**
   * Whether this platform has a real rewarded-ad integration right now (checked synchronously,
   * before ever calling {@link showRewardedAd}). The DailyScene "Ads" tab is hidden entirely when
   * this is false — no mock/placeholder ad is ever shown to a real player. CrazyGames is always
   * true (its own SDK); WeChat is true only once ops has configured a real ad unit id; the
   * Capacitor iOS shell is true once the native AdMob bridge (`window.NWAds`) is present; plain web
   * (no native bridge) is false until Google's Ad Placement API is wired up (IAP_CREDENTIALS.md §2.1).
   */
  hasRewardedAd(): boolean;

  /**
   * Show a rewarded video ad for the DailyScene "Ads" tab (ECONOMY_NUMBERS §6.2). Only ever called
   * when {@link hasRewardedAd} is true. `accountId` is forwarded to platforms whose SSV callback
   * needs it explicitly (AdMob's `customRewardText` — WeChat's SSV already identifies the account
   * via openid, CrazyGames does no SSV at all, so both ignore it). Resolves with the ad token +
   * platform id to submit to `POST /ads/reward`, or `null` if the ad failed to load or the player
   * closed it before completion (no reward either way — the caller shows an error, never retries
   * automatically).
   *
   * `platform` matches the server's `verifyAdPlatformToken` switch (`ads.ts`): 'dev' skips
   * signature verification (used where the platform has no client-side signing key, e.g.
   * CrazyGames — it rewards ad completion itself), 'admob_client' / 'wechat_client' are verified
   * against the configured HMAC key.
   */
  showRewardedAd(accountId: string): Promise<{ adToken: string; platform: string } | null>;

  /**
   * Anonymous-account credential the client trades to the server for a JWT
   * + accountId (S0-4). Server-side: /auth/wx (code→openid) or /auth/device.
   *
   * Web / CrazyGames: a device UUID persisted in storage (stable per device).
   * WeChat: a fresh `wx.login` code each call (short-lived, server exchanges it).
   *
   * Returns the same kind every call on a given platform.
   */
  getAuthCredential(): Promise<AuthCredential>;

  /**
   * Open a binary WebSocket to the gameserver (S1-6). Platform abstracts the
   * underlying transport (browser `WebSocket` vs `wx.connectSocket`); reconnect
   * and protocol live in `NetClient`. Returns immediately; events arrive via
   * `handlers`. Binary frames are protobuf `Envelope` (transport.proto).
   *
   * Web / CrazyGames: global `WebSocket` (binaryType=arraybuffer).
   * WeChat: `wx.connectSocket` SocketTask.
   */
  connectSocket(url: string, handlers: SocketHandlers): IGameSocket;

  // ── In-app coin recharge (COMMERCIAL_DESIGN §IAP client) ────────────────────

  /**
   * Which store this build routes coin-tier recharges to, or null when in-app recharge
   * is unavailable here (WeChat / CrazyGames — their own channels are TODO). The app only
   * shows the shop's "Coins" tab when this is non-null.
   * - Web: 'paddle', unless a native billing bridge (`window.NWBilling`) is injected by the
   *   Capacitor shell → 'apple' / 'google'.
   */
  iapKind(): IapKind | null;

  /**
   * Open the Paddle.js checkout overlay for a server-created transaction and resolve when it
   * closes (payment complete OR user-dismissed — the returned flag distinguishes them). Coins
   * are credited asynchronously by the Paddle webhook, so the caller refreshes SaveData after a
   * completed checkout. Only meaningful when iapKind() === 'paddle'; rejects on load/config error.
   */
  openPaddleCheckout(transactionId: string, clientToken: string): Promise<{ completed: boolean }>;

  /**
   * Run the native store purchase for a coin tier via the injected bridge and return the receipt
   * to verify (POST /iap/verify). Only meaningful when iapKind() is 'apple' / 'google'; rejects on
   * cancel / failure / missing bridge.
   */
  nativeIapPurchase(tierId: string): Promise<{ receipt: string }>;

  // ── Out-of-game replay sharing (REPLAY_SHARE_DESIGN §4) ─────────────────────

  /**
   * Share a state-stream replay (REPLAY_SHARE_DESIGN §4.1/§4.3). Platform branches:
   * - Web / CrazyGames: builds a share link `…?r=<shareCode>`, uses `navigator.share`,
   *   falls back to clipboard copy if unavailable.
   * - WeChat: `wx.shareAppMessage({ query: 'r=<shareCode>' })` sends it as a game card
   *   in chat (no external link).
   *
   * Resolves with a {@link ShareResult} describing how the link was surfaced so the caller can
   * give the player feedback (e.g. a "link copied" toast). Rejects only on upstream failure
   * (the share code is minted before this is called); the platform never rejects on a missing
   * native-share API — it falls back to clipboard, then to a manual prompt.
   */
  shareReplay(shareCode: string, title: string): Promise<ShareResult>;

  /**
   * Read the replay share code from launch parameters (REPLAY_SHARE_DESIGN §4.1).
   * If present, the app skips login at startup and navigates directly to the dumb player.
   * - Web / CrazyGames: URL `?r=<shareCode>`.
   * - WeChat: `wx.getLaunchOptionsSync().query.r`.
   * Returns null if absent.
   */
  getLaunchShareCode(): string | null;
}

/** gameserver WS event callbacks (provided by NetClient, triggered by the platform socket). */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(err: unknown): void;
}

/** Platform-agnostic binary socket handle. */
export interface IGameSocket {
  send(data: Uint8Array): void;
  close(): void;
}

/** Anonymous identity proof (S0-4). See IPlatform.getAuthCredential. */
export type AuthCredential =
  | { kind: 'device'; deviceId: string }
  | { kind: 'wx'; code: string };

export interface IStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
