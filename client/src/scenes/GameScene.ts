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
  type AIDifficulty,
  type GameMode,
  type MatchSummary,
  type Replay,
} from '../game';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { createLocalMatch } from '../app/matchEngine';
import { preloadL1CardArtTextures } from '../render/cardArt';
import type { NetState } from '../net/NetClient';
import type { MatchOver, PeerDc } from '../net/proto/transport';

export interface GameSceneCallbacks {
  /**
   * `replay` is present for locally-simulated matches (campaign / PvP-vs-AI):
   * the confirmed input stream, recorded for playback (S1-RP). Absent for online
   * netplay (the server owns that recording).
   * `summary` is the match-level end state (elapsed ticks / leaks / escort HP) used by
   * campaign settlement for composite star scoring (STAR_SCORING.md); PvP callers ignore it.
   */
  onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats], replay?: Replay, summary?: MatchSummary): void;
  onExitToLobby(): void;
  /**
   * Online match ended by the *server* (opponent timed out / desync), not by
   * the local simulation reaching a decisive state. No result hash is reported
   * here — the server already decided. Only fired in netplay.
   */
  onNetMatchOver?(winner: OwnerId | null, stats: [PlayerStats, PlayerStats], reason: string): void;
  /** Tutorial step-level analytics hook (A9-9, `opts.tutorial` only) — fired on every TutorialDirector step advance. */
  onTutorialStep?(stepKey: string): void;
}

export interface GameSceneOptions {
  /** When set, the scene runs the PvE campaign level instead of a PvP match. */
  level?: LevelDefinition;
  /**
   * Engine mode override for locally-simulated matches. Defaults to 'campaign'
   * when `level` is set. Pass 'siege' to replay an SLG siege against a defender's
   * config (S8-3 / C2). Ignored when an `engine` is injected (netplay).
   */
  mode?: GameMode;
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
  /** Equipped skin ids (one per character, LOBBY_IA_REDESIGN §15) — swaps unit textures only; absent = default look. */
  equippedSkins?: readonly string[];
  /**
   * Explicit RNG seed for the local PvP-vs-AI path (match-bot fallback). Lets the
   * server-chosen seed drive a deterministic local AI match. Ignored when `level`
   * or `engine` is set.
   */
  seed?: number;
  /**
   * AI skill level (1–10, engine AISystem.ts) for the local PvP-vs-AI path. Omit for the
   * engine default (5). Ignored when `level` or `engine` is set.
   */
  difficulty?: AIDifficulty;
  /**
   * Hero Roster card instances (CC-1) for the PvE campaign path. Passed to the engine
   * so card level + per-card equipment buff the blueprints (hard wall, §5.2), and to the
   * renderer so worn gear is drawn on the units (§20.4). Omit for PvP.
   */
  cardInstances?: EngineCardInstance[];
  /**
   * Equipment instance inventory (SaveData.equipmentInv) for gear slot lookups (stats + overlay).
   * Omit for PvP — no equipment power in competitive matches.
   */
  equipmentInv?: EngineEquipInv;
  /**
   * PvP-vs-AI deck gating (PVP_LOADOUT_DESIGN §3): filters each side's draw pool (bottom = human,
   * top = AI). Omit → full card pool, leaking ELO-locked units. Ignored when `level`/`engine` is set.
   */
  decks?: { top: string[]; bottom: string[] };
  /**
   * Dedicated tutorial level `ch0_tutorial` (ONBOARDING_DESIGN §3). Enables the
   * presentation-layer tutorial director: guided overview + three-beat gating +
   * free play + never-fail mode. Only used together with `level=ch0_tutorial`.
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
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.cardInstances ? { cardInstances: opts.cardInstances } : {}),
        ...(opts.equipmentInv ? { equipmentInv: opts.equipmentInv } : {}),
        ...(opts.decks ? { decks: opts.decks } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
      });
      engine = match.engine;
      buildReplay = match.buildReplay;
    }

    // Corner hand-lettering (art-direction §6.2 group B): every battle gets `[START]`
    // by the local base (PvP uses only START); boss campaign levels add `BOSS` by
    // the enemy base. The tutorial runs its own guided staging, so keep it clean.
    const battleLabels: BattleLabelContext = opts.tutorial
      ? {}
      : { start: true, boss: opts.level?.objective.kind === 'boss' };

    void preloadL1CardArtTextures();
    this.renderer = new GameRenderer(engine, layout, input, opts.net ?? false, false, opts.profiles ?? {}, opts.equippedSkins ?? [], opts.cardInstances ?? null, opts.equipmentInv ?? null, opts.tutorial ?? false, battleLabels);
    this.renderer.init();
    // Attach the recording (if any) to the end-of-game callback.
    this.renderer.onGameEnd = (winner, stats, summary) => this.cb.onGameEnd(winner, stats, buildReplay(winner), summary);
    this.renderer.onExitToLobby = cb.onExitToLobby;
    if (cb.onTutorialStep) this.renderer.onTutorialStep = cb.onTutorialStep;

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
