// Shared context for the app orchestration core. createAppCore builds one AppCtx and passes it to
// every domain nav module (app/nav/*). Mutable session state lives in `state`; screen transitions
// live in `nav` (a registry populated during assembly so modules can call each other freely without
// import cycles); leaf utilities (session/gateway/profile/deck/replay/shard) are methods on the ctx.
import type { TranslationKey } from '../i18n';
import type { IPlatform } from '../platform/IPlatform';
import type { AppViews } from './AppViews';
import type { ApiClient } from '../net/ApiClient';
import type { SaveManager, ReplayStore } from '../game/meta';
import type { FeatureFlags } from '../net/featureFlags';
import type { NetSession } from '../net/NetSession';
import type { WorldApiClient, FamilyDetailView, SectDetailView } from '../net/WorldApiClient';
import type { Replay, OwnerId, PlayerStats, MatchStartInfo, AIDifficulty } from '../game';
import type { EloResult } from '../scenes/ResultScene';
import type { ProfileData } from '../ui/dialogs/ProfilePopup';
import type { RoomIntent } from '../platform/IPlatform';
import type { EntryNoticeHost } from '../ui/dialogs/EntryNoticeStrip';

/** Mutable session-lifetime state, shared by reference across all nav modules. */
export interface AppState {
  inLobby: boolean;
  offlineMode: boolean;
  gatewayUrl: string | null;
  netSession: NetSession | null;
  /** One-shot: whether this session has already handled the "first lobby entry → tutorial" branch (ONBOARDING §2 step ⑤). */
  firstLobbyHandled: boolean;
  /** Cached aggregate social unread (GET /social/badges); survives lobby re-shows. */
  socialBadgeTotal: number;
  /** Cached mail-only unread count (GET /social/badges .mail); drives the mail strip dot specifically. */
  mailBadgeCount: number;
  /** Cached achievement-claimable flag, kept across lobby re-shows. */
  achievementClaimable: boolean;
  /** Cached "monthly/year card active + today's daily reward unclaimed" flag → shop nav red dot. */
  shopCardClaimable: boolean;
  /** Baseline set of reached achievement tiers (`achId#tier`) from the last refresh (S9-5b); null until first fetch. */
  achievementReached: Set<string> | null;
  /**
   * A friend room the platform asked for (an invite link at launch, an invite accepted mid-session,
   * CrazyGames' "play with friends"), not yet opened. The next lobby entry that has a server
   * connection opens it instead of the lobby (nav/lobby.ts). Null on every platform without rooms.
   */
  pendingRoomIntent: RoomIntent | null;
}

/**
 * Where a shop visit came from — reported as `shop_open.source` (ANALYTICS_DESIGN §9.3) so the
 * economy funnel can tell a deliberate visit from one the game pushed the player into.
 * `shop_group` is a peer-tab hop inside the shop/gacha/daily/battle-pass group, i.e. already inside.
 */
export type ShopSource = 'lobby_recharge' | 'prep' | 'shop_group' | 'unknown';

/**
 * Navigation registry: every screen transition callable from any module. Populated by createAppCore
 * during assembly (Object.assign of each module's factory output), so a function in one module can
 * call `ctx.nav.goX()` in another without a static import cycle.
 */
export interface Nav {
  /**
   * The full 7-line story (IntroScene), then `onDone`. Never part of the boot flow any more
   * (ONBOARDING_DESIGN §11.7) — only the settings "Replay story" entry calls it.
   */
  goIntro(onDone: () => void): void;
  /** `fade`: cross-fade in — set only when returning here from exiting a match or the SLG world map. */
  goLobby(opts?: { offline?: boolean; fromResize?: boolean; fade?: boolean }): void;
  goSettings(): void;
  goTitles(back?: () => void): void;
  /** `notice`: message the login screen shows on arrival (forced logout — see nav/auth.ts's forceLogout). */
  goLogin(opts?: { notice?: TranslationKey }): void;
  doLogout(opts?: { notice?: TranslationKey }): void;
  /** The session's token is unusable → toast + full logout + back to the login screen. */
  forceLogout(): void;
  resolveEntry(): Promise<void>;
  goDeckBuilder(onSave: (deck: string[]) => void): void;
  /** `intent`: open straight into creating / joining a friend room (platform invites, see AppState). */
  goRoom(opts?: { autoRanked?: boolean; intent?: RoomIntent }): void;
  // `overlay`: mount the social hub over the still-live SLG world map (see AppViews.MountOpts) — set
  // only when entered from the world map, so backing out never rebuilds the map.
  goFriends(opts?: { defaultTab?: 'friends' | 'family' | 'sect' | 'world' | 'mail'; onBack?: () => void; overlay?: boolean }): void;
  goMail(): void;
  goChat(peerPublicId: string, peerName: string, opts?: { overlay?: boolean; onBack?: () => void }): void;
  goWorldEntry(): void;
  goAuctionFromLobby(): void;
  goWorldMap(worldApi: WorldApiClient, worldId: string): void;
  goSiegeReplay(worldApi: WorldApiClient, worldId: string, siegeId: string): Promise<void>;
  // SLG panels reachable from the world map take `opts.overlay` (keep the map alive) + `opts.onBack`
  // (where the panel's back button lands — defaults to a full goWorldMap rebuild when omitted).
  goDefenseEditor(worldApi: WorldApiClient, worldId: string, tileKey: string, opts?: { overlay?: boolean; onBack?: () => void }): void;
  /** `preloadedFamily`: a family detail the caller already fetched, so FamilyScene can paint without
   *  re-issuing the same request (used by the social hub's family tab — see createWorldNav). */
  goFamilyHub(worldApi: WorldApiClient, worldId: string, onExit?: () => void, overlay?: boolean, preloadedFamily?: FamilyDetailView | null): void;
  goSectHub(
    worldApi: WorldApiClient, worldId: string, onExit?: () => void, overlay?: boolean,
    /** One-shot hand-off of what the caller already fetched — see SectSceneCallbacks.preloadedSect. */
    preload?: { family?: FamilyDetailView | null; sect?: SectDetailView | null },
  ): void;
  goAuctionHouse(worldApi: WorldApiClient, worldId: string, opts?: { overlay?: boolean; onBack?: () => void }): void;
  /** `source` is the shop_open funnel entry-point dimension (ANALYTICS_DESIGN §9.3), not behaviour. */
  goShop(onBack?: () => void, initialTab?: 'shop' | 'coins', source?: ShopSource): void;
  goGacha(group?: { shopBack?: () => void }): void;
  goDaily(): void;
  goEvents(): void;
  goBattlePass(group?: { shopBack?: () => void }): void;
  goRecharge(group?: { shopBack?: () => void }): void;
  goGame(opts?: { seed?: number; difficulty?: AIDifficulty; fromBotFallback?: boolean }): void;
  goCampaignMap(): void;
  goLevelPrep(levelId: string): void;
  goCardRoster(back?: () => void): void;
  goEquipment(back?: () => void, group?: 'none' | 'roster', cardInstanceId?: string): void;
  goStats(back?: () => void): void;
  goLeaderboard(onBack?: () => void): void;
  goAchievements(back?: () => void): void;
  goCodex(back?: () => void): void;
  goCampaign(levelId: string | undefined): void;
  goTutorial(): void;
  goReplay(replay: Replay, onExit?: () => void): void;
  goStatePlayer(shareCode: string): Promise<void>;
  goGameNet(info: MatchStartInfo): void;
  goResult(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    localOwner?: OwnerId,
    replay?: Replay,
    elo?: EloResult,
    profiles?: { opponent?: ProfileData; local?: ProfileData },
    outroTexts?: string[],
    onPlayAgain?: () => void,
    playAgainLabel?: string,
    onReturnToLobby?: () => void,
  ): Promise<void>;
}

/** The dependency + state bag handed to every nav module. */
export interface AppCtx {
  readonly platform: IPlatform;
  readonly views: AppViews;
  readonly api: ApiClient | undefined;
  readonly baseUrl: string | null;
  readonly saveManager: SaveManager;
  readonly replayStore: ReplayStore;
  readonly featureFlags: FeatureFlags | null;
  readonly state: AppState;
  readonly nav: Nav;

  // ── Leaf helpers (session / gateway / profile / deck / replay / shard) ──
  getNetSession(): NetSession | null;
  applyGatewayUrl(url?: string): void;
  playerName(): string;
  avatarId(): string | undefined;
  gateConsent(next: () => void): void;
  /**
   * Put the notice-only build's Terms/Privacy notice + analytics prompt on `host`, if anything is
   * still to be said (IPlatform.entryNoticeOnly, COMPLIANCE_GLOBAL §3.3). A no-op on every other
   * build. Call it every time the host is shown: a strip still up is put back, nothing new is
   * offered twice in one launch. Always set by createAppCore; optional only so the many hand-built
   * test ctxs need not stub it.
   */
  offerEntryNotice?(host: EntryNoticeHost): void;
  /**
   * Notice-only build, outside the EEA, analytics never answered: analytics are on by default but
   * wait until the player has seen the analytics notice (COMPLIANCE_GLOBAL §3.3b). A screen that can
   * show the notice asks this, shows it, and calls {@link acknowledgeStatsNotice} once it is on
   * screen. Optional for the same reason as offerEntryNotice.
   */
  statsNoticePending?(): boolean;
  acknowledgeStatsNotice?(): void;
  resolvePvpDeck(): string[];
  keepReplay(replay: Replay | undefined): Replay | undefined;
  resolveWorldShard(worldApi: WorldApiClient, then: (worldId: string) => void): void;
}
