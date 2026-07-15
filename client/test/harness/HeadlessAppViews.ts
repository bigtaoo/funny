// HeadlessAppViews — an AppViews that renders nothing. It records the current
// screen + its callbacks so a test can drive the real createAppCore as if a user
// were clicking (call props.onOpenShop(), props.buy(id), …), and it drives match
// engines to completion without a PIXI ticker (driveToEnd ticks the engine,
// yielding to the event loop so lockstep frame_batch messages can arrive over WS).

import type {
  AppViews,
  LobbyView,
  RoomView,
  FriendsView,
  ChatView,
  NetGameView,
  ResultViewProps,
} from '../../src/app/AppViews';
import type { RoomState, RoomError } from '../../src/net/proto/transport';
import type { NetState } from '../../src/net/NetClient';
import { createLocalMatch } from '../../src/app/matchEngine';
import { createGameEngine, getLevel, ReplayInputSource } from '../../src/game';
import type { IGameEngine, MatchSummary, OwnerId, PlayerStats, Replay } from '../../src/game';

import type { IntroSceneCallbacks } from '../../src/scenes/IntroScene';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { LoginSceneCallbacks } from '../../src/scenes/LoginScene';
import type { ShopSceneCallbacks } from '../../src/scenes/ShopScene';
import type { GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import type { CampaignMapCallbacks } from '../../src/scenes/CampaignMapScene';
import type { LevelPrepCallbacks } from '../../src/scenes/LevelPrepScene';
import type { CardCodexCallbacks } from '../../src/scenes/CardCodexScene';
import type { CardCallbacks } from '../../src/scenes/CardScene';
import type { EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import type { StatsCallbacks } from '../../src/scenes/StatsScene';
import type { ReplaySceneCallbacks } from '../../src/scenes/ReplayScene';
import type { RoomSceneCallbacks } from '../../src/scenes/RoomScene';
import type { FriendsSceneCallbacks } from '../../src/scenes/FriendsScene';
import type { ChatSceneCallbacks } from '../../src/scenes/ChatScene';
import type { GameSceneCallbacks, GameSceneOptions } from '../../src/scenes/GameScene';
import type { WorldMapCallbacks } from '../../src/scenes/WorldMapScene';
import type { FamilySceneCallbacks } from '../../src/scenes/FamilyScene';
import type { SectSceneCallbacks, SectSceneView } from '../../src/scenes/SectScene';
import type { AuctionSceneCallbacks } from '../../src/scenes/AuctionScene';
import type { DefenseEditorCallbacks } from '../../src/scenes/DefenseEditorScene';
import type { DeckBuilderCallbacks } from '../../src/scenes/DeckBuilderScene';
import { defaultPvpDeck } from '../../src/game/meta/pvpLoadout';
import type { AchievementCallbacks } from '../../src/scenes/AchievementScene';
import type { LeaderboardCallbacks } from '../../src/scenes/LeaderboardScene';
import type { BattlePassCallbacks } from '../../src/scenes/BattlePassScene';
import type { TeamsCallbacks } from '../../src/scenes/TeamsScene';
import type { WorldMapView } from '../../src/scenes/WorldMapScene';
import type { DailyCallbacks } from '../../src/scenes/DailyScene';
import type { EventCallbacks } from '../../src/scenes/EventScene';
import type { ConsentCallbacks } from '../../src/render/ConsentDialog';
import type { ReconnectPromptCallbacks } from '../../src/render/ReconnectPromptDialog';
import type { TitlesSceneCallbacks } from '../../src/scenes/TitlesScene';
import type { CitySceneCallbacks } from '../../src/scenes/CityScene';

export type ScreenName =
  | 'none' | 'intro' | 'lobby' | 'settings' | 'login' | 'shop' | 'gacha'
  | 'campaignMap' | 'levelPrep' | 'cardCodex' | 'cardRoster' | 'equipment' | 'stats' | 'achievements'
  | 'leaderboard' | 'battlePass' | 'replay' | 'result' | 'room' | 'friends'
  | 'chat' | 'gameNet' | 'game' | 'worldMap' | 'family' | 'sect' | 'auction' | 'defenseEditor' | 'teams' | 'deckBuilder'
  | 'consent' | 'reconnectPrompt' | 'daily' | 'events' | 'statePlayer' | 'titles' | 'city';

interface ActiveMatch {
  engine: IGameEngine;
  cb: GameSceneCallbacks;
  buildReplay: (winner: OwnerId | null) => Replay | undefined;
}

export interface MatchResult {
  winner: OwnerId | null;
  stats: [PlayerStats, PlayerStats];
}

/** 30Hz fixed step — mirrors TICK_RATE. */
const DT = 1 / 30;

export class HeadlessAppViews implements AppViews {
  screen: ScreenName = 'none';

  intro?: IntroSceneCallbacks;
  lobby?: LobbySceneCallbacks;
  settings?: SettingsSceneCallbacks;
  login?: LoginSceneCallbacks;
  shop?: ShopSceneCallbacks;
  gacha?: GachaSceneCallbacks;
  battlePass?: BattlePassCallbacks;
  campaignMap?: CampaignMapCallbacks;
  levelPrep?: LevelPrepCallbacks;
  cardCodex?: CardCodexCallbacks;
  cardRoster?: CardCallbacks;
  equipment?: EquipmentCallbacks;
  stats?: StatsCallbacks;
  consent?: ConsentCallbacks;
  reconnectPrompt?: ReconnectPromptCallbacks;
  daily?: DailyCallbacks;
  events?: EventCallbacks;
  /** Last daily-reward-claimable badge the core pushed into the lobby handle. */
  lastRetentionBadge?: boolean;
  /** Last events-available flag the core pushed into the lobby handle. */
  lastEventsAvailable?: boolean;
  replay?: ReplaySceneCallbacks;
  result?: ResultViewProps;
  room?: RoomSceneCallbacks;
  friends?: FriendsSceneCallbacks;
  chat?: ChatSceneCallbacks;
  /** Last aggregate social badge total the core pushed into the lobby handle. */
  lastSocialBadge?: number;
  lastRoomState?: RoomState;
  /** Last gateway net-state forwarded to the room view (wait for 'open' before acting). */
  lastRoomNetState?: NetState;
  /** Last room_error the server pushed (ranked: RANKED_UNAVAILABLE / GAME_UNAVAILABLE). */
  lastRoomError?: RoomError;
  gameNet?: { localSide: OwnerId; cb: GameSceneCallbacks; opts: GameSceneOptions };

  private match: ActiveMatch | null = null;
  private replayMatch: { engine: IGameEngine; endFrame: number } | null = null;

  showIntro(cb: IntroSceneCallbacks): void { this.screen = 'intro'; this.intro = cb; }
  showConsent(cb: ConsentCallbacks): void { this.screen = 'consent'; this.consent = cb; }
  showReconnectPrompt(cb: ReconnectPromptCallbacks): void { this.screen = 'reconnectPrompt'; this.reconnectPrompt = cb; }
  showLobby(cb: LobbySceneCallbacks): LobbyView {
    this.screen = 'lobby';
    this.lobby = cb;
    this.lastSocialBadge = undefined;
    this.lastRetentionBadge = undefined;
    return {
      applySocialBadge: (n) => { this.lastSocialBadge = n; },
      applyAchievementBadge: () => {},
      applyShopBadge: () => {},
      applyRetentionBadge: (c) => { this.lastRetentionBadge = c; },
      applyEventsAvailable: (a) => { this.lastEventsAvailable = a; },
      applyWorldAvailable: () => {},
      showAchievementToast: () => {},
      showSeasonSettlement: () => {},
      // Headless: skip the guide card entirely and continue straight to the
      // wrapped navigation, matching a player who dismisses it immediately.
      showFeatureGuide: (_tk, _bk, onDismiss) => { onDismiss(); },
    };
  }
  showSettings(cb: SettingsSceneCallbacks): void { this.screen = 'settings'; this.settings = cb; }
  showLogin(cb: LoginSceneCallbacks): void { this.screen = 'login'; this.login = cb; }
  showShop(cb: ShopSceneCallbacks): void { this.screen = 'shop'; this.shop = cb; }
  showGacha(cb: GachaSceneCallbacks): void { this.screen = 'gacha'; this.gacha = cb; }
  showCampaignMap(cb: CampaignMapCallbacks): void { this.screen = 'campaignMap'; this.campaignMap = cb; }
  showLevelPrep(cb: LevelPrepCallbacks): void { this.screen = 'levelPrep'; this.levelPrep = cb; }
  showCardCodex(cb: CardCodexCallbacks): void { this.screen = 'cardCodex'; this.cardCodex = cb; }
  showCardRoster(cb: CardCallbacks): void { this.screen = 'cardRoster'; this.cardRoster = cb; }
  showEquipment(cb: EquipmentCallbacks): void { this.screen = 'equipment'; this.equipment = cb; }
  showStats(cb: StatsCallbacks): void { this.screen = 'stats'; this.stats = cb; }
  showAchievements(_cb: AchievementCallbacks): void { this.screen = 'achievements'; }
  showLeaderboard(_cb: LeaderboardCallbacks): void { this.screen = 'leaderboard'; }
  showBattlePass(cb: BattlePassCallbacks): void { this.screen = 'battlePass'; this.battlePass = cb; }
  showTitles(_cb: TitlesSceneCallbacks): void { this.screen = 'titles'; }
  showDaily(cb: DailyCallbacks): void { this.screen = 'daily'; this.daily = cb; }
  showEvents(cb: EventCallbacks): void { this.screen = 'events'; this.events = cb; }
  showCity(_cb: CitySceneCallbacks): void { this.screen = 'city'; }
  showReplay(replay: Replay, cb: ReplaySceneCallbacks): void {
    this.screen = 'replay';
    this.replay = cb;
    // Mirror ReplayScene: rebuild a fresh engine on the replay's seed+mode and
    // drive it with a ReplayInputSource — minus the GameRenderer (headless). Lets
    // the test drive the recorded match back and assert it advances to endFrame.
    const src = new ReplayInputSource(replay);
    const level = replay.mode === 'campaign' && replay.meta?.levelId ? getLevel(replay.meta.levelId) : null;
    const engine = createGameEngine(
      { seed: replay.seed, players: [{ id: 0 }, { id: 1 }], mode: replay.mode, ...(level ? { level } : {}) },
      src,
    );
    this.replayMatch = { engine, endFrame: Math.max(1, src.endFrame) };
  }
  showResult(props: ResultViewProps): void { this.screen = 'result'; this.result = props; }
  showStatePlayer(): void { this.screen = 'statePlayer'; }

  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void {
    this.screen = 'game';
    const { engine, buildReplay } = createLocalMatch({
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.cardInstances ? { cardInstances: opts.cardInstances } : {}),
      ...(opts.equipmentInv ? { equipmentInv: opts.equipmentInv } : {}),
    });
    this.match = { engine, cb, buildReplay };
  }

  showRoom(cb: RoomSceneCallbacks): RoomView {
    this.screen = 'room';
    this.room = cb;
    this.lastRoomState = undefined;
    this.lastRoomNetState = undefined;
    this.lastRoomError = undefined;
    return {
      applyRoomState: (s) => { this.lastRoomState = s; },
      applyRoomError: (e) => { this.lastRoomError = e; },
      applyPeerDc: () => {},
      applyNetState: (s) => { this.lastRoomNetState = s; },
    };
  }

  showFriends(cb: FriendsSceneCallbacks): FriendsView {
    this.screen = 'friends';
    this.friends = cb;
    return {
      applyFriendPresence: () => {},
      applyFriendRequest: () => {},
      applyFriendUpdate: () => {},
      applyChatMessage: () => {},
      applyMailNew: () => {},
    };
  }

  showChat(cb: ChatSceneCallbacks): ChatView {
    this.screen = 'chat';
    this.chat = cb;
    return { applyIncoming: () => {} };
  }

  showWorldMap(_cb: WorldMapCallbacks): WorldMapView {
    this.screen = 'worldMap';
    return { applyMarchUpdate: () => {}, applyTileUpdate: () => {}, applyUnderAttack: () => {}, applySiegeResult: () => {} };
  }
  showFamily(_cb: FamilySceneCallbacks): void { this.screen = 'family'; }
  showSect(_cb: SectSceneCallbacks): SectSceneView { this.screen = 'sect'; return { applySectMsg() {} }; }
  // Capture the auction callbacks so a test can drive the real auction flow the way the
  // AuctionScene would: cb.worldApi is the REAL WorldApiClient the app core built from the
  // signed-in platform.storage token (full-link E2E hits the live auctionsvc through it).
  auction?: AuctionSceneCallbacks;
  showAuction(cb: AuctionSceneCallbacks): void { this.screen = 'auction'; this.auction = cb; }
  showDefenseEditor(_cb: DefenseEditorCallbacks): void { this.screen = 'defenseEditor'; }
  showTeams(_cb: TeamsCallbacks): void { this.screen = 'teams'; }

  // Headless: the PvP deck builder gates ranked entry. Mirror a player who
  // confirms immediately — keep the current saved deck (or default) and save,
  // letting the ranked flow continue straight into the room.
  showDeckBuilder(cb: DeckBuilderCallbacks): void {
    this.screen = 'deckBuilder';
    cb.onSave(cb.getCurrentDeck() ?? defaultPvpDeck());
  }

  showGameNet(localSide: OwnerId, cb: GameSceneCallbacks, opts: GameSceneOptions): NetGameView {
    this.screen = 'gameNet';
    this.gameNet = { localSide, cb, opts };
    // Injected (server-recorded) engine; the server owns the replay.
    this.match = { engine: opts.engine!, cb, buildReplay: () => undefined };
    return {
      applyNetState: () => {},
      applyPeerDc: () => {},
      applyMatchOver: () => {},
    };
  }

  /** Active match engine (for assertions like lockstep tick advancement). */
  get matchEngine(): IGameEngine | null { return this.match?.engine ?? null; }

  /** Recorded length (frames) of the replay being played back, if any. */
  get replayEndFrame(): number | null { return this.replayMatch?.endFrame ?? null; }

  /**
   * Drive the playback engine built in showReplay (ReplayInputSource-fed) until it
   * reaches the recorded endFrame or game over. Replay never stalls (take always
   * answers), so this terminates without WS I/O. Returns the final tick count.
   */
  driveReplayToEnd(opts?: { maxSeconds?: number }): number {
    const r = this.replayMatch;
    if (!r) throw new Error('no replay to drive — showReplay was not called');
    const maxTicks = Math.ceil((opts?.maxSeconds ?? 600) / DT);
    let guard = 0;
    while (r.engine.state.elapsedTicks < r.endFrame) {
      r.engine.tick(DT);
      if (++guard > maxTicks) throw new Error('replay playback did not reach endFrame within budget');
    }
    return r.engine.state.elapsedTicks;
  }

  /**
   * Tick the active match engine for a wall-clock duration, yielding to the event
   * loop so lockstep frame_batch WS messages are applied between ticks. Used by the
   * net E2E to assert the data plane advances (single-process can't assert a
   * deterministic winner — see CLAUDE.md two-engine id-counter note). Returns the
   * engine's elapsedTicks at the end.
   */
  driveFor(ms: number): Promise<number> {
    const m = this.match;
    if (!m) return Promise.reject(new Error('no active match to drive'));
    const deadline = Date.now() + ms;
    return new Promise<number>((resolve, reject) => {
      const step = (): void => {
        try {
          m.engine.tick(DT);
          if (Date.now() >= deadline) { resolve(m.engine.state.elapsedTicks); return; }
          setTimeout(step, 2);
        } catch (err) { reject(err); }
      };
      step();
    });
  }

  /**
   * Tick the active match engine until it reaches a decisive end, then fire its
   * onGameEnd (which on the net path triggers session.reportResult). Yields to the
   * event loop each step so incoming lockstep frame_batch WS messages are applied.
   * `onBeforeTick` (if given) runs right before each `engine.tick()` — e.g. to drive a
   * scripted or AI-controlled defense in a campaign match instead of playing no cards.
   * `stepDelayMs` (default 2, matching prior behavior) is the real-time delay between macrotask
   * yields; pass 0 for a single-process offline match with no WS traffic to coalesce.
   * `ticksPerStep` (default 1, matching prior behavior) batches this many `engine.tick()` calls
   * per macrotask before yielding — a single-tick-per-`setTimeout` cadence is right for netplay
   * (yields for each incoming WS frame_batch) but pure per-call scheduling overhead dominates for
   * an offline match with thousands of ticks to a clear (tens of real seconds for no benefit).
   */
  driveToEnd(opts?: {
    maxSeconds?: number;
    onBeforeTick?: (engine: IGameEngine, tick: number) => void;
    stepDelayMs?: number;
    ticksPerStep?: number;
  }): Promise<MatchResult> {
    const m = this.match;
    if (!m) return Promise.reject(new Error('no active match to drive'));
    const deadline = Date.now() + (opts?.maxSeconds ?? 120) * 1000;
    const stepDelayMs = opts?.stepDelayMs ?? 2;
    const ticksPerStep = Math.max(1, opts?.ticksPerStep ?? 1);
    let stats: [PlayerStats, PlayerStats] | null = null;
    let summary: MatchSummary | null = null;
    let tick = 0;

    return new Promise<MatchResult>((resolve, reject) => {
      const step = (): void => {
        try {
          for (let i = 0; i < ticksPerStep; i++) {
            opts?.onBeforeTick?.(m.engine, tick++);
            m.engine.tick(DT);
            for (const e of m.engine.state.events) {
              if (e.type === 'game_stats') {
                stats = e.stats;
                summary = e.summary;
              } else if (e.type === 'game_over' || e.type === 'game_draw') {
                const winner: OwnerId | null = e.type === 'game_over' ? e.winner : null;
                const finalStats = stats ?? m.engine.state.snapshotStats();
                const finalSummary = summary ?? m.engine.state.snapshotSummary();
                m.cb.onGameEnd(winner, finalStats, m.buildReplay(winner), finalSummary);
                resolve({ winner, stats: finalStats });
                return;
              }
            }
          }
          if (Date.now() > deadline) {
            reject(new Error('match did not reach a decisive end within the time budget'));
            return;
          }
          setTimeout(step, stepDelayMs);
        } catch (err) {
          reject(err);
        }
      };
      step();
    });
  }
}
