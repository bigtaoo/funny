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
import type { RoomState } from '../../src/net/proto/transport';
import type { NetState } from '../../src/net/NetClient';
import { createLocalMatch } from '../../src/app/matchEngine';
import { createGameEngine, getLevel, ReplayInputSource } from '../../src/game';
import type { IGameEngine, OwnerId, PlayerStats, Replay } from '../../src/game';

import type { IntroSceneCallbacks } from '../../src/scenes/IntroScene';
import type { LobbySceneCallbacks } from '../../src/scenes/LobbyScene';
import type { SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { LoginSceneCallbacks } from '../../src/scenes/LoginScene';
import type { ShopSceneCallbacks } from '../../src/scenes/ShopScene';
import type { GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import type { CampaignMapCallbacks } from '../../src/scenes/CampaignMapScene';
import type { LevelPrepCallbacks } from '../../src/scenes/LevelPrepScene';
import type { CollectionCallbacks } from '../../src/scenes/CollectionScene';
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
import type { AchievementCallbacks } from '../../src/scenes/AchievementScene';
import type { LeaderboardCallbacks } from '../../src/scenes/LeaderboardScene';
import type { BattlePassCallbacks } from '../../src/scenes/BattlePassScene';
import type { TeamsCallbacks } from '../../src/scenes/TeamsScene';
import type { WorldMapView } from '../../src/scenes/WorldMapScene';

export type ScreenName =
  | 'none' | 'intro' | 'lobby' | 'settings' | 'login' | 'shop' | 'gacha'
  | 'campaignMap' | 'levelPrep' | 'collection' | 'equipment' | 'stats' | 'achievements'
  | 'leaderboard' | 'battlePass' | 'replay' | 'result' | 'room' | 'friends'
  | 'chat' | 'gameNet' | 'game' | 'worldMap' | 'family' | 'sect' | 'auction' | 'defenseEditor' | 'teams';

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
  campaignMap?: CampaignMapCallbacks;
  levelPrep?: LevelPrepCallbacks;
  collection?: CollectionCallbacks;
  equipment?: EquipmentCallbacks;
  stats?: StatsCallbacks;
  replay?: ReplaySceneCallbacks;
  result?: ResultViewProps;
  room?: RoomSceneCallbacks;
  friends?: FriendsSceneCallbacks;
  chat?: ChatSceneCallbacks;
  /** Last room_state the core forwarded to the room view (carries the room code). */
  /** Last aggregate social badge total the core pushed into the lobby handle. */
  lastSocialBadge?: number;
  lastRoomState?: RoomState;
  /** Last gateway net-state forwarded to the room view (wait for 'open' before acting). */
  lastRoomNetState?: NetState;
  gameNet?: { localSide: OwnerId; cb: GameSceneCallbacks; opts: GameSceneOptions };

  private match: ActiveMatch | null = null;
  private replayMatch: { engine: IGameEngine; endFrame: number } | null = null;

  showIntro(cb: IntroSceneCallbacks): void { this.screen = 'intro'; this.intro = cb; }
  showLobby(cb: LobbySceneCallbacks): LobbyView {
    this.screen = 'lobby';
    this.lobby = cb;
    this.lastSocialBadge = undefined;
    return {
      applySocialBadge: (n) => { this.lastSocialBadge = n; },
      applyAchievementBadge: () => {},
      showAchievementToast: () => {},
      showSeasonSettlement: () => {},
    };
  }
  showSettings(cb: SettingsSceneCallbacks): void { this.screen = 'settings'; this.settings = cb; }
  showLogin(cb: LoginSceneCallbacks): void { this.screen = 'login'; this.login = cb; }
  showShop(cb: ShopSceneCallbacks): void { this.screen = 'shop'; this.shop = cb; }
  showGacha(cb: GachaSceneCallbacks): void { this.screen = 'gacha'; this.gacha = cb; }
  showCampaignMap(cb: CampaignMapCallbacks): void { this.screen = 'campaignMap'; this.campaignMap = cb; }
  showLevelPrep(cb: LevelPrepCallbacks): void { this.screen = 'levelPrep'; this.levelPrep = cb; }
  showCollection(cb: CollectionCallbacks): void { this.screen = 'collection'; this.collection = cb; }
  showEquipment(cb: EquipmentCallbacks): void { this.screen = 'equipment'; this.equipment = cb; }
  showStats(cb: StatsCallbacks): void { this.screen = 'stats'; this.stats = cb; }
  showAchievements(_cb: AchievementCallbacks): void { this.screen = 'achievements'; }
  showLeaderboard(_cb: LeaderboardCallbacks): void { this.screen = 'leaderboard'; }
  showBattlePass(_cb: BattlePassCallbacks): void { this.screen = 'battlePass'; }
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

  showGame(cb: GameSceneCallbacks, opts: GameSceneOptions): void {
    this.screen = 'game';
    const { engine, buildReplay } = createLocalMatch({
      ...(opts.level ? { level: opts.level } : {}),
      ...(opts.pveUpgrades ? { pveUpgrades: opts.pveUpgrades } : {}),
    });
    this.match = { engine, cb, buildReplay };
  }

  showRoom(cb: RoomSceneCallbacks): RoomView {
    this.screen = 'room';
    this.room = cb;
    this.lastRoomState = undefined;
    this.lastRoomNetState = undefined;
    return {
      applyRoomState: (s) => { this.lastRoomState = s; },
      applyRoomError: () => {},
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
  showAuction(_cb: AuctionSceneCallbacks): void { this.screen = 'auction'; }
  showDefenseEditor(_cb: DefenseEditorCallbacks): void { this.screen = 'defenseEditor'; }
  showTeams(_cb: TeamsCallbacks): void { this.screen = 'teams'; }

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
   */
  driveToEnd(opts?: { maxSeconds?: number }): Promise<MatchResult> {
    const m = this.match;
    if (!m) return Promise.reject(new Error('no active match to drive'));
    const deadline = Date.now() + (opts?.maxSeconds ?? 120) * 1000;
    let stats: [PlayerStats, PlayerStats] | null = null;

    return new Promise<MatchResult>((resolve, reject) => {
      const step = (): void => {
        try {
          m.engine.tick(DT);
          for (const e of m.engine.state.events) {
            if (e.type === 'game_stats') {
              stats = e.stats;
            } else if (e.type === 'game_over' || e.type === 'game_draw') {
              const winner: OwnerId | null = e.type === 'game_over' ? e.winner : null;
              const finalStats = stats ?? m.engine.state.snapshotStats();
              m.cb.onGameEnd(winner, finalStats, m.buildReplay(winner));
              resolve({ winner, stats: finalStats });
              return;
            }
          }
          if (Date.now() > deadline) {
            reject(new Error('match did not reach a decisive end within the time budget'));
            return;
          }
          setTimeout(step, 2);
        } catch (err) {
          reject(err);
        }
      };
      step();
    });
  }
}
