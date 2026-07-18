// Shared context for the app orchestration core. createAppCore builds one AppCtx and passes it to
// every domain nav module (app/nav/*). Mutable session state lives in `state`; screen transitions
// live in `nav` (a registry populated during assembly so modules can call each other freely without
// import cycles); leaf utilities (session/gateway/profile/deck/replay/shard) are methods on the ctx.
import type { IPlatform } from '../platform/IPlatform';
import type { AppViews } from './AppViews';
import type { ApiClient } from '../net/ApiClient';
import type { SaveManager, ReplayStore } from '../game/meta';
import type { FeatureFlags } from '../net/featureFlags';
import type { NetSession } from '../net/NetSession';
import type { WorldApiClient } from '../net/WorldApiClient';
import type { Replay, OwnerId, PlayerStats, MatchStartInfo, AIDifficulty } from '../game';
import type { EloResult } from '../scenes/ResultScene';
import type { ProfileData } from '../render/ProfilePopup';

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
  /** Cached achievement-claimable flag, kept across lobby re-shows. */
  achievementClaimable: boolean;
  /** Cached "monthly/year card active + today's daily reward unclaimed" flag → shop nav red dot. */
  shopCardClaimable: boolean;
  /** Baseline set of reached achievement tiers (`achId#tier`) from the last refresh (S9-5b); null until first fetch. */
  achievementReached: Set<string> | null;
}

/**
 * Navigation registry: every screen transition callable from any module. Populated by createAppCore
 * during assembly (Object.assign of each module's factory output), so a function in one module can
 * call `ctx.nav.goX()` in another without a static import cycle.
 */
export interface Nav {
  goIntro(): void;
  /** `fade`: cross-fade in — set only when returning here from exiting a match or the SLG world map. */
  goLobby(opts?: { offline?: boolean; fromResize?: boolean; fade?: boolean }): void;
  goSettings(): void;
  goTitles(back?: () => void): void;
  goLogin(): void;
  doLogout(): void;
  resolveEntry(): Promise<void>;
  goDeckBuilder(onSave: (deck: string[]) => void): void;
  goRoom(opts?: { autoRanked?: boolean }): void;
  goFriends(opts?: { defaultTab?: 'friends' | 'family' | 'sect' | 'world' | 'mail'; onBack?: () => void }): void;
  goMail(): void;
  goChat(peerPublicId: string, peerName: string): void;
  goWorldEntry(): void;
  goAuctionFromLobby(): void;
  goWorldMap(worldApi: WorldApiClient, worldId: string): void;
  goSiegeReplay(worldApi: WorldApiClient, worldId: string, siegeId: string): Promise<void>;
  goDefenseEditor(worldApi: WorldApiClient, worldId: string, tileKey: string): void;
  goCity(worldApi: WorldApiClient, worldId: string): void;
  goFamilyHub(worldApi: WorldApiClient, worldId: string, onExit?: () => void): void;
  goSectHub(worldApi: WorldApiClient, worldId: string, onExit?: () => void): void;
  goAuctionHouse(worldApi: WorldApiClient, worldId: string): void;
  goShop(onBack?: () => void, initialTab?: 'shop' | 'coins'): void;
  goGacha(group?: { shopBack?: () => void }): void;
  goDaily(): void;
  goEvents(): void;
  goBattlePass(group?: { shopBack?: () => void }): void;
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
    outroText?: string,
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
  resolvePvpDeck(): string[];
  keepReplay(replay: Replay | undefined): Replay | undefined;
  resolveWorldShard(worldApi: WorldApiClient, then: (worldId: string) => void): void;
}
