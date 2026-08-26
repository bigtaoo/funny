// Shared foundation for the GameRenderer composition (see ../GameRenderer.ts assembly).
//
// GameRendererCore owns every instance field (all public unless genuinely internal-only, so the
// domain classes below keep referencing them via `this.core.xxx`) + the scene-graph builder + the
// per-frame update/destroy lifecycle. Input handling lives in ./input.ts (InputPanel) and event/VFX
// handling lives in ./events.ts (EventsPanel) — each an independent class constructed with `core`,
// see ../GameRenderer.ts's assembly.
//
// Core holds `events`/`input` back-references (assigned by the outer assembly right after
// constructing each, mirroring FriendsScene/core.ts's lazy `net` field) because its own
// update()/destroy()/forceTutorialVictory() need to call into them. None of those three call sites
// fire synchronously inside THIS constructor, so no closure-based two-phase trick is needed for
// them — only the InputManager onDown/onMove/onUp wiring below does, via closures that read
// `this.input` lazily (by the time InputManager actually fires one, the outer assembly's
// constructor has already finished and `this.input` is set).
//
// 2026-08-11: converted from the former `EventMixin(InputMixin(GameRendererBase))` inheritance
// chain to composition — see claudedocs/client-modules.md's split-form priority note. The old
// `export interface GameRendererBase { ... }` declaration-merging block (needed only to satisfy TS
// across the mixin boundary) is gone entirely; input.ts/events.ts reach this class's members
// through an explicit `core` reference instead of inherited `this.xxx`.
import * as PIXI from 'pixi.js-legacy';
import { BOTTOM_BUILDING_ROW, BOTTOM_SPAWN_ROW, TOP_BUILDING_ROW, TOP_SPAWN_ROW } from '@nw/engine/config';

/** HP fraction at/under which a base is "critical" (~last HP cell) — triggers the board ring. */
const BASE_CRITICAL_RATIO = 0.15;
/** Reused empty list so the common (no lanes blocked) path allocates nothing per frame. */
const NO_BLOCKED_LANES: { col: number; remainingSec: number }[] = [];
import {
  IGameEngine,
  OwnerId,
  PlayerStats,
  MatchSummary,
  GamePhase,
  GameState,
  Side,
  sideToOwner,
  TICK_RATE,
} from '../../game';
import { ILayout } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { BoardView } from '../BoardView';
import type { BattleLabelContext } from '../battleLabels';
import { BuildingView } from '../BuildingView';
import { HandView } from '../HandView';
import { HUDView } from '../HUDView';
import { NetStatusView } from '../NetStatusView';
import { UnitView } from '../UnitView';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { TutorialDrawPolicy } from '@nw/engine';
import { TutorialDirector, type TutorialHost } from '../TutorialDirector';
import { VFXSystem } from '../VFXSystem';
import { buildWearOverlay } from '../wearOverlay';
import { ProfilePopup, type ProfileData, type ProfileExtra } from '../../ui/dialogs/ProfilePopup';
import { stateRecorder } from '../../game/replay/StateRecorder';
import { registerPool } from '../../cache/poolRegistry';
import { netLog } from '../../net/log';
import type { EventsPanel } from './events';
import type { InputPanel } from './input';
import { drawOpponentLabel, drawReplayNameLabels } from './labels';

const log = netLog('GameRenderer');

/** Optional player identities for the in-battle profile popup (netplay, S1). */
export interface GameProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
  /** Unified profile-popup extras (rank/ELO + family/sect) — see ProfilePopup's `fetchExtra`. Omitted in replays/AI matches. */
  getProfileExtra?(publicId: string): Promise<ProfileExtra>;
}

/**
 * GameRendererCore — purely visual + InputManager-driven input, shared state root for the
 * event/input domain classes (see file-header comment). No PIXI interactive/hitArea anywhere.
 * All hit-testing is manual in design space.
 */
export class GameRendererCore {
  readonly container: PIXI.Container;

  /** Set by the outer GameRenderer assembly right after construction — see file-header comment. */
  events!: EventsPanel;
  /** Set by the outer GameRenderer assembly right after construction — see file-header comment. */
  input!: InputPanel;

  onGameEnd:     ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats], summary: MatchSummary) => void) | null = null;
  onExitToLobby: (() => void) | null = null;
  /** Tutorial step-level analytics hook (A9-9); wired to TutorialDirector's onStepChange when tutorialEnabled. */
  onTutorialStep: ((stepKey: string) => void) | null = null;

  // One-shot gate: after GameOver the engine's step() returns early without draining the event
  // queue (GameEngine §step), so game_over/game_draw events are re-consumed by update() every
  // frame → without this lock, onGameEnd would fire repeatedly (→ duplicate recordClear /
  // duplicate level_complete analytics, see the double-fire bug). Settlement fires exactly once.
  // Written by EventsPanel.handleEvent (game_over/game_draw) and read by InputPanel.handleDown.
  gameEnded = false;
  /**
   * Handle of the deferred onGameEnd settlement (game_over/game_draw/tutorial victory all schedule
   * it a couple seconds after the banner shows, via scheduleGameEnd() below). Tracked so destroy()
   * can cancel it — otherwise it still fires after the scene (and this renderer) has been torn down,
   * re-running match settlement (reportResult/recordClear/analytics) against whatever the player has
   * navigated to since.
   */
  private gameEndTimer: ReturnType<typeof setTimeout> | null = null;

  readonly engine: IGameEngine;
  readonly layout: ILayout;

  // Which game owner the *local* player controls (derived from the layout's
  // localSide). For single-player / campaign / netplay host this is 0 (Bottom);
  // for the netplay joiner it is 1 (Top). All "is this mine?" decisions — hand,
  // HUD, upgrade, placement validation rows, base-damage flash — key off this
  // instead of hardcoding owner 0.
  readonly localOwner:    OwnerId;
  readonly localBuildRow: number;
  readonly localSpawnRow: number;

  /** True for online lockstep matches — enables the waiting-for-opponent overlay. */
  private readonly netEnabled: boolean;

  /** Opponent / local identities for the tap-to-view profile popup (netplay only). */
  readonly oppProfile:  ProfileData | null;
  readonly selfProfile: ProfileData | null;
  private readonly fetchProfileExtra?: (publicId: string) => Promise<ProfileExtra>;
  profilePopup: ProfilePopup | null = null;

  boardView!:    BoardView;
  unitView!:     UnitView;
  /** Equipped skin ids (one per character, LOBBY_IA_REDESIGN §15), passed to UnitView for the texture swap. */
  private readonly equippedSkins: readonly string[] = [];
  /** Opponent's equipped skin ids, when known (real PvP only — see UnitView.acquireSprite); always empty for AI/bot opponents. */
  private readonly opponentSkins: readonly string[] = [];
  /** Hero Roster card instances (PvE/siege only) for the battle-render gear overlay (§20.4); null = none. */
  private readonly cardInstances: EngineCardInstance[] | null = null;
  /** Equipment inventory for resolving worn gear slot ids in the overlay (§20.4); null = none. */
  private readonly equipmentInv: EngineEquipInv | null = null;
  /** Corner hand-lettering to scrawl in the margins (art-direction §6.2 group B). */
  private readonly battleLabelCtx: BattleLabelContext = {};
  buildingView!: BuildingView;

  handView!:     HandView;
  hudView!:      HUDView;
  netStatus!:    NetStatusView;
  vfxSystem!:    VFXSystem;

  // Net stall detection: seconds the engine has failed to advance a tick.
  private stallTime = 0;

  // Unsubscribe functions from InputManager
  readonly unsubs: Array<() => void> = [];

  /** Memory-guard deregistration function (projectile reuse pool); called in destroy(). */
  private readonly unregisterProjectileStat: () => void;

  /** Tutorial director (activated only for the dedicated tutorial level ch0_tutorial); orchestrates presentation-layer checkpoints / tours / never-lose guarantee. */
  tutorial: TutorialDirector | null = null;
  private tutorialEnabled = false;

  /** Campaign (PvE) level: the surrender button/dialog reword to "exit level". Set before init(). */
  private campaignMode = false;
  setCampaignMode(v: boolean): void { this.campaignMode = v; }

  /** Replay playback: no input wiring, surrender button hidden, base/viewpoint name labels drawn. */
  private readonly spectator: boolean;
  /** Owner-indexed display names (0 = bottom, 1 = top) shown by the replay player; null outside replay. Read by labels.ts's drawReplayNameLabels(). */
  readonly replayNames: readonly [string, string] | null;

  constructor(
    engine: IGameEngine,
    layout: ILayout,
    input: InputManager,
    netEnabled = false,
    spectator = false,
    profiles: GameProfiles = {},
    equippedSkins: readonly string[] = [],
    cardInstances: EngineCardInstance[] | null = null,
    equipmentInv: EngineEquipInv | null = null,
    tutorial = false,
    battleLabels: BattleLabelContext = {},
    replayNames: readonly [string, string] | null = null,
    opponentSkins: readonly string[] = [],
  ) {
    this.engine     = engine;
    this.layout     = layout;
    this.netEnabled = netEnabled;
    this.spectator   = spectator;
    this.replayNames = replayNames;
    this.equippedSkins = equippedSkins;
    this.opponentSkins = opponentSkins;
    this.cardInstances = cardInstances;
    this.equipmentInv  = equipmentInv;
    this.battleLabelCtx = battleLabels;
    this.container  = new PIXI.Container();
    this.oppProfile  = profiles.opponent ?? null;
    this.selfProfile = profiles.local ?? null;
    this.fetchProfileExtra = profiles.getProfileExtra;

    this.localOwner    = sideToOwner(layout.localSide);
    this.localBuildRow = layout.localSide === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
    this.localSpawnRow = layout.localSide === Side.Bottom ? BOTTOM_SPAWN_ROW    : TOP_SPAWN_ROW;

    this.unregisterProjectileStat = registerPool({
      label: 'projectile',
      idle: () => this.events.projectilePool.length,
      bytesEach: 3 * 1024,
    });

    // Spectator (replay playback, S1-RP): the game layer is purely visual — skip
    // all input wiring so taps never select cards, drag, or open the pause menu.
    // The ReplayScene draws its own transport controls on top.
    if (!spectator) {
      this.unsubs.push(input.onDown((x, y) => this.input.handleDown(x, y)));
      this.unsubs.push(input.onMove((x, y) => this.input.handleMove(x, y)));
      this.unsubs.push(input.onUp((x, y)   => this.input.handleUp(x, y)));
    }

    this.tutorialEnabled = tutorial;
  }

  // ── Local player helper ──────────────────────────────────────────────────────

  /** The GameState player the local client controls (mirrors `localOwner`). */
  localPlayer(state: GameState) {
    return this.localOwner === 0 ? state.bottomPlayer : state.topPlayer;
  }

  // ── Network status hooks (driven by app.ts via GameScene, S1-9) ───────────────

  setReconnecting(v: boolean): void { this.netStatus.setReconnecting(v); }
  setPeerDisconnected(v: boolean): void { this.netStatus.setPeerDc(v); }
  /** The connection was permanently rejected (NetState 'disconnected') — see NetStatusView.setDisconnected. */
  setDisconnected(v: boolean): void { this.netStatus.setDisconnected(v); }
  clearNetStatus(): void { this.netStatus.clear(); }

  /** True once the local sim has reached a decisive end (base wiped / draw). */
  isGameOver(): boolean { return this.engine.state.phase === GamePhase.GameOver; }

  /** Ticks the sim has advanced — drives the replay progress bar (S1-RP). */
  get currentTick(): number { return this.engine.state.elapsedTicks; }

  /** Authoritative end-state stats snapshot (for a server-driven match_over). */
  snapshotStats(): [PlayerStats, PlayerStats] { return this.engine.state.snapshotStats(); }

  /** The game owner the local player controls (0 = bottom host, 1 = top joiner). */
  get controlledOwner(): OwnerId { return this.localOwner; }

  init(): void {
    this.buildSceneGraph();
    if (this.tutorialEnabled) {
      const host: TutorialHost = {
        container: this.container,
        layout: this.layout,
        highlightUnitLane: (col) => this.boardView.showUnitLaneHighlights([col], new Set(), col),
        highlightBuildingLane: (col) => this.boardView.showBuildingHighlights([col], this.localBuildRow),
        clearLaneHighlights: () => this.boardView.clearHighlights(),
        handSlotCenter: (i) => this.handView.slotCenter(i),
        switchToFreePlayDraw: () => {
          const p = this.engine.state.bottomPlayer.drawPolicy;
          if (p instanceof TutorialDrawPolicy) p.enterFreePlay();
        },
        forceVictory: () => this.forceTutorialVictory(),
        onSkip: () => this.onExitToLobby?.(),
        onStepChange: (stepKey) => this.onTutorialStep?.(stepKey),
      };
      this.tutorial = new TutorialDirector(host);
    }
  }

  /**
   * Tutorial graduation: scripted victory. Reuses the game_over local-win resolution chain
   * (showGameOver → onGameEnd), but triggered by the director rather than the engine
   * (tutorial level never actually decides a winner, §3.5).
   */
  private forceTutorialVictory(): void {
    if (this.gameEnded) return;
    this.gameEnded = true;
    const winner = this.localOwner;
    stateRecorder.setWinner(winner);
    this.input.cancelDrag(); this.input.cancelTapSelect();
    this.hudView.showGameOver(winner, this.localOwner);
    const stats = this.engine.state.snapshotStats();
    const summary = this.engine.state.snapshotSummary();
    this.scheduleGameEnd(() => this.onGameEnd?.(winner, stats, summary), 1500);
  }

  /**
   * Schedule the deferred onGameEnd settlement callback, tracking the timer handle so destroy()
   * can cancel it (see gameEndTimer's doc comment). Callers (here + events.ts's game_over/game_draw)
   * are expected to have already set `gameEnded = true` and shown the banner.
   */
  scheduleGameEnd(fn: () => void, delayMs: number): void {
    this.gameEndTimer = setTimeout(() => { this.gameEndTimer = null; fn(); }, delayMs);
  }

  update(dt: number): void {
    const prevTicks = this.engine.state.elapsedTicks;
    // Freeze engine advancement during tutorial checkpoints / tours (enemies/waves/hand timers all paused);
    // player drag input is still captured normally; director unblocks once the target card is played (ONBOARDING_DESIGN §3.4).
    const tutorialFrozen = this.tutorial?.engineFrozen ?? false;
    if (!this.hudView.isPaused && !tutorialFrozen) this.engine.tick(dt);
    const state = this.engine.state;
    // State recorder (REPLAY_SHARE_DESIGN §2.1): both live matches and replay playback capture frames here;
    // internally skips on duplicate tick / unconfigured — zero engine intrusion.
    stateRecorder.capture(state);
    for (const event of state.events) this.events.handleEvent(event, state);
    this.boardView.update(dt);
    // 断路: persistent overlay on every column BridgeCollapse has blocked, for the full
    // block (tempBlockedCols maps col → expiry tick). Empty most of the time — cheap early-out.
    if (state.tempBlockedCols.size > 0) {
      const blocked: { col: number; remainingSec: number }[] = [];
      for (const [col, expiresAt] of state.tempBlockedCols) {
        blocked.push({ col, remainingSec: Math.max(0, (expiresAt - state.elapsedTicks) / TICK_RATE) });
      }
      this.boardView.syncBlockedLanes(blocked);
    } else if (this.boardView.hasBlockedLanes()) {
      this.boardView.syncBlockedLanes(NO_BLOCKED_LANES);
    }
    this.boardView.setBaseUpgradeLevel(0, state.bottomPlayer.upgradeLevel);
    this.boardView.setBaseUpgradeLevel(1, state.topPlayer.upgradeLevel);
    // Critical-HP ring on the board (both bases): one haste-rush from ending. Threshold is a fraction of each
    // player's own maxBaseHp (not the global BASE_HP) — an NPC tile's defender base can scale above/below 100.
    this.boardView.setBaseCritical(0, state.bottomPlayer.baseHp_fp > 0 && state.bottomPlayer.baseHp_fp <= state.bottomPlayer.maxBaseHp_fp * BASE_CRITICAL_RATIO);
    this.boardView.setBaseCritical(1, state.topPlayer.baseHp_fp > 0 && state.topPlayer.baseHp_fp <= state.topPlayer.maxBaseHp_fp * BASE_CRITICAL_RATIO);
    this.vfxSystem.update(dt);
    if (this.events.vignetteAlpha > 0) {
      this.events.vignetteAlpha = Math.max(0, this.events.vignetteAlpha - dt / GameRendererCore.VIGNETTE_FADE);
      this.events.drawVignette();
    }
    this.unitView.sync(state.board, dt);
    this.buildingView.update(dt);
    this.buildingView.sync(state.board);
    this.handView.sync(this.localPlayer(state));
    this.hudView.sync(state, this.localOwner);
    if (this.netEnabled) this.updateNetWaiting(state, prevTicks, dt);
    this.netStatus.update(dt);
    this.tutorial?.onTick(state, dt);
  }

  private static readonly VIGNETTE_FADE = 0.55; // seconds to fully fade out

  /**
   * Detect lockstep stalls: in netplay the engine stops advancing ticks while
   * it waits for the next server-confirmed frame (NetInputSource.take → null).
   * If no tick lands for a short grace window while the match is live, surface
   * the waiting-for-opponent spinner so the frozen board doesn't read as a hang.
   * Skip while paused or after game over — those freezes are intentional.
   */
  private updateNetWaiting(state: GameState, prevTicks: number, dt: number): void {
    const advanced = state.elapsedTicks > prevTicks;
    const live = state.phase === GamePhase.Playing && !this.hudView.isPaused;
    if (advanced || !live) {
      this.stallTime = 0;
      this.netStatus.setWaiting(false);
      // Frames flowing again ⇒ the peer is back (server resumed the metronome).
      // There is no explicit "peer reconnected" message, so clear it here.
      if (advanced) this.netStatus.setPeerDc(false);
      return;
    }
    this.stallTime += dt;
    this.netStatus.setWaiting(this.stallTime > 0.3);
  }

  destroy(): void {
    // Tear down the sub-views FIRST. Each unregisters its in-flight ticker callbacks
    // and drains its detached object pools, then destroys its own container. Without
    // this the entire match's display tree + textures leaked on every match exit (no
    // view had a destroy(), and the container was never freed) — the cause of multi-GB
    // client growth over a long session. This must run before the other steps below:
    // every step is independently contained (see safeDestroyStep) so a throw in one
    // (e.g. unsubs) can no longer skip the ticker cleanup that caused that leak.
    this.safeDestroyStep('gameEndTimer', () => {
      if (this.gameEndTimer !== null) { clearTimeout(this.gameEndTimer); this.gameEndTimer = null; }
      this.onGameEnd = null;
    });
    this.safeDestroyStep('boardView', () => this.boardView.destroy());
    this.safeDestroyStep('unitView', () => this.unitView.destroy());
    this.safeDestroyStep('buildingView', () => this.buildingView.destroy());
    this.safeDestroyStep('handView', () => this.handView.destroy());

    this.safeDestroyStep('tutorial', () => {
      this.tutorial?.destroy();
      this.tutorial = null;
    });
    this.safeDestroyStep('projectileStat', () => this.unregisterProjectileStat());
    this.safeDestroyStep('unsubs', () => this.unsubs.forEach(u => u()));
    this.safeDestroyStep('drag', () => this.input.destroy());
    this.safeDestroyStep('profilePopup', () => this.profilePopup?.destroy());
    this.safeDestroyStep('vfxSystem', () => this.vfxSystem.destroy());

    this.safeDestroyStep('escortSprites', () => {
      // Unregister in-flight escort fade/blink ticks first — otherwise a still-running
      // one keeps its closure (and everything it captures) alive via Ticker.shared,
      // the same GC-root leak documented in claudedocs/client-memory-leak.md §2.1.
      for (const tick of this.events.escortEffectTicks) PIXI.Ticker.shared.remove(tick);
      this.events.escortEffectTicks.clear();
      for (const sprite of this.events.escortSprites.values()) sprite.destroy();
      this.events.escortSprites.clear();
    });
    this.safeDestroyStep('projectileSprites', () => {
      for (const sprite of this.events.projectileSprites.values()) sprite.destroy();
      this.events.projectileSprites.clear();
    });
    this.safeDestroyStep('projectilePool', () => {
      for (const sprite of this.events.projectilePool) sprite.destroy();
      this.events.projectilePool.length = 0;
    });

    // Mop up whatever is left under the root (HUD, net status, vignette, escort/
    // projectile layers). Children destroyed above have removed themselves.
    this.safeDestroyStep('container', () => this.container.destroy({ children: true }));
  }

  /** Run one destroy() sub-step in isolation — a throw here must not skip the rest. */
  private safeDestroyStep(step: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log.error(`destroy step "${step}" threw (contained)`, e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }

  /**
   * Display name for one owner as the render layer knows it: the netplay profile name, else the replay
   * player's owner-indexed name label. Returns an empty object (not `{name: undefined}`) when neither is
   * available — PvE has no profiles, and the share site fills the sharer's own name in instead.
   */
  private rosterName(owner: OwnerId, profileName: string | undefined): { name?: string } {
    const name = profileName || this.replayNames?.[owner] || '';
    return name ? { name } : {};
  }

  // ── Scene graph ────────────────────────────────────────────────────────────

  private buildSceneGraph(): void {
    // New match / new replay segment start: clear the single state recorder slot (REPLAY_SHARE_DESIGN §2.1),
    // then hand it the same roster UnitView is about to be built with — a shared state stream has to carry
    // the skin ids itself, since the dumb player that replays it has no account and no engine (§2.2).
    stateRecorder.reset();
    stateRecorder.setRoster({
      localOwner: this.localOwner,
      local:    { skins: this.equippedSkins, ...this.rosterName(this.localOwner, this.selfProfile?.name) },
      opponent: { skins: this.opponentSkins, ...this.rosterName(this.localOwner === 0 ? 1 : 0, this.oppProfile?.name) },
    });
    this.boardView    = new BoardView(this.layout);
    this.boardView.showBattleLabels(this.battleLabelCtx);
    this.boardView.markNoBuildCells(this.engine.state.board.getNoBuildCells());
    this.boardView.markInactiveLanes(this.engine.state.board.getActiveLanes());
    this.boardView.markBlockedCells(this.engine.state.board.getBlockedCells());
    this.unitView     = new UnitView(this.boardView, this.layout.localSide, this.equippedSkins, this.cardInstances, this.equipmentInv, this.opponentSkins);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(this.layout, this.equippedSkins);
    this.hudView      = new HUDView(this.layout, this.campaignMode, /* hideSurrender */ this.spectator);
    this.netStatus    = new NetStatusView(this.layout);
    this.vfxSystem    = new VFXSystem();

    this.events.escortLayer = new PIXI.Container();
    this.events.projectileLayer = new PIXI.Container();

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.events.escortLayer);       // escort units above buildings
    this.container.addChild(this.events.projectileLayer);   // arrows above units, below VFX
    this.container.addChild(this.vfxSystem.container);  // above units, below HUD

    // Worn-notebook overlay (art-direction §3.1) — faint static grain/creases
    // over the whole battlefield, below the HUD so it never muddies HUD text.
    const wear = buildWearOverlay(this.layout.designWidth, this.layout.designHeight);
    wear.alpha = 0.5;
    this.container.addChild(wear);

    this.container.addChild(this.hudView.backgroundContainer);  // bottom strip bg, behind hand
    this.container.addChild(this.handView.container);
    this.container.addChild(this.hudView.container);            // HUD foreground + overlays, above hand

    this.events.vignetteGfx = new PIXI.Graphics();
    this.events.vignetteGfx.interactiveChildren = false;
    this.container.addChild(this.events.vignetteGfx);           // screen-edge flash
    this.container.addChild(this.netStatus.container);          // network status pill

    // Netplay only: show the opponent's name on the top strip and enable the
    // tap-to-view-profile popup (opponent + self). Single-player / campaign keep
    // the AI/anonymous opponent non-clickable.
    if (this.netEnabled && this.oppProfile) {
      drawOpponentLabel(this);
      this.profilePopup = new ProfilePopup(this.layout.designWidth, this.layout.designHeight, this.fetchProfileExtra);
      this.container.addChild(this.profilePopup.container); // topmost — above status pill
    }

    // Replay playback: label both bases with their player names and mark the current viewpoint.
    if (this.spectator && this.replayNames) drawReplayNameLabels(this);
  }

}
