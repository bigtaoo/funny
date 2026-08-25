// The PIXI implementation of AppViews, extracted out of app.ts (2026-08-17) — app.ts had grown to
// 623 lines and was really two independent things: this ~35-method screen-intent facade, and the
// startApp() boot sequence (PIXI runtime + watchdogs + asset gate + stage-level dialogs) that
// constructs it. The seam is between those two, NOT inside the forward list (splitting the
// `showX(cb) { manager.goto(new XxxScene(cb)) }` list further would only fragment it — that part of
// the old baseline exception still holds). Nothing is shared between the two halves except the five
// runtime handles passed to the constructor, so this is a plain form② extraction.

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from '../platform/IPlatform';
import { recordConstructSample } from '../net/anomaly';
import { SceneManager, type Scene } from '../scenes/SceneManager';
import { IntroScene } from '../scenes/IntroScene';
import { IllustratedInterludeScene } from '../scenes/IllustratedInterludeScene';
import { LobbyScene, type LobbySceneCallbacks } from '../scenes/LobbyScene';
import { GameScene, type GameSceneCallbacks, type GameSceneOptions } from '../scenes/GameScene';
import { RoomScene, type RoomSceneCallbacks } from '../scenes/RoomScene';
import { FriendsScene, type FriendsSceneCallbacks } from '../scenes/FriendsScene';
import { ChatScene, type ChatSceneCallbacks } from '../scenes/ChatScene';
import { ShopScene, type ShopSceneCallbacks } from '../scenes/ShopScene';
import { GachaScene, type GachaSceneCallbacks } from '../scenes/GachaScene';
import { LoginScene, type LoginSceneCallbacks } from '../scenes/LoginScene';
import { ResultScene } from '../scenes/ResultScene';
import { ReplayScene, type ReplaySceneCallbacks } from '../scenes/ReplayScene';
import { StatePlayerScene, type StatePlayerSceneCallbacks } from '../scenes/StatePlayerScene';
import type { StateReplay, EncodedStateReplay } from '../game/replay/StateReplay';
import { SettingsScene, type SettingsSceneCallbacks } from '../scenes/SettingsScene';
import { CampaignMapScene, type CampaignMapCallbacks } from '../scenes/CampaignMapScene';
import { LevelPrepScene, type LevelPrepCallbacks } from '../scenes/LevelPrepScene';
import { CardCodexScene, type CardCodexCallbacks } from '../scenes/CardCodexScene';
import { CardScene, type CardCallbacks, type CardRosterView } from '../scenes/CardScene';
import { EquipmentScene, type EquipmentCallbacks } from '../scenes/EquipmentScene';
import { StatsScene, type StatsCallbacks } from '../scenes/StatsScene';
import { AchievementScene, type AchievementCallbacks } from '../scenes/AchievementScene';
import { LeaderboardScene, type LeaderboardCallbacks } from '../scenes/LeaderboardScene';
import { BattlePassScene, type BattlePassCallbacks } from '../scenes/BattlePassScene';
import { RechargeScene, type RechargeCallbacks } from '../scenes/RechargeScene';
import { TitlesScene, type TitlesSceneCallbacks } from '../scenes/TitlesScene';
import { WorldMapScene, type WorldMapCallbacks, type WorldMapView } from '../scenes/WorldMapScene';
import { FamilyScene, type FamilySceneCallbacks, type FamilySceneView } from '../scenes/FamilyScene';
import { SectScene, type SectSceneCallbacks, type SectSceneView } from '../scenes/SectScene';
import { AuctionScene, type AuctionSceneCallbacks } from '../scenes/AuctionScene';
import { DefenseEditorScene, type DefenseEditorCallbacks } from '../scenes/DefenseEditorScene';
import { DeckBuilderScene, type DeckBuilderCallbacks } from '../scenes/DeckBuilderScene';
import { CityScene, type CitySceneCallbacks } from '../scenes/CityScene';
import { DailyScene, type DailyCallbacks } from '../scenes/DailyScene';
import { EventScene, type EventCallbacks } from '../scenes/EventScene';
import { ConsentDialog, type ConsentCallbacks } from '../ui/dialogs/ConsentDialog';
import { ReconnectPromptDialog, type ReconnectPromptCallbacks } from '../ui/dialogs/ReconnectPromptDialog';
import { OwnerId, ownerToSide, Side } from '../game';
import type { Replay, LevelDefinition } from '../game';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ScalingManager, createLayout } from '../layout/ScalingManager';
import { InputManager } from '../inputSystem/InputManager';
import type { ILayout } from '../layout/ILayout';
import { enterBattle, DeferredSceneCalls } from './battleGate';
import { enterWithAssets } from './assetGate';
import { preloadGachaTextures } from '../render/gachaArt';
import type { AppViews, LobbyView, RoomView, FriendsView, ChatView, NetGameView, ResultViewProps, FadeOpts, MountOpts } from './AppViews';

/**
 * The PIXI implementation of AppViews: each show*() runs the same
 * `manager.goto(new XxxScene(...))` the old startApp() did. Owns the layout +
 * the lobby-only resize listener (kept out of the core).
 */
export class PixiAppViews implements AppViews {
  private layout: ILayout;
  /** Set by the shell to core.onResized(); fired after a lobby resize re-renders. */
  onResized: (() => void) | null = null;

  /** True only while an onResize()-driven lobby rebuild is in flight, so that rebuild swaps instantly (no fade). */
  private resizing = false;

  /** Last size actually applied, so a resize event that reports no change can be dropped outright.
   *  Seeded from the live screen in the constructor rather than left at 0: the boot size IS an
   *  applied size, and starting at 0 would wave the first no-op resize event straight through. */
  private appliedW: number;
  private appliedH: number;

  /** Pending trailing rebuild (see onResize). Cleared by leaveLobby so it can never land off-lobby. */
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalescing window for the lobby rebuild. One physical device rotation fires `resize` repeatedly
   * over roughly a quarter second (iOS reports the viewport progressively *through* the rotation
   * animation), and the pre-2026-08-24 handler ran a full teardown-and-rebuild of the lobby on every
   * one of them. Long enough to swallow a whole rotation; short enough to be imperceptible when a
   * desktop user drags a window edge.
   */
  private static readonly REBUILD_COALESCE_MS = 180;

  /**
   * Viewport changed: re-fit the canvas now, rebuild the lobby once things settle.
   *
   * The split matters. Re-fitting (renderer.resize + layout + scaling) is cheap and must be immediate
   * or the canvas visibly lags the viewport; rebuilding the lobby allocates a whole scene graph and is
   * the expensive half. Previously both ran synchronously on every event, so a single rotation cost N
   * full scene rebuilds — N rounds of texture churn at the exact moment a mobile WebView is already
   * paying for a drawing-buffer reallocation, and on a memory-capped in-app WebView that is a plausible
   * way to get the renderer process killed outright rather than merely made slow.
   *
   * The no-change guard in front is worth as much again: mobile browsers fire `resize` for things that
   * are not resizes at all (chrome bars sliding, the on-screen keyboard, scroll-driven toolbar hiding),
   * and each of those used to rebuild the lobby for nothing.
   */
  private readonly onResize = (): void => {
    const { width, height } = this.platform.getScreenSize();
    if (width === this.appliedW && height === this.appliedH) return;
    this.appliedW = width;
    this.appliedH = height;

    const insets = this.platform.getSafeAreaInsets?.();
    this.app.renderer.resize(width, height);
    this.layout = createLayout(width, height, Side.Bottom, insets);
    this.scaling.resize(width, height, this.layout, insets);

    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.resizing = true;
      try {
        this.onResized?.(); // synchronously rebuilds the lobby via showLobby()
      } finally {
        this.resizing = false;
      }
    }, PixiAppViews.REBUILD_COALESCE_MS);
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
    const { width, height } = platform.getScreenSize();
    this.appliedW = width;
    this.appliedH = height;
  }

  /**
   * Detach the lobby resize listener — every non-lobby screen calls this first.
   *
   * Cancelling the pending rebuild is load-bearing now that it is deferred: a rotation immediately
   * followed by a tap into another screen would otherwise leave a queued showLobby() that fires
   * ~180ms later and yanks the player back to the lobby from wherever they had just navigated to.
   */
  private leaveLobby(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
  }

  /**
   * Times a scene constructor and reports it to net/anomaly if it ran long enough to plausibly
   * BE a prod ANR (see recordConstructSample) — this is the only vantage point that can see scene
   * construction, since it happens before the scene is ever mounted/ticked by SceneManager.
   */
  private timedBuild<T extends Scene>(name: string, build: () => T): T {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const scene = build();
    const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    recordConstructSample(name, dt);
    return scene;
  }


  showIntro(cb: Parameters<AppViews['showIntro']>[0]): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('IntroScene', () => new IntroScene(this.layout, this.input, cb)));
  }

  showRealLayerInterlude(
    illustrationUrl: string,
    textKey: Parameters<AppViews['showRealLayerInterlude']>[1],
    cb: Parameters<AppViews['showRealLayerInterlude']>[2],
  ): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild(
      'IllustratedInterludeScene',
      () => new IllustratedInterludeScene(this.layout, this.input, illustrationUrl, textKey, cb),
    ));
  }

  showConsent(cb: ConsentCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('ConsentDialog', () => new ConsentDialog(this.layout.designWidth, this.layout.designHeight, cb)));
  }

  showReconnectPrompt(cb: ReconnectPromptCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('ReconnectPromptDialog', () => new ReconnectPromptDialog(this.layout.designWidth, this.layout.designHeight, cb)));
  }

  showLobby(cb: LobbySceneCallbacks, opts?: FadeOpts): LobbyView {
    const scene = this.timedBuild('LobbyScene', () => new LobbyScene(this.layout, this.input, cb));
    // A resize-driven rebuild always swaps instantly, regardless of the caller's fade request.
    this.manager.goto(scene, { fade: !this.resizing && !!opts?.fade });
    window.addEventListener('resize', this.onResize);
    return {
      applySocialBadge: (n, mail) => scene.applySocialBadge(n, mail),
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
    this.manager.goto(this.timedBuild('SettingsScene', () => new SettingsScene(this.layout, this.input, cb)));
  }

  showLogin(cb: LoginSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('LoginScene', () => new LoginScene(this.layout, this.input, cb)));
  }

  showShop(cb: ShopSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('ShopScene', () => new ShopScene(this.layout, this.input, cb)));
  }

  /**
   * Gated on the gacha PNG set (ASSET_PACKAGING §10, extended to gacha 2026-08-25). §10 closed the
   * "进场才发现没资源" gap for battles only; gacha kept a fire-and-forget `void preloadGachaTextures()`
   * inside the scene, and `gachaArt` hands out `PIXI.Texture.from(url)` — an empty texture on a cold
   * cache. PIXI's Sprite re-derives scale when the texture finally decodes, so the layout survives,
   * but the card backs and frames pop in blank-then-filled during the single most staged moment in
   * the game. `idlePrefetch` makes that rare rather than impossible: gacha is deliberately its LAST
   * wave (biggest, least likely), so a player who taps 抽卡 in the first seconds still races it, and
   * a metered/save-data link skips prefetch entirely.
   *
   * No cross-fade: the menu screens switch instantly, and `enterWithAssets` releases the input
   * freeze itself on that path.
   */
  showGacha(cb: GachaSceneCallbacks): void {
    this.leaveLobby();
    void enterWithAssets(
      { app: this.app, manager: this.manager, input: this.input },
      (onProgress) => preloadGachaTextures(onProgress),
      () => this.timedBuild('GachaScene', () => new GachaScene(this.layout, this.input, cb)),
    );
  }

  showCampaignMap(cb: CampaignMapCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('CampaignMapScene', () => new CampaignMapScene(this.layout, this.input, cb)));
  }

  showLevelPrep(cb: LevelPrepCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('LevelPrepScene', () => new LevelPrepScene(this.layout, this.input, cb)));
  }

  showCardCodex(cb: CardCodexCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('CardCodexScene', () => new CardCodexScene(this.layout, this.input, cb)));
  }

  showCardRoster(cb: CardCallbacks): CardRosterView {
    this.leaveLobby();
    const scene = this.timedBuild('CardScene', () => new CardScene(this.layout, this.input, cb));
    this.manager.goto(scene);
    return {
      applyCardState: () => scene.applyCardState(),
      showTab: (tab) => scene.showTab(tab),
    };
  }

  /**
   * `opts.overlay` mounts the equipment screen on top of the still-live CardScene (`pushOverlay`)
   * instead of replacing it, so gear editing never rebuilds the roster (ADR-072) — same arrangement
   * mountSlg gives the SLG panels over the world map. Overlay mounts are only reached from inside the
   * roster, which already left the lobby, so `leaveLobby` is skipped there (as it is for mountSlg).
   */
  showEquipment(cb: EquipmentCallbacks, opts?: MountOpts): void {
    const scene = this.timedBuild('EquipmentScene', () => new EquipmentScene(this.layout, this.input, cb));
    if (opts?.overlay) { this.manager.pushOverlay(scene); return; }
    this.leaveLobby();
    this.manager.goto(scene);
  }

  showStats(cb: StatsCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('StatsScene', () => new StatsScene(this.layout, this.input, cb)));
  }

  showAchievements(cb: AchievementCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('AchievementScene', () => new AchievementScene(this.layout, this.input, cb)));
  }

  showLeaderboard(cb: LeaderboardCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('LeaderboardScene', () => new LeaderboardScene(this.layout, this.input, cb)));
  }

  showBattlePass(cb: BattlePassCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('BattlePassScene', () => new BattlePassScene(this.layout, this.input, cb)));
  }

  showRecharge(cb: RechargeCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('RechargeScene', () => new RechargeScene(this.layout, this.input, cb)));
  }

  showTitles(cb: TitlesSceneCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('TitlesScene', () => new TitlesScene(this.layout, this.input, cb)));
  }

  showDaily(cb: DailyCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('DailyScene', () => new DailyScene(this.layout, this.input, cb)));
  }

  showEvents(cb: EventCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('EventScene', () => new EventScene(this.layout, this.input, cb)));
  }

  showReplay(
    replay: Replay, cb: ReplaySceneCallbacks, level?: LevelDefinition, equippedSkins?: readonly string[],
    cardInstances?: EngineCardInstance[], equipmentInv?: EngineEquipInv,
    siegeAcademy?: { hp: number; damage: number; siege: number },
  ): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('ReplayScene', () => new ReplayScene(
      this.layout, this.input, replay, cb, level, equippedSkins, cardInstances, equipmentInv, siegeAcademy,
    )));
  }

  showStatePlayer(replay: StateReplay, cb: StatePlayerSceneCallbacks, encoded?: EncodedStateReplay): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('StatePlayerScene', () => new StatePlayerScene(this.layout, replay, cb, encoded)));
  }

  showResult(props: ResultViewProps): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('ResultScene', () => new ResultScene(
      this.layout.designWidth,
      this.layout.designHeight,
      props.winner,
      props.stats,
      props.cb,
      props.localOwner,
      props.elo,
      props.profiles,
      props.outroTexts,
    )));
  }

  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void {
    this.leaveLobby();
    // Entering a match is one of the handful of transitions that cross-fade (see SceneManager);
    // enterBattle gates that fade behind the L1 asset-readiness loading screen (ASSET_PACKAGING §10).
    void enterBattle(
      { app: this.app, manager: this.manager, input: this.input },
      opts,
      () => this.timedBuild('GameScene', () => new GameScene(this.layout, this.input, cb, opts)),
    );
  }

  showRoom(cb: RoomSceneCallbacks): RoomView {
    this.leaveLobby();
    const scene = this.timedBuild('RoomScene', () => new RoomScene(this.layout, this.input, cb));
    this.manager.goto(scene);
    return {
      applyRoomState: (s) => scene.applyRoomState(s),
      applyRoomError: (e) => scene.applyRoomError(e),
      applyPeerDc:    (p) => scene.applyPeerDc(p),
      applyNetState:  (s) => scene.applyNetState(s),
    };
  }

  showFriends(cb: FriendsSceneCallbacks, opts?: MountOpts): FriendsView {
    const scene = this.mountSlg('FriendsScene', () => new FriendsScene(this.layout, this.input, cb), opts);
    return {
      applyFriendPresence: (p) => scene.applyFriendPresence(p),
      applyFriendRequest:  (r) => scene.applyFriendRequest(r),
      applyFriendUpdate:   (u) => scene.applyFriendUpdate(u),
      applyChatMessage:    (m) => scene.applyChatMessage(m),
      applyMailNew:        (m) => scene.applyMailNew(m),
      applyDuelInvited:    (d) => scene.applyDuelInvited(d),
      applyDuelCancelled:  (d) => scene.applyDuelCancelled(d),
    };
  }

  showChat(cb: ChatSceneCallbacks, opts?: MountOpts): ChatView {
    const scene = this.mountSlg('ChatScene', () => new ChatScene(this.layout, this.input, cb), opts);
    return { applyIncoming: (m) => scene.applyIncoming(m) };
  }

  showWorldMap(cb: WorldMapCallbacks): WorldMapView {
    this.leaveLobby();
    const scene = this.timedBuild('WorldMapScene', () => new WorldMapScene(this.layout, this.input, cb));
    // Entering the SLG is one of the handful of transitions that cross-fade (see SceneManager).
    this.manager.goto(scene, { fade: true });
    return {
      applyMarchUpdate: (m) => scene.applyMarchUpdate(m),
      applyTileUpdate:  (tu) => scene.applyTileUpdate(tu),
      applyUnderAttack: (u) => scene.applyUnderAttack(u),
      applySiegeResult: (s) => scene.applySiegeResult(s),
      applyNationMsg:   (n) => scene.applyNationMsg(n),
      refreshMe:        () => scene.refreshMe(),
    };
  }

  /**
   * Mount an SLG panel either as a full-scene swap (`goto`) or, when `opts.overlay` is set, as an
   * overlay on top of the still-live WorldMapScene (`pushOverlay`) so the map never rebuilds (ADR-044).
   * Overlay mounts are always reached from within the SLG, so there is no lobby resize listener to
   * detach — `leaveLobby` is skipped there.
   */
  private mountSlg<T extends Scene>(name: string, build: () => T, opts?: MountOpts): T {
    const scene = this.timedBuild(name, build);
    if (opts?.overlay) this.manager.pushOverlay(scene);
    else { this.leaveLobby(); this.manager.goto(scene); }
    return scene;
  }

  showFamily(cb: FamilySceneCallbacks, opts?: MountOpts): FamilySceneView {
    return this.mountSlg('FamilyScene', () => new FamilyScene(this.layout, this.input, cb), opts);
  }

  showSect(cb: SectSceneCallbacks, opts?: MountOpts): SectSceneView {
    return this.mountSlg('SectScene', () => new SectScene(this.layout, this.input, cb), opts);
  }

  showAuction(cb: AuctionSceneCallbacks, opts?: MountOpts): void {
    this.mountSlg('AuctionScene', () => new AuctionScene(this.layout, this.input, cb), opts);
  }

  showDefenseEditor(cb: DefenseEditorCallbacks, opts?: MountOpts): void {
    this.mountSlg('DefenseEditorScene', () => new DefenseEditorScene(this.layout, this.input, cb), opts);
  }

  showCity(cb: CitySceneCallbacks, opts?: MountOpts): void {
    this.mountSlg('CityScene', () => new CityScene(this.layout, this.input, cb), opts);
  }

  hideOverlay(): void {
    this.manager.popOverlay();
  }

  showDeckBuilder(cb: DeckBuilderCallbacks): void {
    this.leaveLobby();
    this.manager.goto(this.timedBuild('DeckBuilderScene', () => new DeckBuilderScene(this.layout, this.input, cb)));
  }

  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView {
    this.leaveLobby();
    // The joiner (localSide 1) gets a 180°-flipped board with their own base /
    // hand / HUD at the bottom; the engine itself is fully owner-aware.
    const side = ownerToSide(localSide);
    const { width, height } = this.platform.getScreenSize();
    const netLayout = createLayout(width, height, side, this.platform.getSafeAreaInsets?.());
    // enterBattle is async (asset-readiness gate, ASSET_PACKAGING §10) but the caller (nav/result.ts)
    // needs a NetGameView synchronously to wire up session.handlers right away — a server push
    // (net_state/peer_dc/match_over) can legitimately arrive while the loading screen is still up
    // (the socket is already live), so DeferredSceneCalls buffers those until the scene actually
    // exists, then flushes in order. GameScene's own destroyed-guard covers the symmetric case
    // (push arriving after the scene is torn down); this covers the "before it's built yet" case.
    const deferred = new DeferredSceneCalls<GameScene>();
    // Entering a match is one of the handful of transitions that cross-fade (see SceneManager).
    void enterBattle(
      { app: this.app, manager: this.manager, input: this.input },
      opts,
      () => this.timedBuild('GameScene', () => new GameScene(netLayout, this.input, cb, opts)),
    ).then((s) => deferred.resolve(s));
    return {
      applyNetState:  (s) => deferred.call((sc) => sc.applyNetState(s)),
      applyPeerDc:    (p) => deferred.call((sc) => sc.applyPeerDc(p)),
      applyMatchOver: (m) => deferred.call((sc) => sc.applyMatchOver(m)),
    };
  }
}
