import { Scene } from './SceneManager';
import { GameRenderer, type GameProfiles } from '../render/GameRenderer';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import {
  createGameEngine,
  IGameEngine,
  LevelDefinition,
  LocalInputSource,
  OwnerId,
  PlayerStats,
  RecordingInputSource,
  type GameMode,
  type Replay,
} from '../game';
import type { NetState } from '../net/NetClient';
import type { MatchOver, PeerDc } from '../net/proto/transport';

export interface GameSceneCallbacks {
  /**
   * `replay` is present for locally-simulated matches (campaign / PvP-vs-AI):
   * the confirmed input stream, recorded for playback (S1-RP). Absent for online
   * netplay (the server owns that recording).
   */
  onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats], replay?: Replay): void;
  onExitToLobby(): void;
  /**
   * Online match ended by the *server* (opponent timed out / desync), not by
   * the local simulation reaching a decisive state. No result hash is reported
   * here — the server already decided. Only fired in netplay.
   */
  onNetMatchOver?(winner: OwnerId | null, stats: [PlayerStats, PlayerStats], reason: string): void;
}

export interface GameSceneOptions {
  /** When set, the scene runs the PvE campaign level instead of a PvP match. */
  level?: LevelDefinition;
  /**
   * A pre-built engine to drive the scene (online netplay, S1-8): app.ts builds
   * it with mode 'netplay' + a NetInputSource. Takes precedence over `level`.
   */
  engine?: IGameEngine;
  /**
   * Online match: enables the in-battle network-status overlay (waiting for
   * opponent / reconnecting / peer dropped) and server-driven match_over (S1-9).
   */
  net?: boolean;
  /** Player identities for the in-battle profile popup (netplay only). */
  profiles?: GameProfiles;
}

export class GameScene implements Scene {
  readonly container;
  private readonly renderer: GameRenderer;
  private readonly cb: GameSceneCallbacks;

  /** Recorder wrapping the local input source (null for injected/net engines). */
  private readonly recorder: RecordingInputSource | null = null;
  private readonly recordMode: GameMode = 'pvp';
  private readonly recordSeed: number = 0;
  private readonly recordLevelId: string | undefined;

  constructor(layout: ILayout, input: InputManager, cb: GameSceneCallbacks, opts: GameSceneOptions = {}) {
    this.cb = cb;

    let engine: IGameEngine;
    if (opts.engine) {
      // Injected engine (online netplay): the server records this match, not us.
      engine = opts.engine;
    } else {
      // Locally-simulated match: wrap the input source in a recorder so the
      // confirmed command stream can be replayed later (S1-RP). seed + mode +
      // level are everything needed to reconstruct the run.
      const seed = opts.level
        ? opts.level.seed
        : (Date.now() ^ ((Math.random() * 0xffffff) | 0)) >>> 0;
      const mode: GameMode = opts.level ? 'campaign' : 'pvp';
      this.recorder = new RecordingInputSource(new LocalInputSource());
      this.recordMode = mode;
      this.recordSeed = seed;
      this.recordLevelId = opts.level?.id;
      engine = createGameEngine(
        {
          seed,
          players: [{ id: 0 }, { id: 1 }],
          mode,
          ...(opts.level ? { level: opts.level } : {}),
        },
        this.recorder,
      );
    }

    this.renderer = new GameRenderer(engine, layout, input, opts.net ?? false, false, opts.profiles ?? {});
    this.renderer.init();
    // Attach the recording (if any) to the end-of-game callback.
    this.renderer.onGameEnd = (winner, stats) => this.cb.onGameEnd(winner, stats, this.buildReplay(winner));
    this.renderer.onExitToLobby = cb.onExitToLobby;

    this.container = this.renderer.container;
  }

  /** Snapshot the recorded input stream into a Replay (null when not recording). */
  private buildReplay(winner: OwnerId | null): Replay | undefined {
    if (!this.recorder) return undefined;
    return this.recorder.snapshot({
      seed: this.recordSeed,
      mode: this.recordMode,
      ...(this.recordLevelId ? { configRef: this.recordLevelId } : {}),
      meta: {
        recordedAt: Date.now(),
        winner: winner ?? -1,
        ...(this.recordLevelId ? { levelId: this.recordLevelId } : {}),
      },
    });
  }

  update(dt: number): void { this.renderer.update(dt); }
  destroy():         void { this.renderer.destroy(); }

  // ── Network status (driven by app.ts from NetSession events, S1-9) ───────────

  /** Our socket state — show the reconnecting toast only while actually retrying. */
  applyNetState(s: NetState): void {
    this.renderer.setReconnecting(s === 'reconnecting');
  }

  /** Opponent dropped — show the peer-disconnect banner (cleared when frames resume). */
  applyPeerDc(_p: PeerDc): void {
    this.renderer.setPeerDisconnected(true);
  }

  /**
   * Server-authoritative end. For `base` the local sim already produced
   * game_over (and reported its hash), so ignore. For `disconnect` / `mismatch`
   * the engine is stalled with no local verdict — end the match here.
   */
  applyMatchOver(m: MatchOver): void {
    if (this.renderer.isGameOver()) return;
    this.renderer.clearNetStatus();
    const winner: OwnerId | null = m.reason === 'mismatch' ? null : (m.winnerSide as OwnerId);
    this.cb.onNetMatchOver?.(winner, this.renderer.snapshotStats(), m.reason);
  }
}
