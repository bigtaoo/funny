import { Scene } from './SceneManager';
import { GameRenderer } from '../render/GameRenderer';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { createGameEngine, IGameEngine, LevelDefinition, OwnerId, PlayerStats } from '../game';
import type { NetState } from '../net/NetClient';
import type { MatchOver, PeerDc } from '../net/proto/transport';

export interface GameSceneCallbacks {
  onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]): void;
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
}

export class GameScene implements Scene {
  readonly container;
  private readonly renderer: GameRenderer;
  private readonly cb: GameSceneCallbacks;

  constructor(layout: ILayout, input: InputManager, cb: GameSceneCallbacks, opts: GameSceneOptions = {}) {
    this.cb = cb;
    const engine = opts.engine
      ? opts.engine
      : opts.level
      ? createGameEngine({
          seed: opts.level.seed,
          players: [{ id: 0 }, { id: 1 }],
          mode: 'campaign',
          level: opts.level,
        })
      : createGameEngine({
          seed: Date.now() ^ (Math.random() * 0xffffff | 0),
          players: [{ id: 0 }, { id: 1 }],
        });

    this.renderer = new GameRenderer(engine, layout, input, opts.net ?? false);
    this.renderer.init();
    this.renderer.onGameEnd     = cb.onGameEnd;
    this.renderer.onExitToLobby = cb.onExitToLobby;

    this.container = this.renderer.container;
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
