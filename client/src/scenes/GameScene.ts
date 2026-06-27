import { Scene } from './SceneManager';
import { GameRenderer, type GameProfiles } from '../render/GameRenderer';
import type { BattleLabelContext } from '../render/battleLabels';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import {
  IGameEngine,
  LevelDefinition,
  OwnerId,
  PlayerStats,
  type GameMode,
  type Replay,
} from '../game';
import type { EngineEquipmentInput } from '@nw/engine';
import { createLocalMatch } from '../app/matchEngine';
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
   * Engine mode override for locally-simulated matches. Defaults to 'campaign'
   * when `level` is set. Pass 'siege' to replay an SLG 围攻 against a defender's
   * config (S8-3 / C2). Ignored when an `engine` is injected (netplay).
   */
  mode?: GameMode;
  /**
   * PvE upgrade levels (SaveData.pveUpgrades) for the campaign path. Threaded
   * into the engine to build buffed blueprints (hard wall, §5.2); ignored unless
   * `level` is set. Omit for vanilla/no-upgrade runs.
   */
  pveUpgrades?: Record<string, number>;
  /**
   * Unit progression levels (SaveData.unitLevels) for the campaign path (S12).
   * Threaded into the engine to build progression-buffed blueprints (hard wall,
   * §5.2); ignored unless `level` is set.
   */
  unitLevels?: Record<string, number>;
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
  /** Equipped skin id (S3-4) — swaps unit textures only; null/absent = default look. */
  equippedSkin?: string | null;
  /**
   * Explicit RNG seed for the local PvP-vs-AI path (match-bot fallback). Lets the
   * server-chosen seed drive a deterministic local AI match. Ignored when `level`
   * or `engine` is set.
   */
  seed?: number;
  /**
   * Equipment loadout + inventory for PvE/siege paths (A5 hard wall).
   * Passed to the engine so affixes are applied to campaign blueprints.
   * Omit for PvP — no equipment power in competitive matches.
   */
  equipment?: EngineEquipmentInput;
  /**
   * 专属教学关 `ch0_tutorial`（ONBOARDING_DESIGN §3）。启用表现层教学导演：
   * 认知导览 + 卡点三拍 + 自由发挥 + 永不失败。仅与 `level=ch0_tutorial` 搭配使用。
   */
  tutorial?: boolean;
}

export class GameScene implements Scene {
  readonly container;
  private readonly renderer: GameRenderer;
  private readonly cb: GameSceneCallbacks;

  constructor(layout: ILayout, input: InputManager, cb: GameSceneCallbacks, opts: GameSceneOptions = {}) {
    this.cb = cb;

    let engine: IGameEngine;
    // Replay snapshot: locally-simulated matches record their confirmed stream;
    // an injected (netplay) engine is recorded by the server, so returns undefined.
    let buildReplay: (winner: OwnerId | null) => Replay | undefined;
    if (opts.engine) {
      // Injected engine (online netplay): the server records this match, not us.
      engine = opts.engine;
      buildReplay = () => undefined;
    } else {
      const match = createLocalMatch({
        ...(opts.level ? { level: opts.level } : {}),
        ...(opts.pveUpgrades ? { pveUpgrades: opts.pveUpgrades } : {}),
        ...(opts.unitLevels ? { unitLevels: opts.unitLevels } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.equipment ? { equipment: opts.equipment } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      });
      engine = match.engine;
      buildReplay = match.buildReplay;
    }

    // Corner hand-lettering (art-direction §6.2 B 组): every battle gets `[START]`
    // by the local base ("PvP 可只用 START"); boss campaign levels add `BOSS` by
    // the enemy base. The tutorial runs its own guided staging, so keep it clean.
    const battleLabels: BattleLabelContext = opts.tutorial
      ? {}
      : { start: true, boss: opts.level?.objective.kind === 'boss' };

    this.renderer = new GameRenderer(engine, layout, input, opts.net ?? false, false, opts.profiles ?? {}, opts.equippedSkin ?? null, opts.equipment ?? null, opts.tutorial ?? false, battleLabels);
    this.renderer.init();
    // Attach the recording (if any) to the end-of-game callback.
    this.renderer.onGameEnd = (winner, stats) => this.cb.onGameEnd(winner, stats, buildReplay(winner));
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
