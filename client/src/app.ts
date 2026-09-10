// Thin PIXI shell. All orchestration / navigation / port-calling logic lives in
// the render-free createAppCore (app/createAppCore.ts); this file only builds the
// PIXI runtime and hands it to PixiAppViews (app/PixiAppViews.ts), which turns the
// core's screen intents into `manager.goto(new XxxScene(...))`. The full-link E2E
// harness swaps PixiAppViews for a HeadlessAppViews and drives the same core
// without rendering.

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { MemoryMonitor } from './cache/MemoryMonitor';
import { PerfMonitor } from './cache/PerfMonitor';
import { initCrashSentinel, installAnomalyWatchers, setAnomalyStorage, recordRenderSample } from './net/anomaly';
import { SceneManager, type DialogGate } from './scenes/SceneManager';
import { Side } from './game';
import { ScalingManager, createLayout, resettledLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { viewportGeometryProps } from './layout/viewportGeometry';
import { installGlobalErrorHandlers, netLog, setToastSink, setAppealSink, setFeedbackSink, setSessionExpiredSink, showToastMessage } from './net/log';
import { GlobalToast } from './ui/GlobalToast';
import { AppealDialog } from './ui/dialogs/AppealDialog';
import { FeedbackDialog } from './ui/dialogs/FeedbackDialog';
import { t } from './i18n';
import { ui as C } from './render/sketchUi';
import { setBakeRenderer } from './render/bake';
import { POWER_PREFERENCE, RenderPolicy, rendererResolution } from './render/renderPolicy';
import { setDebugFlagStorage } from './debugFlags';
import { installTextPaddingFloor } from './render/pixiText';
import { preloadBoot } from './assets/bootManifest';
import { startIdlePrefetch } from './assets/idlePrefetch';
import { installPrefetchPolicy } from './assets/prefetchPolicy';
import { LoadingOverlay } from './ui/LoadingOverlay';
import { audioBus } from './audio/audioBus';
import { installAudioSettings } from './audio/audioSettings';
import { createAppCore } from './app/createAppCore';
import { PixiAppViews } from './app/PixiAppViews';
import type { AppViews } from './app/AppViews';

const appLog = netLog('app');

/**
 * Print the device's raw viewport geometry (`layout/viewportGeometry.ts`). A no-op on any platform
 * that cannot answer — WeChat has no DOM to read `window.inner*` / `screen` / `visualViewport`
 * from, so `getViewportGeometry` is deliberately absent there rather than faked.
 */
function logViewportGeometry(platform: IPlatform, phase: 'boot' | 'settled'): void {
  const geom = platform.getViewportGeometry?.();
  if (!geom) return;
  appLog.info(`viewport_geometry ${phase}`, viewportGeometryProps(geom));
}

export async function startApp(
  platform: IPlatform,
  /**
   * Test-only seam (client/src/entries/web-e2e.ts): lets a Playwright entry wrap the real
   * PixiAppViews instance before createAppCore ever calls a show* method, so instrumentation
   * (recording current screen / pushed state onto window.__nwE2E) sees every call from the very
   * first one. Never passed by any production entry (web/wechat/mobile/crazygames).
   */
  wrapViews?: (views: AppViews) => AppViews,
): Promise<void> {
  // Surface every uncaught error / rejection to the console (web-platform concern).
  installGlobalErrorHandlers();

  const { width: screenW, height: screenH } = platform.getScreenSize();

  const app = new PIXI.Application({
    width:           screenW,
    height:          screenH,
    backgroundColor: 0xf5f0e8,
    view:            platform.getCanvas(),
    antialias:       false,
    // Capped, not raw: a dpr-3 phone would otherwise rasterise 2.25× the area of a dpr-2 one for a
    // picture drawn in ~2px ink strokes. See render/renderPolicy.ts for the measurement.
    resolution:      rendererResolution(platform.devicePixelRatio),
    autoDensity:     true,
    // Ask for the integrated GPU where there is a choice. See POWER_PREFERENCE.
    powerPreference: POWER_PREFERENCE,
  });

  // Raise the global text-padding floor so no PIXI.Text (migrated to makeText or not)
  // can clip tall CJK glyph tops. See render/pixiText.ts. Layout-neutral.
  installTextPaddingFloor();

  // Time the actual GPU render call: PIXI's own ticker listener (registered by Application at
  // UPDATE_PRIORITY.LOW) runs strictly after SceneManager's onTick, so a stall inside render()
  // itself (draw-call submission, or Text canvas rasterization it triggers) is invisible to
  // recordFrameSample/recordConstructSample. See recordRenderSample in net/anomaly.ts.
  const origRender = app.renderer.render.bind(app.renderer);
  app.renderer.render = ((...args: Parameters<typeof origRender>) => {
    const t0 = performance.now();
    origRender(...args);
    recordRenderSample(performance.now() - t0);
  }) as typeof app.renderer.render;

  // Procedural art (sketch.ts) bakes static board layers to textures via this renderer.
  setBakeRenderer(app.renderer);

  // Same reason as setAnomalyStorage below, one layer down: the `nw_*` diagnostic knobs the two
  // watchdogs and RenderPolicy read (nw_mem_warn_mb / nw_fps_warn / nw_render_debug / ...) used to go
  // straight to `globalThis.localStorage`, which does not exist on WeChat — so every one of them was
  // silently stuck on its default there. Must run BEFORE the installs below, which read them.
  setDebugFlagStorage(platform.storage);

  // Memory watchdog: samples the JS heap every few seconds; logs a console.warn and dumps
  // object-pool usage when the threshold is exceeded; hooks wx.onMemoryWarning on WeChat.
  // Persists across scenes (pool registry is cleared automatically after a battle exits).
  // Threshold is tunable via localStorage 'nw_mem_warn_mb'.
  new MemoryMonitor().install(app.ticker, app.stage);

  // CPU / main-thread saturation watchdog: long-task busy ratio + sustained low FPS;
  // either condition crossing its threshold continuously triggers a cpu anomaly report (net/anomaly full-coverage channel).
  new PerfMonitor().install(app.ticker, {
    resolution: app.renderer.resolution,
    dpr:        platform.devicePixelRatio,
    canvasW:    app.view.width,
    canvasH:    app.view.height,
  });

  // Full-coverage anomaly reporting: memory / CPU / WebGL-lost / hang / uncaught exceptions
  // are reported directly to Loki (not subject to the log-targeting allowlist) to help
  // locate in-the-wild issues across the player base.
  // The crash sentinel is installed before the anomaly watchers (it reads the previous
  // session's sentinel and files a crash report if the session exited abnormally);
  // the watchers then take over the page-exit beacon / webgl / watchdog.
  // Must run before initCrashSentinel/installAnomalyWatchers: WeChat mini-game has no global
  // `localStorage`, so the crash sentinel + publicId attribution need the real platform storage
  // (platform.storage) instead of silently reading nothing there.
  setAnomalyStorage(platform.storage);
  initCrashSentinel();
  installAnomalyWatchers({ canvas: app.view as unknown as { addEventListener?: (t: string, cb: (e: unknown) => void) => void } });

  // Global fallback toast: when a non-200 / network error bubbles up to window without being
  // caught by a scene, show a player-readable toast (scene-level showToast calls do not go
  // through here, so the rule is "skip if already toasted, fallback if missed"). Classification
  // logic lives in net/log; this layer only provides the render outlet. The same outlet is
  // reused by SaveManager for targeted cloud-sync failure notifications.
  const globalToast = new GlobalToast(app);
  setToastSink((text, kind) => globalToast.show(text, kind === 'success' ? C.green : C.red));

  const insets = platform.getSafeAreaInsets?.();
  // Every number the layout depends on, printed once at boot — and into the client log ring buffer,
  // so a targeted collection (FEATURE_FLAGS_DESIGN §9.4) can retrieve it from a device we do not
  // hold. This is the only ground truth for the safe-area class of bug: desktop Chrome reports zero
  // insets in a full-height viewport, so it can reproduce none of them, and two rounds of the
  // iPhone-13 portrait bug were reasoned about with no device numbers at all (see
  // layout/viewportGeometry.ts's header for what that cost).
  logViewportGeometry(platform, 'boot');
  let layout: ILayout = createLayout(screenW, screenH, Side.Bottom, insets);
  const scaling = new ScalingManager(app, layout, insets);
  const input = new InputManager();
  // Stage-level dialogs (AppealDialog/FeedbackDialog, wired further down) live outside this manager
  // entirely — `dialogGate.close` is filled in once they exist; the mutable holder lets `manager`
  // reference it before that point (see DialogGate on SceneManager for why goto() needs this).
  const dialogGate: DialogGate = { close: () => {} };
  // The manager freezes `input` for the span of each scene-fade: taps bypass Pixi (DOM-fed), so the
  // fade's cover can't block them, and a tap mid-fade would otherwise hit the outgoing scene's
  // still-live hit-rects. Only the explicitly-faded transitions (enter/exit match, enter/exit SLG)
  // ever engage this — plain instant scene switches never freeze input.
  const manager = new SceneManager(app, scaling.gameLayer, input, dialogGate);
  platform.setupInput(app, input, (sx, sy) => scaling.toDesignSpace(sx, sy));

  // Frame-rate ceiling + demand-driven painting (render/renderPolicy.ts). Installed here rather
  // than at Application construction because it needs `manager` to read the current scene's paint
  // mode, and it must run before the first frame the boot gate below lets through.
  new RenderPolicy(app, () => manager.paintMode).install();

  // ── L0 boot-tier preload gate (ASSET_PACKAGING §3, §11) ─────────────────────
  // Show a loading screen (top-most: built after all other layers) and await the
  // minimal asset set the first LOBBY PAINT needs. Battle-only L0 assets (starter
  // rigs + decor atlas) are no longer awaited here: preloadBoot kicks them off
  // afterwards and enterBattle's own gate re-awaits them before any match, so the
  // "never a placeholder circle" guarantee holds without the lobby paying for it.
  // preloadBoot never rejects — a flaky asset advances progress and degrades
  // gracefully rather than wedging boot. On CrazyGames the SDK loading splash is
  // dismissed by onLoadingComplete() *after* this gate, so it covers our preload.
  const loading = new LoadingOverlay(app);
  await preloadBoot((done, total) => loading.setProgress(total ? done / total : 1));
  loading.destroy();

  // Audio volume/mute (AUDIO_DESIGN.md §4). Must run before the first cue can fire and AFTER the
  // entry installed its bus, or the saved gains would land on the NullAudioBus and the real one
  // would start at its own defaults instead of the player's.
  installAudioSettings({ storage: platform.storage });

  // Audio preload (AUDIO_DESIGN.md §5 "进场景前 preload"). Fire-and-forget, and deliberately
  // NOT part of the L0 gate above: a suspended AudioContext decodes fine, so this needs neither
  // the network gate nor the autoplay gesture, and until it resolves cues fall back to the
  // procedural voices (audio/audioSynth.ts) rather than going silent. The bus is whatever the
  // entry installed — NullAudioBus on WeChat and in tests, where this is a no-op.
  void audioBus().preload();

  platform.onAppReady();
  await platform.onLoadingComplete();

  // See resettledLayout() (layout/ScalingManager.ts): the asset-preload gate we just awaited
  // takes far longer than WebKit's env(safe-area-inset-*) settle delay, so re-checking here
  // catches a stale boot-time (often 0) inset before any scene is built.
  const settledInsets = platform.getSafeAreaInsets?.();
  const { width: settledW, height: settledH } = platform.getScreenSize();
  const relaidLayout = resettledLayout(settledW, settledH, insets, settledInsets);
  if (relaidLayout) {
    layout = relaidLayout;
    scaling.resize(settledW, settledH, layout, settledInsets);
    // Only when it actually fired: this branch was shipped in 2026-07 as the whole fix for the
    // iPhone-13 bug and is unreachable when the WebView zeroes env() outright, so whether it ran
    // is itself a diagnostic (an absent second line = it never triggered).
    logViewportGeometry(platform, 'settled');
  }

  // wrapViews (test-only) mutates methods on this same instance in place — pixiViews stays a
  // valid handle for onResized below regardless of whether it ran.
  const pixiViews = new PixiAppViews(platform, app, scaling, manager, input, layout);
  let views: AppViews = pixiViews;
  if (wrapViews) views = wrapViews(views);
  const core = createAppCore(platform, views);
  pixiViews.onResized = () => core.onResized();

  // Content-moderation appeal prompt (CONTENT_MODERATION_DESIGN.md §5.3): ApiClient/WorldApiClient call
  // maybePromptAppeal() right before throwing on ACCOUNT_BANNED/ACCOUNT_MUTED (see net/log.ts) — a single
  // transport-layer choke point that covers every call site without per-scene wiring. Rendered as a
  // stage-level overlay (same reasoning as GlobalToast: unaffected by scene transitions), not a
  // SceneManager scene, so it never destroys whatever the player was doing when the enforcement hit.
  //
  // Both stage-level dialogs sit on top of a scene that stays live AND still subscribed to the
  // InputManager, and pointer input bypasses PixiJS (DOM-fed — see InputManager.suppressed), so
  // their own `dim` backdrop cannot stop a tap on the dialog from ALSO hitting the scene's hit-rects
  // underneath. `input.holdForModal(true/false)` around each dialog's lifetime is what actually
  // blocks that (2026-08-10 bug report); it must be released on every close path, hence the shared
  // close helpers below rather than an inline teardown.
  let appealDialog: AppealDialog | null = null;
  const closeAppealDialog = (): void => {
    if (!appealDialog) return;
    app.stage.removeChild(appealDialog.container);
    appealDialog.destroy();
    appealDialog = null;
    input.holdForModal(false);
  };
  setAppealSink((code) => {
    if (!core.submitAppeal || appealDialog) return;
    const dlg = new AppealDialog(app.screen.width, app.screen.height, code, {
      openTextInput: (opts) => platform.openTextInput(opts),
      onSubmit: async (reason) => {
        await core.submitAppeal!(reason);
        showToastMessage(t('appeal.submitted'), 'success');
      },
      onClose: closeAppealDialog,
    });
    dlg.container.zIndex = 9_000; // above scene content, below GlobalToast (10_000)
    app.stage.addChild(dlg.container);
    appealDialog = dlg;
    input.holdForModal(true);
  });

  // Session expiry (ACCOUNT_DESIGN.md §5): the transport layers call notifySessionExpired() on a 401
  // whose code says the token itself is dead, and NetSession does the same on the gateway's 4401
  // handshake rejection — one sink instead of per-scene wiring, same reasoning as the appeal prompt
  // above. Unlike the two dialogs here this one renders nothing of its own: core.forceLogout toasts
  // and then navigates to the login screen, which is why it is a plain function and not an overlay.
  setSessionExpiredSink(() => core.forceLogout());

  // Feedback dialog (UI_DESIGN.md §4.1.1): same stage-level-overlay reasoning as the appeal dialog above,
  // but opened by a direct player tap on the lobby's feedback strip entry rather than a network error.
  // Unlike the appeal dialog, it's wired into `dialogGate` (see SceneManager's DialogGate) — Feedback is
  // only ever reachable from the Lobby, so an unrelated background nav (a pushed match starting, an
  // async world-shard resolve) firing while it's open should close it, not leave its Close button
  // pointing at whatever scene that nav silently landed on (2026-08-08 bug report).
  let feedbackDialog: FeedbackDialog | null = null;
  const closeFeedbackDialog = (): void => {
    if (!feedbackDialog) return;
    app.stage.removeChild(feedbackDialog.container);
    feedbackDialog.destroy();
    feedbackDialog = null;
    input.holdForModal(false);
  };
  dialogGate.close = closeFeedbackDialog;
  setFeedbackSink(() => {
    if (!core.submitFeedback || feedbackDialog) return;
    const dlg = new FeedbackDialog(app.screen.width, app.screen.height, {
      openTextInput: (opts) => platform.openTextInput(opts),
      onSubmit: (text) => core.submitFeedback!(text),
      onClose: closeFeedbackDialog,
    });
    dlg.container.zIndex = 9_000; // above scene content, below GlobalToast (10_000)
    app.stage.addChild(dlg.container);
    feedbackDialog = dlg;
    input.holdForModal(true);
  });

  // Stage-level dialogs sit outside targetStage, so SceneManager.onTick (which only ticks
  // `current`/`overlayScene`) never reaches them — nobody was calling FeedbackDialog.update(), so its
  // caret-blink timer (caretTimer/caretOn) never advanced and the cursor rendered as a permanently
  // solid '|' instead of blinking (2026-08-08 bug report). Drive both dialogs' update() here instead,
  // same self-ticking role GlobalToast.tick() plays for its own stage-level overlay. AppealDialog's
  // update() takes no args (it's a no-op today) but ticking it too costs nothing and avoids this same
  // wiring gap resurfacing if it ever grows a timer.
  app.ticker.add(() => {
    appealDialog?.update();
    feedbackDialog?.update(app.ticker.deltaMS / 1000);
  });

  core.start();

  // ── L1 idle prefetch (ASSET_PACKAGING §11, §14) ─────────────────────────────
  // The first scene is now up and the player is reading it. Spend that idle window
  // warming what the next gates (enterBattle / WorldMapScene / GachaScene) would
  // otherwise download only once the player asks for the scene. Strictly serial,
  // idle-scheduled and never rejecting — see idlePrefetch.ts.
  //
  // The policy install has to happen first: it carries the storage the per-feature usage marks and
  // the data-saver setting live in, plus this platform's network probe (WeChat's wx.getNetworkType
  // has no web equivalent, and the web's navigator.connection does not exist there). Uninstalled,
  // the prefetch reads as "no marks, no data-saver", which would leave both gated waves off.
  installPrefetchPolicy({
    storage: platform.storage,
    ...(platform.getNetworkKind ? { getNetworkKind: () => platform.getNetworkKind!() } : {}),
  });
  void startIdlePrefetch();
}
