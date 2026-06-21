// AppViews — the render-free seam between the app orchestration core
// (createAppCore) and the view layer. The core decides *what* screen to show and
// *what* callbacks/business-logic each screen runs; an AppViews implementation
// decides *how* to present it.
//
//   PixiAppViews (app.ts)        — real game: manager.goto(new XxxScene(...))
//   HeadlessAppViews (test)      — full-link E2E: records the current screen +
//                                  exposes the callbacks so a test can drive it
//                                  without PixiJS / rendering.
//
// IMPORTANT: every import here is `import type` (erased at runtime) so this module
// — and createAppCore which imports it — never pulls pixi.js-legacy into the test
// runtime. Do NOT add a value import of any scene class.

import type { OwnerId, PlayerStats, Replay, LevelDefinition } from '../game';
import type { NetState } from '../net/NetClient';
import type {
  RoomState, RoomError, PeerDc, MatchOver,
  FriendPresence, FriendRequestPush, FriendUpdate, ChatMessagePush, MailNew,
} from '../net/proto/transport';
import type { ProfileData } from '../render/ProfilePopup';

import type { IntroSceneCallbacks } from '../scenes/IntroScene';
import type { LobbySceneCallbacks } from '../scenes/LobbyScene';
import type { SettingsSceneCallbacks } from '../scenes/SettingsScene';
import type { LoginSceneCallbacks } from '../scenes/LoginScene';
import type { ShopSceneCallbacks } from '../scenes/ShopScene';
import type { GachaSceneCallbacks } from '../scenes/GachaScene';
import type { CampaignMapCallbacks } from '../scenes/CampaignMapScene';
import type { LevelPrepCallbacks } from '../scenes/LevelPrepScene';
import type { CollectionCallbacks } from '../scenes/CollectionScene';
import type { StatsCallbacks } from '../scenes/StatsScene';
import type { AchievementCallbacks } from '../scenes/AchievementScene';
import type { ReplaySceneCallbacks } from '../scenes/ReplayScene';
import type { ResultSceneCallbacks, EloResult } from '../scenes/ResultScene';
import type { GameSceneCallbacks, GameSceneOptions } from '../scenes/GameScene';
import type { RoomSceneCallbacks } from '../scenes/RoomScene';
import type { FriendsSceneCallbacks } from '../scenes/FriendsScene';
import type { ChatSceneCallbacks } from '../scenes/ChatScene';
import type { WorldMapCallbacks, WorldMapView } from '../scenes/WorldMapScene';
import type { FamilySceneCallbacks } from '../scenes/FamilyScene';
import type { SectSceneCallbacks, SectSceneView } from '../scenes/SectScene';
import type { AuctionSceneCallbacks } from '../scenes/AuctionScene';
import type { DefenseEditorCallbacks } from '../scenes/DefenseEditorScene';
import type { TeamsCallbacks } from '../scenes/TeamsScene';

/** Live handle for the lobby scene — the core pushes the aggregate social badge into it. */
export interface LobbyView {
  /** Update the social (friends/chat/mail) unread total shown on the bottom-nav dot. */
  applySocialBadge(total: number): void;
  /** Toggle the achievement-claimable red dot on the stats nav slot (ACHIEVEMENT_DESIGN §4.1). */
  applyAchievementBadge(claimable: boolean): void;
  /**
   * Show a transient "achievement unlocked" toast over the lobby (ACHIEVEMENT_DESIGN §7, S9-5b).
   * The core computes the unlock delta after refreshing stats and aggregates a single message;
   * tapping the toast jumps to the achievement wall.
   */
  showAchievementToast(text: string): void;
}

/** Live handle for the room scene — the core forwards NetSession control events to it. */
export interface RoomView {
  applyRoomState(s: RoomState): void;
  applyRoomError(e: RoomError): void;
  applyPeerDc(p: PeerDc): void;
  applyNetState(s: NetState): void;
}

/** Live handle for the friends scene — the core forwards social push events to it. */
export interface FriendsView {
  applyFriendPresence(p: FriendPresence): void;
  applyFriendRequest(r: FriendRequestPush): void;
  applyFriendUpdate(u: FriendUpdate): void;
  applyChatMessage(m: ChatMessagePush): void;
  applyMailNew(m: MailNew): void;
}

/** Live handle for the chat window — the core forwards chat_message push to it. */
export interface ChatView {
  applyIncoming(m: ChatMessagePush): void;
}

/** Live handle for a netplay game scene — the core forwards data-plane events to it. */
export interface NetGameView {
  applyNetState(s: NetState): void;
  applyPeerDc(p: PeerDc): void;
  /** May fire the scene's onNetMatchOver callback (server-driven end). */
  applyMatchOver(m: MatchOver): void;
}

/** ResultScene takes positional args, so the core hands the view a props bag. */
export interface ResultViewProps {
  winner: OwnerId | null;
  stats: [PlayerStats, PlayerStats];
  localOwner: OwnerId;
  elo?: EloResult;
  profiles?: { opponent?: ProfileData; local?: ProfileData };
  cb: ResultSceneCallbacks;
  /** Pre-translated outro story text shown as a tap-through overlay before the result. */
  outroText?: string;
}

/**
 * One method per screen the core navigates to. Props == the existing scene
 * callback objects. Only the two scenes the core holds a reference to (room,
 * netplay game) return a handle.
 */
export interface AppViews {
  showIntro(cb: IntroSceneCallbacks): void;
  /** Lobby (home). Returns a handle so the core can push live social-badge updates. */
  showLobby(cb: LobbySceneCallbacks): LobbyView;
  showSettings(cb: SettingsSceneCallbacks): void;
  showLogin(cb: LoginSceneCallbacks): void;
  showShop(cb: ShopSceneCallbacks): void;
  showGacha(cb: GachaSceneCallbacks): void;
  showCampaignMap(cb: CampaignMapCallbacks): void;
  showLevelPrep(cb: LevelPrepCallbacks): void;
  showCollection(cb: CollectionCallbacks): void;
  showStats(cb: StatsCallbacks): void;
  showAchievements(cb: AchievementCallbacks): void;
  showReplay(replay: Replay, cb: ReplaySceneCallbacks, level?: LevelDefinition): void;
  showResult(props: ResultViewProps): void;

  /** Local / campaign match (scene builds its own engine via createLocalMatch). */
  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void;

  // Held-by-reference scenes return a handle the core pushes server events into.
  showRoom(cb: RoomSceneCallbacks): RoomView;
  /** Social hub (friends / chat / mail tabs). The core pushes social events to the handle. */
  showFriends(cb: FriendsSceneCallbacks): FriendsView;
  /** 1:1 chat window. The core pushes chat_message to the handle. */
  showChat(cb: ChatSceneCallbacks): ChatView;
  /** SLG world map (S8). Returns a handle the core forwards live SLG pushes to. */
  showWorldMap(cb: WorldMapCallbacks): WorldMapView;
  /** SLG family hub (S8-4). */
  showFamily(cb: FamilySceneCallbacks): void;
  /** SLG sect hub (S8-4b). Returns a handle the core forwards live sect-channel pushes to. */
  showSect(cb: SectSceneCallbacks): SectSceneView;
  /** SLG auction house (S8-5). */
  showAuction(cb: AuctionSceneCallbacks): void;
  /** SLG simplified defense placement editor (S8-9 C3). */
  showDefenseEditor(cb: DefenseEditorCallbacks): void;
  showTeams(cb: TeamsCallbacks): void;
  /**
   * Netplay match. The core passes the pre-built engine in `opts.engine` plus the
   * local side; the view turns `localSide` into the side-flipped layout.
   */
  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView;
}
