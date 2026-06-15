// HeadlessAppViews — an AppViews that renders nothing. It records the current
// screen + its callbacks so a test can drive the real createAppCore as if a user
// were clicking (call props.onOpenShop(), props.buy(id), …), and it drives match
// engines to completion without a PIXI ticker (driveToEnd ticks the engine,
// yielding to the event loop so lockstep frame_batch messages can arrive over WS).

import type {
  AppViews,
  RoomView,
  NetGameView,
  ResultViewProps,
} from '../../src/app/AppViews';
import { createLocalMatch } from '../../src/app/matchEngine';
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
import type { ReplaySceneCallbacks } from '../../src/scenes/ReplayScene';
import type { RoomSceneCallbacks } from '../../src/scenes/RoomScene';
import type { GameSceneCallbacks, GameSceneOptions } from '../../src/scenes/GameScene';

export type ScreenName =
  | 'none' | 'intro' | 'lobby' | 'settings' | 'login' | 'shop' | 'gacha'
  | 'campaignMap' | 'levelPrep' | 'collection' | 'replay' | 'result' | 'room' | 'gameNet' | 'game';

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
  replay?: ReplaySceneCallbacks;
  result?: ResultViewProps;
  room?: RoomSceneCallbacks;
  gameNet?: { localSide: OwnerId; cb: GameSceneCallbacks; opts: GameSceneOptions };

  private match: ActiveMatch | null = null;

  showIntro(cb: IntroSceneCallbacks): void { this.screen = 'intro'; this.intro = cb; }
  showLobby(cb: LobbySceneCallbacks): void { this.screen = 'lobby'; this.lobby = cb; }
  showSettings(cb: SettingsSceneCallbacks): void { this.screen = 'settings'; this.settings = cb; }
  showLogin(cb: LoginSceneCallbacks): void { this.screen = 'login'; this.login = cb; }
  showShop(cb: ShopSceneCallbacks): void { this.screen = 'shop'; this.shop = cb; }
  showGacha(cb: GachaSceneCallbacks): void { this.screen = 'gacha'; this.gacha = cb; }
  showCampaignMap(cb: CampaignMapCallbacks): void { this.screen = 'campaignMap'; this.campaignMap = cb; }
  showLevelPrep(cb: LevelPrepCallbacks): void { this.screen = 'levelPrep'; this.levelPrep = cb; }
  showCollection(cb: CollectionCallbacks): void { this.screen = 'collection'; this.collection = cb; }
  showReplay(_replay: Replay, cb: ReplaySceneCallbacks): void { this.screen = 'replay'; this.replay = cb; }
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
    return {
      applyRoomState: () => {},
      applyRoomError: () => {},
      applyPeerDc: () => {},
      applyNetState: () => {},
    };
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
