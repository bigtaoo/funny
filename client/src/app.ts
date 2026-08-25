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
import { installGlobalErrorHandlers, setToastSink, setAppealSink, setFeedbackSink, showToastMessage } from './net/log';
import { GlobalToast } from './ui/GlobalToast';
import { AppealDialog } from './ui/dialogs/AppealDialog';
import { FeedbackDialog } from './ui/dialogs/FeedbackDialog';
import { t } from './i18n';
import { ui as C } from './render/sketchUi';
import { setBakeRenderer } from './render/bake';
import { installTextPaddingFloor } from './render/pixiText';
import { preloadBoot } from './assets/bootManifest';
import { startIdlePrefetch } from './assets/idlePrefetch';
import { installPrefetchPolicy } from './assets/prefetchPolicy';
import { LoadingOverlay } from './ui/LoadingOverlay';
import { createAppCore } from './app/createAppCore';
import { PixiAppViews } from './app/PixiAppViews';
import type { AppViews } from './app/AppViews';

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
    resolution:      platform.devicePixelRatio,
    autoDensity:     true,
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

  // Memory watchdog: samples the JS heap every few seconds; logs a console.warn and dumps
  // object-pool usage when the threshold is exceeded; hooks wx.onMemoryWarning on WeChat.
  // Persists across scenes (pool registry is cleared automatically after a battle exits).
  // Threshold is tunable via localStorage 'nw_mem_warn_mb'.
  new MemoryMonitor().install(app.ticker, app.stage);

  // CPU / main-thread saturation watchdog: long-task busy ratio + sustained low FPS;
  // either condition crossing its threshold continuously triggers a cpu anomaly report (net/anomaly full-coverage channel).
  new PerfMonitor().install(app.ticker);

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
