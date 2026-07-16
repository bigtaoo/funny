// Shared foundation for the GameRenderer mixin chain (see ../GameRenderer.ts assembly).
// GameRendererBase owns every instance field (views, engine/layout refs, tutorial, net status) + the
// scene-graph builder + the per-frame update/destroy lifecycle. Input handling lives in ./input.ts
// (InputMixin) and event/VFX handling lives in ./events.ts (EventMixin); each is chained on top of this
// base into the final GameRenderer.
import * as PIXI from 'pixi.js-legacy';
import { BOTTOM_BUILDING_ROW, BOTTOM_SPAWN_ROW, TOP_BUILDING_ROW, TOP_SPAWN_ROW } from '../../game/config';
import {
  IGameEngine,
  OwnerId,
  PlayerStats,
  MatchSummary,
  GamePhase,
  GameState,
  Side,
  sideToOwner,
} from '../../game';
import { ILayout } from '../../layout/ILayout';
import { InputManager } from '../../inputSystem/InputManager';
import { BoardView } from '../BoardView';
import type { BattleLabelContext } from '../battleLabels';
import { BuildingView } from '../BuildingView';
import { HandView } from '../HandView';
import { HUDView } from '../HUDView';
import { drawHudButton } from '../hudButton';
import { NetStatusView } from '../NetStatusView';
import { UnitView } from '../UnitView';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { TutorialDrawPolicy } from '@nw/engine';
import { TutorialDirector, type TutorialHost } from '../TutorialDirector';
import { VFXSystem } from '../VFXSystem';
import { buildWearOverlay } from '../wearOverlay';
import { ProfilePopup, type ProfileData } from '../ProfilePopup';
import { stateRecorder } from '../../game/replay/StateRecorder';
import { registerPool } from '../../cache/poolRegistry';

/** Optional player identities for the in-battle profile popup (netplay, S1). */
export interface GameProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type GameRendererBaseCtor = Constructor<GameRendererBase>;

/**
 * GameRenderer — purely visual + InputManager-driven input.
 * No PIXI interactive/hitArea anywhere.  All hit-testing is manual in design space.
 */
export class GameRendererBase {
  readonly container: PIXI.Container;

  onGameEnd:     ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats], summary: MatchSummary) => void) | null = null;
  onExitToLobby: (() => void) | null = null;
  /** Tutorial step-level analytics hook (A9-9); wired to TutorialDirector's onStepChange when tutorialEnabled. */
  onTutorialStep: ((stepKey: string) => void) | null = null;

  // One-shot gate: after GameOver the engine's step() returns early without draining the event
  // queue (GameEngine §step), so game_over/game_draw events are re-consumed by update() every
  // frame → without this lock, onGameEnd would fire repeatedly (→ duplicate recordClear /
  // duplicate level_complete analytics, see the double-fire bug). Settlement fires exactly once.
  protected gameEnded = false;

  protected readonly engine: IGameEngine;
  protected readonly layout: ILayout;

  // Which game owner the *local* player controls (derived from the layout's
  // localSide). For single-player / campaign / netplay host this is 0 (Bottom);
  // for the netplay joiner it is 1 (Top). All "is this mine?" decisions — hand,
  // HUD, upgrade, placement validation rows, base-damage flash — key off this
  // instead of hardcoding owner 0.
  protected readonly localOwner:    OwnerId;
  protected readonly localBuildRow: number;
  protected readonly localSpawnRow: number;

  /** True for online lockstep matches — enables the waiting-for-opponent overlay. */
  protected readonly netEnabled: boolean;

  /** Opponent / local identities for the tap-to-view profile popup (netplay only). */
  protected readonly oppProfile:  ProfileData | null;
  protected readonly selfProfile: ProfileData | null;
  protected profilePopup: ProfilePopup | null = null;

  protected boardView!:    BoardView;
  protected unitView!:     UnitView;
  /** Equipped skin ids (one per character, LOBBY_IA_REDESIGN §15), passed to UnitView for the texture swap. */
  protected readonly equippedSkins: readonly string[] = [];
  /** Hero Roster card instances (PvE/siege only) for the battle-render gear overlay (§20.4); null = none. */
  protected readonly cardInstances: EngineCardInstance[] | null = null;
  /** Equipment inventory for resolving worn gear slot ids in the overlay (§20.4); null = none. */
  protected readonly equipmentInv: EngineEquipInv | null = null;
  /** Corner hand-lettering to scrawl in the margins (art-direction §6.2 group B). */
  protected readonly battleLabelCtx: BattleLabelContext = {};
  protected buildingView!: BuildingView;

  protected handView!:     HandView;
  protected hudView!:      HUDView;
  protected netStatus!:    NetStatusView;
  protected vfxSystem!:    VFXSystem;

  // Net stall detection: seconds the engine has failed to advance a tick.
  protected stallTime = 0;

  // Unsubscribe functions from InputManager
  protected readonly unsubs: Array<() => void> = [];

  /** Memory-guard deregistration function (projectile reuse pool); called in destroy(). */
  protected readonly unregisterProjectileStat: () => void;

  /** Tutorial director (activated only for the dedicated tutorial level ch0_tutorial); orchestrates presentation-layer checkpoints / tours / never-lose guarantee. */
  protected tutorial: TutorialDirector | null = null;
  protected tutorialEnabled = false;

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
  ) {
    this.engine     = engine;
    this.layout     = layout;
    this.netEnabled = netEnabled;
    this.equippedSkins = equippedSkins;
    this.cardInstances = cardInstances;
    this.equipmentInv  = equipmentInv;
    this.battleLabelCtx = battleLabels;
    this.container  = new PIXI.Container();
    this.oppProfile  = profiles.opponent ?? null;
    this.selfProfile = profiles.local ?? null;

    this.localOwner    = sideToOwner(layout.localSide);
    this.localBuildRow = layout.localSide === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
    this.localSpawnRow = layout.localSide === Side.Bottom ? BOTTOM_SPAWN_ROW    : TOP_SPAWN_ROW;

    this.unregisterProjectileStat = registerPool({
      label: 'projectile',
      idle: () => this.projectilePool.length,
      bytesEach: 3 * 1024,
    });

    // Spectator (replay playback, S1-RP): the game layer is purely visual — skip
    // all input wiring so taps never select cards, drag, or open the pause menu.
    // The ReplayScene draws its own transport controls on top.
    if (!spectator) {
      this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
      this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
      this.unsubs.push(input.onUp((x, y)   => this.handleUp(x, y)));
    }

    this.tutorialEnabled = tutorial;
  }

  // ── Local player helper ──────────────────────────────────────────────────────

  /** The GameState player the local client controls (mirrors `localOwner`). */
  protected localPlayer(state: GameState) {
    return this.localOwner === 0 ? state.bottomPlayer : state.topPlayer;
  }

  // ── Network status hooks (driven by app.ts via GameScene, S1-9) ───────────────

  setReconnecting(v: boolean): void { this.netStatus.setReconnecting(v); }
  setPeerDisconnected(v: boolean): void { this.netStatus.setPeerDc(v); }
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
  protected forceTutorialVictory(): void {
    if (this.gameEnded) return;
    this.gameEnded = true;
    const winner = this.localOwner;
    stateRecorder.setWinner(winner);
    this.cancelDrag(); this.cancelTapSelect();
    this.hudView.showGameOver(winner, this.localOwner);
    const stats = this.engine.state.snapshotStats();
    const summary = this.engine.state.snapshotSummary();
    setTimeout(() => { this.onGameEnd?.(winner, stats, summary); }, 1500);
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
    for (const event of state.events) this.handleEvent(event, state);
    this.boardView.update(dt);
    this.boardView.setBaseUpgradeLevel(0, state.bottomPlayer.upgradeLevel);
    this.boardView.setBaseUpgradeLevel(1, state.topPlayer.upgradeLevel);
    this.vfxSystem.update(dt);
    if (this.vignetteAlpha > 0) {
      this.vignetteAlpha = Math.max(0, this.vignetteAlpha - dt / GameRendererBase.VIGNETTE_FADE);
      this.drawVignette();
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
  protected updateNetWaiting(state: GameState, prevTicks: number, dt: number): void {
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
    this.tutorial?.destroy();
    this.tutorial = null;
    this.unregisterProjectileStat();
    this.unsubs.forEach(u => u());
    this.drag?.ghost.destroy();
    this.drag            = null;
    this.tapSelect       = null;
    this.pendingCardDown = null;
    this.profilePopup?.destroy();
    this.vfxSystem.destroy();

    // Tear down the sub-views. Each unregisters its in-flight ticker callbacks
    // and drains its detached object pools, then destroys its own container.
    // Without this the entire match's display tree + textures leaked on every
    // match exit (no view had a destroy(), and the container was never freed) —
    // the cause of multi-GB client growth over a long session.
    this.boardView.destroy();
    this.unitView.destroy();
    this.buildingView.destroy();
    this.handView.destroy();

    for (const sprite of this.escortSprites.values()) sprite.destroy();
    this.escortSprites.clear();
    for (const sprite of this.projectileSprites.values()) sprite.destroy();
    this.projectileSprites.clear();
    for (const sprite of this.projectilePool) sprite.destroy();
    this.projectilePool.length = 0;

    // Mop up whatever is left under the root (HUD, net status, vignette, escort/
    // projectile layers). Children destroyed above have removed themselves.
    this.container.destroy({ children: true });
  }

  // ── Scene graph ────────────────────────────────────────────────────────────

  protected buildSceneGraph(): void {
    // New match / new replay segment start: clear the single state recorder slot (REPLAY_SHARE_DESIGN §2.1).
    stateRecorder.reset();
    this.boardView    = new BoardView(this.layout);
    this.boardView.showBattleLabels(this.battleLabelCtx);
    this.boardView.markNoBuildCells(this.engine.state.board.getNoBuildCells());
    this.boardView.markInactiveLanes(this.engine.state.board.getActiveLanes());
    this.boardView.markBlockedCells(this.engine.state.board.getBlockedCells());
    this.unitView     = new UnitView(this.boardView, this.layout.localSide, this.equippedSkins, this.cardInstances, this.equipmentInv);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(this.layout);
    this.hudView      = new HUDView(this.layout);
    this.netStatus    = new NetStatusView(this.layout);
    this.vfxSystem    = new VFXSystem();

    this.escortLayer = new PIXI.Container();
    this.projectileLayer = new PIXI.Container();

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.escortLayer);           // escort units above buildings
    this.container.addChild(this.projectileLayer);       // arrows above units, below VFX
    this.container.addChild(this.vfxSystem.container);  // above units, below HUD

    // Worn-notebook overlay (art-direction §3.1) — faint static grain/creases
    // over the whole battlefield, below the HUD so it never muddies HUD text.
    const wear = buildWearOverlay(this.layout.designWidth, this.layout.designHeight);
    wear.alpha = 0.5;
    this.container.addChild(wear);

    this.container.addChild(this.hudView.backgroundContainer);  // bottom strip bg, behind hand
    this.container.addChild(this.handView.container);
    this.container.addChild(this.hudView.container);            // HUD foreground + overlays, above hand

    this.vignetteGfx = new PIXI.Graphics();
    this.vignetteGfx.interactiveChildren = false;
    this.container.addChild(this.vignetteGfx);                  // screen-edge flash
    this.container.addChild(this.netStatus.container);          // network status pill

    // Netplay only: show the opponent's name on the top strip and enable the
    // tap-to-view-profile popup (opponent + self). Single-player / campaign keep
    // the AI/anonymous opponent non-clickable.
    if (this.netEnabled && this.oppProfile) {
      this.drawOpponentLabel();
      this.profilePopup = new ProfilePopup(this.layout.designWidth, this.layout.designHeight);
      this.container.addChild(this.profilePopup.container); // topmost — above status pill
    }
  }

  /**
   * Opponent nickname on the top HUD strip, in a shared-style button background
   * sitting just left of the (board-centered) enemy HP bar — so the name reads
   * right before the opponent's HP. The profile-tap region is tightened to this
   * button. Vertical band / height reuse the surrender button's.
   */
  protected drawOpponentLabel(): void {
    const sr = this.hudView.getSurrenderRect();
    const hp = this.hudView.getEnemyHpRect();
    const label = new PIXI.Text(this.oppProfile!.name || '?', {
      fontSize: Math.max(12, Math.round(sr.h * 0.5)),
      fill: 0x333333, fontWeight: 'bold', fontFamily: 'monospace',
    });

    const padX = 14;
    const bw = Math.ceil(label.width) + padX * 2;
    const bh = sr.h;
    const bx = hp.x - 12 - bw;  // gap of 12px before the enemy HP bar
    const by = sr.y;

    const bg = new PIXI.Graphics();
    drawHudButton(bg, bw, bh, 'secondary', { radius: 4 });
    bg.x = bx;
    bg.y = by;

    label.anchor.set(0.5);
    label.x = bx + bw / 2;
    label.y = by + bh / 2;

    this.container.addChild(bg, label);
    this.hudView.setEnemyInfoRect({ x: bx, y: by, w: bw, h: bh });
  }
}

// ── Cross-mixin members dispatched to from base-level code (constructor input wiring, update()'s
// vignette fade, destroy()'s drag/event-sprite teardown). Declared via interface/class declaration
// merging so base-level `this.handleDown()` / `this.drawVignette()` etc. type-check (methods as
// METHODS, not properties, which would clash with the mixin's override — TS2425). Emits NOTHING at
// runtime — the real fields/prototype methods come from InputMixin (./input.ts) and EventMixin
// (./events.ts), and their bodies stay verbatim.
export interface GameRendererBase {
  // InputMixin
  drag: import('./input').DragState | null;
  tapSelect: import('./input').TapSelectState | null;
  pendingCardDown: { x: number; y: number; handIndex: number } | null;
  handleDown(x: number, y: number): void;
  handleMove(x: number, y: number): void;
  handleUp(x: number, y: number): void;
  cancelDrag(): void;
  cancelTapSelect(): void;

  // EventMixin
  escortLayer: PIXI.Container;
  escortSprites: Map<string, PIXI.Container>;
  projectileLayer: PIXI.Container;
  projectileSprites: Map<number, PIXI.Container>;
  projectilePool: PIXI.Container[];
  vignetteGfx: PIXI.Graphics;
  vignetteAlpha: number;
  handleEvent(event: import('../../game').GameEvent, state: GameState): void;
  drawVignette(): void;
}
