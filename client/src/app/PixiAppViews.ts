// The PIXI implementation of AppViews, extracted out of app.ts (2026-08-17) — app.ts had grown to
// 623 lines and was really two independent things: this ~35-method screen-intent facade, and the
// startApp() boot sequence (PIXI runtime + watchdogs + asset gate + stage-level dialogs) that
// constructs it. The seam is between those two, NOT inside the forward list (splitting the
// `showX(cb) { manager.goto(new XxxScene(cb)) }` list further would only fragment it — that part of
// the old baseline exception still holds). Nothing is shared between the two halves except the five
// runtime handles passed to the constructor, so this is a plain form② extraction.
//
// The same seam applied a second time on 2026-09-08, when ADR-083's paint-gate wiring pushed this
// file back over 500: the lobby's window-resize handling — a listener, a coalescing timer and the
// applied-size guard, sharing nothing with the forward list but the current layout — moved to
// `app/viewportResize.ts`. What is left here is the forward list plus the field the list itself
// reads (`layout`).
//
// The same seam, one step further in, on 2026-09-14: making a rotation re-lay-out EVERY rebuildable
// screen rather than only the lobby added the bookkeeping for "which screen is on, and how do we put
// it back" — a lifetime of its own, sharing nothing with the forward list but the SceneManager
// handle. That is `app/sceneMounts.ts`, and its header is where the rebuild policy is written down.
// Here, each `showX` only picks which of `mounts.mount` (rebuildable) / `mounts.volatile` (not) /
// `mounts.lobby` it hands its constructor to.

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from '../platform/IPlatform';
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
import { ConsentDialog, type ConsentCallbacks, type ConsentMode } from '../ui/dialogs/ConsentDialog';
import { AgeGateDialog, type AgeGateCallbacks, type AgeGateMode } from '../ui/dialogs/AgeGateDialog';
import { EntryGateDialog, type EntryGateCallbacks, type EntryGateMode } from '../ui/dialogs/EntryGateDialog';
import { ReconnectPromptDialog, type ReconnectPromptCallbacks } from '../ui/dialogs/ReconnectPromptDialog';
import { OwnerId, ownerToSide } from '../game';
import type { Replay, LevelDefinition } from '../game';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ScalingManager, createLayout } from '../layout/ScalingManager';
import { InputManager } from '../inputSystem/InputManager';
import type { ILayout } from '../layout/ILayout';
import { enterBattle, DeferredSceneCalls } from './battleGate';
import { enterWithAssets } from './assetGate';
import { ViewportResizer } from './viewportResize';
import { SceneMounts } from './sceneMounts';
import { preloadGachaTextures } from '../render/gachaArt';
import { markFeatureUsed } from '../assets/prefetchPolicy';
import type { AppViews, LobbyView, RoomView, FriendsView, ChatView, NetGameView, ResultViewProps, FadeOpts, MountOpts } from './AppViews';

/**
 * The PIXI implementation of AppViews: each show*() runs the same
 * `manager.goto(new XxxScene(...))` the old startApp() did. Owns the layout; hands every mount to
 * `SceneMounts`, which decides what a viewport change does to it.
 */
export class PixiAppViews implements AppViews {
  private layout: ILayout;
  /** Set by the shell to core.onResized(); fired after a lobby resize re-renders. */
  onResized: (() => void) | null = null;

  /** The viewport watcher (app/viewportResize.ts). Installed for the whole app lifetime; it only
   *  reports that the viewport settled — what that rebuilds is `mounts`' call. */
  private readonly viewport: ViewportResizer;

  /** Current screen + rebuild policy (app/sceneMounts.ts). */
  private readonly mounts: SceneMounts;

  constructor(
    private readonly platform: IPlatform,
    private readonly app: PIXI.Application,
    private readonly scaling: ScalingManager,
    private readonly manager: SceneManager,
    private readonly input: InputManager,
    layout: ILayout,
  ) {
    this.layout = layout;
    this.mounts = new SceneMounts(manager, () => this.onResized?.()); // → nav.goLobby → showLobby()
    this.viewport = new ViewportResizer(
      platform, app, scaling,
      (next) => { this.layout = next; },
      () => this.mounts.viewportSettled(),
    );
    // Installed here, not in showLobby(): every screen needs the canvas to track the window, and
    // attaching it to the lobby's lifetime is what left rotation and late safe-area insets
    // unhandled on the login screen, the settings screen and inside a whole battle.
    this.viewport.install();
  }


  showIntro(cb: Parameters<AppViews['showIntro']>[0]): void {
    this.mounts.volatile('IntroScene', () => new IntroScene(this.layout, this.input, cb));
  }

  showRealLayerInterlude(
    illustrationUrl: string,
    textKey: Parameters<AppViews['showRealLayerInterlude']>[1],
    cb: Parameters<AppViews['showRealLayerInterlude']>[2],
  ): void {
    this.mounts.volatile(
      'IllustratedInterludeScene',
      () => new IllustratedInterludeScene(this.layout, this.input, illustrationUrl, textKey, cb),
    );
  }

  showConsent(mode: ConsentMode, cb: ConsentCallbacks): void {
    this.mounts.mount('ConsentDialog', () =>
      new ConsentDialog(this.layout.designWidth, this.layout.designHeight, cb, mode));
  }

  showAgeGate(mode: AgeGateMode, cb: AgeGateCallbacks): void {
    this.mounts.mount('AgeGateDialog', () =>
      new AgeGateDialog(this.layout.designWidth, this.layout.designHeight, mode, cb));
  }

  showEntryGate(mode: EntryGateMode, cb: EntryGateCallbacks): void {
    this.mounts.mount('EntryGateDialog', () =>
      new EntryGateDialog(this.layout.designWidth, this.layout.designHeight, mode, cb));
  }

  showReconnectPrompt(cb: ReconnectPromptCallbacks): void {
    this.mounts.mount('ReconnectPromptDialog', () => new ReconnectPromptDialog(this.layout.designWidth, this.layout.designHeight, cb));
  }

  showLobby(cb: LobbySceneCallbacks, opts?: FadeOpts): LobbyView {
    // `mounts.lobby`, not `mounts.mount`: nav/lobby.ts re-derives the lobby's callbacks (badges,
    // season settlement, entitlements) from save/session state on every entry, so a resize goes back
    // out through the app core with `fromResize` set instead of replaying these same callbacks.
    const scene = this.mounts.lobby('LobbyScene', () => new LobbyScene(this.layout, this.input, cb), opts);
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
      showConsumptionConsent: (onAnswer) => scene.showConsumptionConsent(onAnswer),
    };
  }

  showSettings(cb: SettingsSceneCallbacks): void {
    this.mounts.mount('SettingsScene', () => new SettingsScene(this.layout, this.input, cb));
  }

  showLogin(cb: LoginSceneCallbacks): void {
    this.mounts.mount('LoginScene', () => new LoginScene(this.layout, this.input, cb));
  }

  showShop(cb: ShopSceneCallbacks): void {
    this.mounts.mount('ShopScene', () => new ShopScene(this.layout, this.input, cb));
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
    const gen = this.mounts.takeScreen();
    // Same reasoning as WorldMapRenderer's `markFeatureUsed('world')`: the gate below is this
    // feature's asset-demand site, so it is where "this player pulls" becomes true and the wave
    // becomes worth warming next session (ASSET_PACKAGING §14).
    markFeatureUsed('gacha');
    const build = (): GachaScene => this.mounts.timedBuild('GachaScene', () => new GachaScene(this.layout, this.input, cb));
    void enterWithAssets(
      { app: this.app, manager: this.manager, input: this.input },
      (onProgress) => preloadGachaTextures(onProgress),
      build,
    ).then(() => {
      // Armed only once the gate is through (armRespawn drops it if the player has moved on):
      // rebuilding mid-gate would drop a GachaScene on top of the loading overlay the gate is about
      // to replace anyway, and the textures are warm by now, so the rebuild skips the gate entirely.
      this.mounts.armRespawn(gen, () => { this.manager.goto(build(), { fade: false }); });
    });
  }

  showCampaignMap(cb: CampaignMapCallbacks): void {
    this.mounts.mount('CampaignMapScene', () => new CampaignMapScene(this.layout, this.input, cb));
  }

  showLevelPrep(cb: LevelPrepCallbacks): void {
    this.mounts.mount('LevelPrepScene', () => new LevelPrepScene(this.layout, this.input, cb));
  }

  showCardCodex(cb: CardCodexCallbacks): void {
    this.mounts.mount('CardCodexScene', () => new CardCodexScene(this.layout, this.input, cb));
  }

  showCardRoster(cb: CardCallbacks): CardRosterView {
    // Read through the getter, not a captured instance: nav/game/campaignRoster.ts keeps this view
    // and calls applyCardState() long after the mount, by which point a rotation may have swapped
    // the scene underneath it.
    const live = this.mounts.mount('CardScene', () => new CardScene(this.layout, this.input, cb));
    return {
      applyCardState: () => live().applyCardState(),
      showTab: (tab) => live().showTab(tab),
    };
  }

  /**
   * `opts.overlay` mounts the equipment screen on top of the still-live CardScene (`pushOverlay`)
   * instead of replacing it, so gear editing never rebuilds the roster (ADR-072) — same arrangement
   * mountSlg gives the SLG panels over the world map. Overlay mounts are only reached from inside the
   * roster, which already owns the screen, so they leave `lobbyActive` alone (as mountSlg does) and
   * merely park the host's respawn until {@link hideOverlay} (as ADR-072's whole point is that the
   * roster underneath must survive — including a rotation, which would otherwise rebuild it out from
   * under this panel).
   */
  showEquipment(cb: EquipmentCallbacks, opts?: MountOpts): void {
    if (opts?.overlay) {
      this.mounts.overlay(this.mounts.timedBuild('EquipmentScene', () => new EquipmentScene(this.layout, this.input, cb)));
      return;
    }
    this.mounts.mount('EquipmentScene', () => new EquipmentScene(this.layout, this.input, cb));
  }

  showStats(cb: StatsCallbacks): void {
    this.mounts.mount('StatsScene', () => new StatsScene(this.layout, this.input, cb));
  }

  showAchievements(cb: AchievementCallbacks): void {
    this.mounts.mount('AchievementScene', () => new AchievementScene(this.layout, this.input, cb));
  }

  showLeaderboard(cb: LeaderboardCallbacks): void {
    this.mounts.mount('LeaderboardScene', () => new LeaderboardScene(this.layout, this.input, cb));
  }

  showBattlePass(cb: BattlePassCallbacks): void {
    this.mounts.mount('BattlePassScene', () => new BattlePassScene(this.layout, this.input, cb));
  }

  showRecharge(cb: RechargeCallbacks): void {
    this.mounts.mount('RechargeScene', () => new RechargeScene(this.layout, this.input, cb));
  }

  showTitles(cb: TitlesSceneCallbacks): void {
    this.mounts.mount('TitlesScene', () => new TitlesScene(this.layout, this.input, cb));
  }

  showDaily(cb: DailyCallbacks): void {
    this.mounts.mount('DailyScene', () => new DailyScene(this.layout, this.input, cb));
  }

  showEvents(cb: EventCallbacks): void {
    this.mounts.mount('EventScene', () => new EventScene(this.layout, this.input, cb));
  }

  showReplay(
    replay: Replay, cb: ReplaySceneCallbacks, level?: LevelDefinition, equippedSkins?: readonly string[],
    cardInstances?: EngineCardInstance[], equipmentInv?: EngineEquipInv,
    siegeAcademy?: { hp: number; damage: number; siege: number },
  ): void {
    this.mounts.volatile('ReplayScene', () => new ReplayScene(
      this.layout, this.input, replay, cb, level, equippedSkins, cardInstances, equipmentInv, siegeAcademy,
    ));
  }

  showStatePlayer(replay: StateReplay, cb: StatePlayerSceneCallbacks, encoded?: EncodedStateReplay): void {
    this.mounts.volatile('StatePlayerScene', () => new StatePlayerScene(this.layout, replay, cb, encoded));
  }

  showResult(props: ResultViewProps): void {
    this.mounts.mount('ResultScene', () => new ResultScene(
      this.layout.designWidth,
      this.layout.designHeight,
      props.winner,
      props.stats,
      props.cb,
      props.localOwner,
      props.elo,
      props.profiles,
      props.outroTexts,
      props.retentionPreview,
    ));
  }

  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void {
    this.mounts.takeScreen(); // a match is never rebuilt — see SceneMounts' volatile() list
    // Entering a match is one of the handful of transitions that cross-fade (see SceneManager);
    // enterBattle gates that fade behind the L1 asset-readiness loading screen (ASSET_PACKAGING §10).
    void enterBattle(
      { app: this.app, manager: this.manager, input: this.input },
      opts,
      () => this.mounts.timedBuild('GameScene', () => new GameScene(this.layout, this.input, cb, opts)),
    );
  }

  showRoom(cb: RoomSceneCallbacks): RoomView {
    // Volatile: everything the room shows — the peer list, the ready flags — arrives only as server
    // pushes, so a rebuilt RoomScene would sit empty until the next one.
    this.mounts.takeScreen();
    const scene = this.mounts.timedBuild('RoomScene', () => new RoomScene(this.layout, this.input, cb));
    this.manager.goto(scene);
    return {
      applyRoomState: (s) => scene.applyRoomState(s),
      applyRoomError: (e) => scene.applyRoomError(e),
      applyPeerDc:    (p) => scene.applyPeerDc(p),
      applyNetState:  (s) => scene.applyNetState(s),
    };
  }

  showFriends(cb: FriendsSceneCallbacks, opts?: MountOpts): FriendsView {
    const live = this.mountSlg('FriendsScene', () => new FriendsScene(this.layout, this.input, cb), opts);
    return {
      applyFriendPresence: (p) => live().applyFriendPresence(p),
      applyFriendRequest:  (r) => live().applyFriendRequest(r),
      applyFriendUpdate:   (u) => live().applyFriendUpdate(u),
      applyChatMessage:    (m) => live().applyChatMessage(m),
      applyMailNew:        (m) => live().applyMailNew(m),
      applyDuelInvited:    (d) => live().applyDuelInvited(d),
      applyDuelCancelled:  (d) => live().applyDuelCancelled(d),
    };
  }

  showChat(cb: ChatSceneCallbacks, opts?: MountOpts): ChatView {
    const live = this.mountSlg('ChatScene', () => new ChatScene(this.layout, this.input, cb), opts);
    return { applyIncoming: (m) => live().applyIncoming(m) };
  }

  /**
   * Volatile (see SceneMounts): the map owns a camera the player has panned and zoomed, a
   * tile cache and a set of live worldsvc subscriptions, none of which a fresh constructor can put
   * back. Rotating on the map therefore still leaves it laid out for the orientation it was entered
   * in — the one screen where that gap is deliberate rather than incidental.
   */
  showWorldMap(cb: WorldMapCallbacks): WorldMapView {
    this.mounts.takeScreen();
    const scene = this.mounts.timedBuild('WorldMapScene', () => new WorldMapScene(this.layout, this.input, cb));
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
   * Overlay mounts are always reached from within the SLG, so they leave `lobbyActive` alone and are
   * never themselves rebuilt on a rotation — the map underneath them is `mountVolatile`, and
   * rebuilding the panel alone would drop it back onto a host laid out for the other orientation.
   *
   * Returns a getter for the live scene (see {@link mount}), since the full-screen path can swap it.
   */
  private mountSlg<T extends Scene>(name: string, build: () => T, opts?: MountOpts): () => T {
    if (opts?.overlay) {
      const scene = this.mounts.timedBuild(name, build);
      this.mounts.overlay(scene);
      return () => scene;
    }
    return this.mounts.mount(name, build);
  }

  showFamily(cb: FamilySceneCallbacks, opts?: MountOpts): FamilySceneView {
    // A forwarding handle rather than the scene itself: a rotation rebuilds the full-screen mount,
    // and nav/world.ts holds this view across live family-channel pushes. `getFamily()` answering
    // null again right after a rebuild only costs the next tab hop one re-fetch.
    const live = this.mountSlg('FamilyScene', () => new FamilyScene(this.layout, this.input, cb), opts);
    return {
      applyFamilyMsg: (m) => live().applyFamilyMsg(m),
      getFamily: () => live().getFamily(),
    };
  }

  showSect(cb: SectSceneCallbacks, opts?: MountOpts): SectSceneView {
    const live = this.mountSlg('SectScene', () => new SectScene(this.layout, this.input, cb), opts);
    return {
      applySectMsg: (m) => live().applySectMsg(m),
      getFamily: () => live().getFamily(),
      getSect: () => live().getSect(),
    };
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
    this.mounts.popOverlay();
  }

  showDeckBuilder(cb: DeckBuilderCallbacks): void {
    this.mounts.mount('DeckBuilderScene', () => new DeckBuilderScene(this.layout, this.input, cb));
  }

  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView {
    this.mounts.takeScreen(); // a match is never rebuilt — see SceneMounts' volatile() list
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
      () => this.mounts.timedBuild('GameScene', () => new GameScene(netLayout, this.input, cb, opts)),
    ).then((s) => deferred.resolve(s));
    return {
      applyNetState:  (s) => deferred.call((sc) => sc.applyNetState(s)),
      applyPeerDc:    (p) => deferred.call((sc) => sc.applyPeerDc(p)),
      applyMatchOver: (m) => deferred.call((sc) => sc.applyMatchOver(m)),
    };
  }
}
