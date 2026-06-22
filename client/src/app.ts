// Thin PIXI shell. All orchestration / navigation / port-calling logic lives in
// the render-free createAppCore (app/createAppCore.ts); this file only builds the
// PIXI runtime and the PixiAppViews that turns the core's screen intents into
// `manager.goto(new XxxScene(...))`. The full-link E2E harness swaps PixiAppViews
// for a HeadlessAppViews and drives the same core without rendering.

import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
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
import { SettingsScene, type SettingsSceneCallbacks } from './scenes/SettingsScene';
import { CampaignMapScene, type CampaignMapCallbacks } from './scenes/CampaignMapScene';
import { LevelPrepScene, type LevelPrepCallbacks } from './scenes/LevelPrepScene';
import { CollectionScene, type CollectionCallbacks } from './scenes/CollectionScene';
import { EquipmentScene, type EquipmentCallbacks } from './scenes/EquipmentScene';
import { StatsScene, type StatsCallbacks } from './scenes/StatsScene';
import { AchievementScene, type AchievementCallbacks } from './scenes/AchievementScene';
import { WorldMapScene, type WorldMapCallbacks, type WorldMapView } from './scenes/WorldMapScene';
import { FamilyScene, type FamilySceneCallbacks } from './scenes/FamilyScene';
import { SectScene, type SectSceneCallbacks, type SectSceneView } from './scenes/SectScene';
import { AuctionScene, type AuctionSceneCallbacks } from './scenes/AuctionScene';
import { DefenseEditorScene, type DefenseEditorCallbacks } from './scenes/DefenseEditorScene';
import { TeamsScene, type TeamsCallbacks } from './scenes/TeamsScene';
import { OwnerId, ownerToSide } from './game';
import type { Replay, LevelDefinition } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { installGlobalErrorHandlers } from './net/log';
import { setBakeRenderer } from './render/bake';
import { createAppCore } from './app/createAppCore';
import type { AppViews, LobbyView, RoomView, FriendsView, ChatView, NetGameView, ResultViewProps } from './app/AppViews';

/**
 * The PIXI implementation of AppViews: each show*() runs the same
 * `manager.goto(new XxxScene(...))` the old startApp() did. Owns the layout +
 * the lobby-only resize listener (kept out of the core).
 */
class PixiAppViews implements AppViews {
  private layout: ILayout;
  /** Set by the shell to core.onResized(); fired after a lobby resize re-renders. */
  onResized: (() => void) | null = null;

  private readonly onResize = (): void => {
    const { width, height } = this.platform.getScreenSize();
    this.app.renderer.resize(width, height);
    this.layout = createLayout(width, height);
    this.scaling.resize(width, height, this.layout);
    this.onResized?.();
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

  showLobby(cb: LobbySceneCallbacks): LobbyView {
    const scene = new LobbyScene(this.layout, this.input, cb);
    this.manager.goto(scene);
    window.addEventListener('resize', this.onResize);
    return {
      applySocialBadge: (n) => scene.applySocialBadge(n),
      applyAchievementBadge: (c) => scene.applyAchievementBadge(c),
      showAchievementToast: (m) => scene.showAchievementToast(m),
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

  showCollection(cb: CollectionCallbacks): void {
    this.leaveLobby();
    this.manager.goto(new CollectionScene(this.layout, this.input, cb));
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

  showReplay(replay: Replay, cb: ReplaySceneCallbacks, level?: LevelDefinition): void {
    this.leaveLobby();
    this.manager.goto(new ReplayScene(this.layout, this.input, replay, cb, level));
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
    this.manager.goto(new GameScene(this.layout, this.input, cb, opts));
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
    this.manager.goto(scene);
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

  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView {
    this.leaveLobby();
    // The joiner (localSide 1) gets a 180°-flipped board with their own base /
    // hand / HUD at the bottom; the engine itself is fully owner-aware.
    const side = ownerToSide(localSide);
    const { width, height } = this.platform.getScreenSize();
    const netLayout = createLayout(width, height, side);
    const scene = new GameScene(netLayout, this.input, cb, opts);
    this.manager.goto(scene);
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

  const layout: ILayout = createLayout(screenW, screenH);
  const scaling = new ScalingManager(app, layout);
  const manager = new SceneManager(app, scaling.gameLayer);

  const input = new InputManager();
  platform.setupInput(app, input, (sx, sy) => scaling.toDesignSpace(sx, sy));

  platform.onAppReady();
  await platform.onLoadingComplete();

  const views = new PixiAppViews(platform, app, scaling, manager, input, layout);
  const core = createAppCore(platform, views);
  views.onResized = () => core.onResized();
  core.start();
}
