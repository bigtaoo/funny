// Thin PIXI shell. All orchestration / navigation / port-calling logic lives in
// the render-free createAppCore (app/createAppCore.ts); this file only builds the
// PIXI runtime and the PixiAppViews that turns the core's screen intents into
// `manager.goto(new XxxScene(...))`. The full-link E2E harness swaps PixiAppViews
// for a HeadlessAppViews and drives the same core without rendering.

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { MemoryMonitor } from './cache/MemoryMonitor';
import { PerfMonitor } from './cache/PerfMonitor';
import { initCrashSentinel, installAnomalyWatchers } from './net/anomaly';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene, type LobbySceneCallbacks } from './scenes/LobbyScene';
import { GameScene, type GameSceneCallbacks, type GameSceneOptions } from './scenes/GameScene';
import { RoomScene, type RoomSceneCallbacks } from './scenes/RoomScene';
import { FriendsScene, type FriendsSceneCallbacks } from './scenes/FriendsScene';
import { ChatScene, type ChatSceneCallbacks } from './scenes/ChatScene';
import { ShopScene, type ShopSceneCallbacks } from './scenes/ShopScene';
import { GachaScene, type GachaSceneCallbacks } from './scenes/GachaScene';
import { LoginScene, type LoginSceneCallbacks } from './scenes/LoginScene';
import { ResultScene } from './scenes/ResultScene';
import { ReplayScene, type ReplaySceneCallbacks } from './scenes/ReplayScene';
import { StatePlayerScene, type StatePlayerSceneCallbacks } from './scenes/StatePlayerScene';
import type { StateReplay, EncodedStateReplay } from './game/replay/StateReplay';
import { SettingsScene, type SettingsSceneCallbacks } from './scenes/SettingsScene';
import { CampaignMapScene, type CampaignMapCallbacks } from './scenes/CampaignMapScene';
import { LevelPrepScene, type LevelPrepCallbacks } from './scenes/LevelPrepScene';
import { CardCodexScene, type CardCodexCallbacks } from './scenes/CardCodexScene';
import { CardScene, type CardCallbacks } from './scenes/CardScene';
import { EquipmentScene, type EquipmentCallbacks } from './scenes/EquipmentScene';
import { StatsScene, type StatsCallbacks } from './scenes/StatsScene';
import { AchievementScene, type AchievementCallbacks } from './scenes/AchievementScene';
import { LeaderboardScene, type LeaderboardCallbacks } from './scenes/LeaderboardScene';
import { BattlePassScene, type BattlePassCallbacks } from './scenes/BattlePassScene';
import { TitlesScene, type TitlesSceneCallbacks } from './scenes/TitlesScene';
import { WorldMapScene, type WorldMapCallbacks, type WorldMapView } from './scenes/WorldMapScene';
import { FamilyScene, type FamilySceneCallbacks } from './scenes/FamilyScene';
import { SectScene, type SectSceneCallbacks, type SectSceneView } from './scenes/SectScene';
import { AuctionScene, type AuctionSceneCallbacks } from './scenes/AuctionScene';
import { DefenseEditorScene, type DefenseEditorCallbacks } from './scenes/DefenseEditorScene';
import { TeamsScene, type TeamsCallbacks } from './scenes/TeamsScene';
import { DeckBuilderScene, type DeckBuilderCallbacks } from './scenes/DeckBuilderScene';
import { CityScene, type CitySceneCallbacks } from './scenes/CityScene';
import { DailyScene, type DailyCallbacks } from './scenes/DailyScene';
import { EventScene, type EventCallbacks } from './scenes/EventScene';
import { ConsentDialog, type ConsentCallbacks } from './render/ConsentDialog';
import { ReconnectPromptDialog, type ReconnectPromptCallbacks } from './render/ReconnectPromptDialog';
import { OwnerId, ownerToSide, Side } from './game';
import type { Replay, LevelDefinition } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { installGlobalErrorHandlers, setToastSink } from './net/log';
import { GlobalToast } from './ui/GlobalToast';
import { ui as C } from './render/sketchUi';
import { setBakeRenderer } from './render/bake';
import { preloadBoot } from './assets/bootManifest';
import { LoadingOverlay } from './render/LoadingOverlay';
import { createAppCore } from './app/createAppCore';
import type { AppViews, LobbyView, RoomView, FriendsView, ChatView, NetGameView, ResultViewProps, FadeOpts } from './app/AppViews';

/**
 * The PIXI implementation of AppViews: each show*() runs the same
 * `manager.goto(new XxxScene(...))` the old startApp() did. Owns the layout +
 * the lobby-only resize listener (kept out of the core).
 */
class PixiAppViews implements AppViews {
  private layout: ILayout;
  /** Set by the shell to core.onResized(); fired after a lobby resize re-renders. */
  onResized: (() => void) | null = null;

  /** True only while an onResize()-driven lobby rebuild is in flight, so that rebuild swaps instantly (no fade). */
  private resizing = false;

  private readonly onResize = (): void => {
    const { width, height } = this.platform.getScreenSize();
    const insets = this.platform.getSafeAreaInsets?.();
    this.app.renderer.resize(width, height);
    this.layout = createLayout(width, height, Side.Bottom, insets);
    this.scaling.resize(width, height, this.layout, insets);
    this.resizing = true;
    try {
      this.onResized?.(); // synchronously rebuilds the lobby via showLobby()
    } finally {
      this.resizing = false;
    }
  };

  constructor(
    private readonly platform: IPlatform,
    private readonly app: PIXI.Application,
    private readonly scaling: ScalingManager,
    private readonly manager: SceneManager,
    private readonly input: InputManager,
    layout: ILayout,
  ) {
    this.layout = layout;
  }

  /** Detach the lobby resize listener — every non-lobby screen calls this first. */
  private leaveLobby(): void {
    window.removeEventListener('resize', this.onResize);
  }

  showIntro(cb: Parameters<AppViews['showIntro']>[0]): void {
    this.leaveLobby();
    this.manager.goto(new IntroScene(this.layout, this.input, cb));
  }

  showConsent(cb: ConsentCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new ConsentDialog(this.layout.designWidth, this.layout.designHeight, cb));
  }

  showReconnectPrompt(cb: ReconnectPromptCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new ReconnectPromptDialog(this.layout.designWidth, this.layout.designHeight, cb));
  }

  showLobby(cb: LobbySceneCallbacks, opts?: FadeOpts): LobbyView {
    const scene = new LobbyScene(this.layout, this.input, cb);
    // A resize-driven rebuild always swaps instantly, regardless of the caller's fade request.
    this.manager.goto(scene, { fade: !this.resizing && !!opts?.fade });
    window.addEventListener('resize', this.onResize);
    return {
      applySocialBadge: (n) => scene.applySocialBadge(n),
      applyAchievementBadge: (c) => scene.applyAchievementBadge(c),
      applyShopBadge: (c) => scene.applyShopBadge(c),
      applyRetentionBadge: (c) => scene.applyRetentionBadge(c),
      applyEventsAvailable: (a) => scene.applyEventsAvailable(a),
      applyWorldAvailable: (ok) => scene.applyWorldAvailable(ok),
      showAchievementToast: (m) => scene.showAchievementToast(m),
      showSeasonSettlement: (o, p, n) => scene.showSeasonSettlement(o, p, n),
      showFeatureGuide: (tk, bk, onDismiss) => scene.showFeatureGuide(tk, bk, onDismiss),
    };
  }

  showSettings(cb: SettingsSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new SettingsScene(this.layout, this.input, cb));
  }

  showLogin(cb: LoginSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new LoginScene(this.layout, this.input, cb));
  }

  showShop(cb: ShopSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new ShopScene(this.layout, this.input, cb));
  }

  showGacha(cb: GachaSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new GachaScene(this.layout, this.input, cb));
  }

  showCampaignMap(cb: CampaignMapCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new CampaignMapScene(this.layout, this.input, cb));
  }

  showLevelPrep(cb: LevelPrepCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new LevelPrepScene(this.layout, this.input, cb));
  }

  showCardCodex(cb: CardCodexCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new CardCodexScene(this.layout, this.input, cb));
  }

  showCardRoster(cb: CardCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new CardScene(this.layout, this.input, cb));
  }

  showEquipment(cb: EquipmentCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new EquipmentScene(this.layout, this.input, cb));
  }

  showStats(cb: StatsCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new StatsScene(this.layout, this.input, cb));
  }

  showAchievements(cb: AchievementCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new AchievementScene(this.layout, this.input, cb));
  }

  showLeaderboard(cb: LeaderboardCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new LeaderboardScene(this.layout, this.input, cb));
  }

  showBattlePass(cb: BattlePassCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new BattlePassScene(this.layout, this.input, cb));
  }

  showTitles(cb: TitlesSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new TitlesScene(this.layout, this.input, cb));
  }

  showDaily(cb: DailyCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new DailyScene(this.layout, this.input, cb));
  }

  showEvents(cb: EventCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new EventScene(this.layout, this.input, cb));
  }

  showReplay(replay: Replay, cb: ReplaySceneCallbacks, level?: LevelDefinition): void {
    this.leaveLobby();
    this.manager.goto(new ReplayScene(this.layout, this.input, replay, cb, level));
  }

  showStatePlayer(replay: StateReplay, cb: StatePlayerSceneCallbacks, encoded?: EncodedStateReplay): void {
    this.leaveLobby();
    this.manager.goto(new StatePlayerScene(this.layout, replay, cb, encoded));
  }

  showResult(props: ResultViewProps): void {
    this.leaveLobby();
    this.manager.goto(new ResultScene(
      this.layout.designWidth,
      this.layout.designHeight,
      props.winner,
      props.stats,
      props.cb,
      props.localOwner,
      props.elo,
      props.profiles,
      props.outroText,
    ));
  }

  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void {
    this.leaveLobby();
    // Entering a match is one of the handful of transitions that cross-fade (see SceneManager).
    this.manager.goto(new GameScene(this.layout, this.input, cb, opts), { fade: true });
  }

  showRoom(cb: RoomSceneCallbacks): RoomView {
    this.leaveLobby();
    const scene = new RoomScene(this.layout, this.input, cb);
    this.manager.goto(scene);
    return {
      applyRoomState: (s) => scene.applyRoomState(s),
      applyRoomError: (e) => scene.applyRoomError(e),
      applyPeerDc:    (p) => scene.applyPeerDc(p),
      applyNetState:  (s) => scene.applyNetState(s),
    };
  }

  showFriends(cb: FriendsSceneCallbacks): FriendsView {
    this.leaveLobby();
    const scene = new FriendsScene(this.layout, this.input, cb);
    this.manager.goto(scene);
    return {
      applyFriendPresence: (p) => scene.applyFriendPresence(p),
      applyFriendRequest:  (r) => scene.applyFriendRequest(r),
      applyFriendUpdate:   (u) => scene.applyFriendUpdate(u),
      applyChatMessage:    (m) => scene.applyChatMessage(m),
      applyMailNew:        (m) => scene.applyMailNew(m),
    };
  }

  showChat(cb: ChatSceneCallbacks): ChatView {
    this.leaveLobby();
    const scene = new ChatScene(this.layout, this.input, cb);
    this.manager.goto(scene);
    return { applyIncoming: (m) => scene.applyIncoming(m) };
  }

  showWorldMap(cb: WorldMapCallbacks): WorldMapView {
    this.leaveLobby();
    const scene = new WorldMapScene(this.layout, this.input, cb);
    // Entering the SLG is one of the handful of transitions that cross-fade (see SceneManager).
    this.manager.goto(scene, { fade: true });
    return {
      applyMarchUpdate: (m) => scene.applyMarchUpdate(m),
      applyTileUpdate:  (tu) => scene.applyTileUpdate(tu),
      applyUnderAttack: (u) => scene.applyUnderAttack(u),
      applySiegeResult: (s) => scene.applySiegeResult(s),
    };
  }

  showFamily(cb: FamilySceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new FamilyScene(this.layout, this.input, cb));
  }

  showSect(cb: SectSceneCallbacks): SectSceneView {
    this.leaveLobby();
    const scene = new SectScene(this.layout, this.input, cb);
    this.manager.goto(scene);
    return scene;
  }

  showAuction(cb: AuctionSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new AuctionScene(this.layout, this.input, cb));
  }

  showDefenseEditor(cb: DefenseEditorCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new DefenseEditorScene(this.layout, this.input, cb));
  }

  showTeams(cb: TeamsCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new TeamsScene(this.layout, this.input, cb));
  }

  showCity(cb: CitySceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new CityScene(this.layout, this.input, cb));
  }

  showDeckBuilder(cb: DeckBuilderCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new DeckBuilderScene(this.layout, this.input, cb));
  }

  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView {
    this.leaveLobby();
    // The joiner (localSide 1) gets a 180°-flipped board with their own base /
    // hand / HUD at the bottom; the engine itself is fully owner-aware.
    const side = ownerToSide(localSide);
    const { width, height } = this.platform.getScreenSize();
    const netLayout = createLayout(width, height, side, this.platform.getSafeAreaInsets?.());
    const scene = new GameScene(netLayout, this.input, cb, opts);
    // Entering a match is one of the handful of transitions that cross-fade (see SceneManager).
    this.manager.goto(scene, { fade: true });
    return {
      applyNetState:  (s) => scene.applyNetState(s),
      applyPeerDc:    (p) => scene.applyPeerDc(p),
      applyMatchOver: (m) => scene.applyMatchOver(m),
    };
  }
}

export async function startApp(platform: IPlatform): Promise<void> {
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
  const layout: ILayout = createLayout(screenW, screenH, Side.Bottom, insets);
  const scaling = new ScalingManager(app, layout, insets);
  const input = new InputManager();
  // The manager freezes `input` for the span of each scene-fade: taps bypass Pixi (DOM-fed), so the
  // fade's cover can't block them, and a tap mid-fade would otherwise hit the outgoing scene's
  // still-live hit-rects. Only the explicitly-faded transitions (enter/exit match, enter/exit SLG)
  // ever engage this — plain instant scene switches never freeze input.
  const manager = new SceneManager(app, scaling.gameLayer, input);
  platform.setupInput(app, input, (sx, sy) => scaling.toDesignSpace(sx, sy));

  // ── L0 boot-tier preload gate (ASSET_PACKAGING §3) ──────────────────────────
  // Show a loading screen (top-most: built after all other layers) and await the
  // minimal asset set the first lobby + first battle need, so no unit ever renders
  // as a placeholder circle on the player's first match. The three battle/lobby
  // decor atlases (formerly fire-and-forget here) are part of this set now.
  // preloadBoot never rejects — a flaky asset advances progress and degrades
  // gracefully rather than wedging boot. On CrazyGames the SDK loading splash is
  // dismissed by onLoadingComplete() *after* this gate, so it covers our preload.
  const loading = new LoadingOverlay(app);
  await preloadBoot((done, total) => loading.setProgress(total ? done / total : 1));
  loading.destroy();

  platform.onAppReady();
  await platform.onLoadingComplete();

  const views = new PixiAppViews(platform, app, scaling, manager, input, layout);
  const core = createAppCore(platform, views);
  views.onResized = () => core.onResized();
  core.start();
}
