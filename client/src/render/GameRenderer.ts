import * as PIXI from 'pixi.js-legacy';
import {
  ATTACK_LANES,
  BOARD_COLS,
  BOARD_ROWS,
  BOTTOM_BUILDING_ROW,
  BOTTOM_SPAWN_ROW,
  TOP_BUILDING_ROW,
  TOP_SPAWN_ROW,
} from '../game/config';
import {
  IGameEngine,
  GameEvent,
  CardType,
  SpellType,
  OwnerId,
  PlayerStats,
  GamePhase,
  GameState,
  Side,
  sideToOwner,
} from '../game';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { BoardView } from './BoardView';
import { BuildingView } from './BuildingView';
import { HandView } from './HandView';
import { HUDView } from './HUDView';
import { NetStatusView } from './NetStatusView';
import { UnitView } from './UnitView';
import { VFXSystem } from './VFXSystem';
import { buildWearOverlay } from './wearOverlay';
import { ProfilePopup, type ProfileData } from './ProfilePopup';
import { fromFp } from '../game';
import { stateRecorder } from '../game/replay/StateRecorder';
import { t, type TranslationKey } from '../i18n';

/** Optional player identities for the in-battle profile popup (netplay, S1). */
export interface GameProfiles {
  opponent?: ProfileData;
  local?: ProfileData;
}

// ── Drag state ─────────────────────────────────────────────────────────────────

interface CardDragState {
  kind: 'card';
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
  ghost: PIXI.Container;
}

interface UpgradeDragState {
  kind: 'upgrade';
  ghost: PIXI.Container;
}

type DragState = CardDragState | UpgradeDragState;

// ── Tap-select state ───────────────────────────────────────────────────────────

interface TapSelectState {
  handIndex: number;
  cardType: CardType;
  spellType?: SpellType;
}

const DRAG_THRESHOLD = 8; // px in design space before a press becomes a drag

// ── GameRenderer ───────────────────────────────────────────────────────────────

/**
 * GameRenderer — purely visual + InputManager-driven input.
 * No PIXI interactive/hitArea anywhere.  All hit-testing is manual in design space.
 */
export class GameRenderer {
  readonly container: PIXI.Container;

  onGameEnd:     ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) => void) | null = null;
  onExitToLobby: (() => void) | null = null;

  // 一次性闸门：GameOver 后引擎 step() 提前返回不清事件队列（GameEngine §step），
  // 故 game_over/game_draw 事件每帧被 update() 重复消费 → 不加锁会重复调 onGameEnd
  // （→ 重复 recordClear / 重复 level_complete 埋点，见双发 bug）。结算只触发一次。
  private gameEnded = false;

  private readonly engine: IGameEngine;
  private readonly layout: ILayout;

  // Which game owner the *local* player controls (derived from the layout's
  // localSide). For single-player / campaign / netplay host this is 0 (Bottom);
  // for the netplay joiner it is 1 (Top). All "is this mine?" decisions — hand,
  // HUD, upgrade, placement validation rows, base-damage flash — key off this
  // instead of hardcoding owner 0.
  private readonly localOwner:    OwnerId;
  private readonly localBuildRow: number;
  private readonly localSpawnRow: number;

  /** True for online lockstep matches — enables the waiting-for-opponent overlay. */
  private readonly netEnabled: boolean;

  /** Opponent / local identities for the tap-to-view profile popup (netplay only). */
  private readonly oppProfile:  ProfileData | null;
  private readonly selfProfile: ProfileData | null;
  private profilePopup: ProfilePopup | null = null;

  private boardView!:    BoardView;
  private unitView!:     UnitView;
  /** Equipped skin id (S3-4), passed to UnitView for the texture swap; null = default. */
  private readonly equippedSkin: string | null = null;
  private buildingView!: BuildingView;
  private escortLayer!:  PIXI.Container;
  /** Escort sprite containers keyed by escortId (campaign escort levels only). */
  private readonly escortSprites: Map<string, PIXI.Container> = new Map();
  /** In-flight projectile sprites (arrows) keyed by projectileId. */
  private projectileLayer!: PIXI.Container;
  private readonly projectileSprites: Map<number, PIXI.Container> = new Map();
  /** Idle projectile containers ready for reuse. */
  private readonly projectilePool: PIXI.Container[] = [];
  private handView!:     HandView;
  private hudView!:      HUDView;
  private netStatus!:    NetStatusView;
  private vfxSystem!:    VFXSystem;

  // Net stall detection: seconds the engine has failed to advance a tick.
  private stallTime = 0;

  private vignetteGfx!:   PIXI.Graphics;
  private vignetteAlpha  = 0;
  private static readonly VIGNETTE_FADE = 0.55; // seconds to fully fade out

  private drag:      DragState | null = null;
  private dragCol    = -1;
  private dragRow    = -1;
  private dragOnBoard = false;

  // Tap-select: card selected by tap, placement confirmed by tapping a column
  private tapSelect: TapSelectState | null = null;

  // Pending card press — deferred until we know if it's a tap or drag
  private pendingCardDown: { x: number; y: number; handIndex: number } | null = null;
  private downX = 0;
  private downY = 0;

  private pendingStats: [PlayerStats, PlayerStats] | null = null;

  // Unsubscribe functions from InputManager
  private readonly unsubs: Array<() => void> = [];

  constructor(
    engine: IGameEngine,
    layout: ILayout,
    input: InputManager,
    netEnabled = false,
    spectator = false,
    profiles: GameProfiles = {},
    equippedSkin: string | null = null,
  ) {
    this.engine     = engine;
    this.layout     = layout;
    this.netEnabled = netEnabled;
    this.equippedSkin = equippedSkin;
    this.container  = new PIXI.Container();
    this.oppProfile  = profiles.opponent ?? null;
    this.selfProfile = profiles.local ?? null;

    this.localOwner    = sideToOwner(layout.localSide);
    this.localBuildRow = layout.localSide === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW;
    this.localSpawnRow = layout.localSide === Side.Bottom ? BOTTOM_SPAWN_ROW    : TOP_SPAWN_ROW;

    // Spectator (replay playback, S1-RP): the game layer is purely visual — skip
    // all input wiring so taps never select cards, drag, or open the pause menu.
    // The ReplayScene draws its own transport controls on top.
    if (!spectator) {
      this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
      this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
      this.unsubs.push(input.onUp((x, y)   => this.handleUp(x, y)));
    }
  }

  // ── Local player helper ──────────────────────────────────────────────────────

  /** The GameState player the local client controls (mirrors `localOwner`). */
  private localPlayer(state: GameState) {
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
  }

  update(dt: number): void {
    const prevTicks = this.engine.state.elapsedTicks;
    if (!this.hudView.isPaused) this.engine.tick(dt);
    const state = this.engine.state;
    // 状态流录制（REPLAY_SHARE_DESIGN §2.1）：真打 + 看回放两路都在此抓帧；同一 tick / 未配置
    // 时内部自动跳过，对引擎零侵入。
    stateRecorder.capture(state);
    for (const event of state.events) this.handleEvent(event, state);
    this.boardView.update(dt);
    this.vfxSystem.update(dt);
    if (this.vignetteAlpha > 0) {
      this.vignetteAlpha = Math.max(0, this.vignetteAlpha - dt / GameRenderer.VIGNETTE_FADE);
      this.drawVignette();
    }
    this.unitView.sync(state.board, dt);
    this.buildingView.update(dt);
    this.buildingView.sync(state.board);
    this.handView.sync(this.localPlayer(state));
    this.hudView.sync(state, this.localOwner);
    if (this.netEnabled) this.updateNetWaiting(state, prevTicks, dt);
    this.netStatus.update(dt);
  }

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
    this.unsubs.forEach(u => u());
    this.drag?.ghost.destroy();
    this.drag            = null;
    this.tapSelect       = null;
    this.pendingCardDown = null;
    this.profilePopup?.destroy();
    this.vfxSystem.destroy();
    for (const sprite of this.escortSprites.values()) sprite.destroy();
    this.escortSprites.clear();
    for (const sprite of this.projectileSprites.values()) sprite.destroy();
    this.projectileSprites.clear();
    for (const sprite of this.projectilePool) sprite.destroy();
    this.projectilePool.length = 0;
  }

  // ── Scene graph ────────────────────────────────────────────────────────────

  private buildSceneGraph(): void {
    // 新一局 / 新一段回放开始：清空状态流单槽（REPLAY_SHARE_DESIGN §2.1）。
    stateRecorder.reset();
    this.boardView    = new BoardView(this.layout);
    this.boardView.markNoBuildCells(this.engine.state.board.getNoBuildCells());
    this.boardView.markInactiveLanes(this.engine.state.board.getActiveLanes());
    this.boardView.markBlockedCells(this.engine.state.board.getBlockedCells());
    this.unitView     = new UnitView(this.boardView, this.layout.localSide, this.equippedSkin);
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

  /** Opponent nickname on the top HUD strip, right-aligned before the settings button. */
  private drawOpponentLabel(): void {
    const r = this.hudView.getEnemyInfoRect();
    const label = new PIXI.Text(this.oppProfile!.name || '?', {
      fontSize: Math.max(11, Math.round(r.h * 0.34)),
      fill: 0x333333, fontWeight: 'bold', fontFamily: 'monospace',
    });
    label.anchor.set(1, 0.5);
    label.x = r.x + r.w - 8;
    label.y = r.y + r.h / 2;
    this.container.addChild(label);
  }

  // ── Input handling (design-space coords) ─────────────────────────────────

  private handleDown(x: number, y: number): void {
    this.downX = x;
    this.downY = y;

    // Profile popup open → its own dim backdrop (PIXI interactive) handles the
    // close tap; swallow the manual hit-test so nothing behind it fires.
    if (this.profilePopup?.isOpen) return;

    // Pause overlay intercepts all input
    if (this.hudView.isPaused) {
      const resume = this.hudView.getPauseResumeRect();
      const exit   = this.hudView.getPauseExitRect();
      if (resume && this.overRect(x, y, resume)) {
        this.hudView.hidePause();
      } else if (exit && this.overRect(x, y, exit)) {
        this.hudView.hidePause();
        this.onExitToLobby?.();
      }
      return;
    }

    // Settings button
    if (this.overRect(x, y, this.hudView.getSettingsRect())) {
      this.cancelTapSelect();
      this.hudView.onExitToLobby = () => this.onExitToLobby?.();
      this.hudView.showPause();
      return;
    }

    // Upgrade button
    if (this.hudView.upgradeEnabled && this.overRect(x, y, this.hudView.getUpgradeRect())) {
      this.cancelTapSelect();
      this.startUpgradeDrag(x, y);
      return;
    }

    // Opponent profile (top strip, netplay only — no cards live up there).
    if (this.profilePopup && this.oppProfile && this.overRect(x, y, this.hudView.getEnemyInfoRect())) {
      this.profilePopup.show(this.oppProfile);
      return;
    }

    // Hand cards — defer drag start until we see movement (tap vs drag)
    const cardIdx = this.handView.hitTestCardIndex(x, y);
    if (cardIdx >= 0) {
      this.pendingCardDown = { x, y, handIndex: cardIdx };
      return;
    }

    // Local profile (bottom-strip info column) — checked AFTER cards so a card
    // in the same area always wins; only empty HUD space opens the popup.
    if (this.profilePopup && this.selfProfile && this.overRect(x, y, this.hudView.getPlayerInfoRect())) {
      this.profilePopup.show(this.selfProfile);
      return;
    }

    // Board area while in tap-select: placement handled on handleUp
  }

  private handleMove(x: number, y: number): void {
    // Pending card down: check if moved far enough to become a drag
    if (this.pendingCardDown && !this.drag) {
      const dx = x - this.pendingCardDown.x;
      const dy = y - this.pendingCardDown.y;
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        const handIndex = this.pendingCardDown.handIndex;
        this.pendingCardDown = null;
        this.cancelTapSelect();
        this.startCardDrag(handIndex);
      }
    }

    if (this.drag) {
      this.drag.ghost.x = x;
      this.drag.ghost.y = y;

      if (this.drag.kind === 'card') {
        const onBoard = !this.layout.isOutsideBoard(x, y);
        const col = this.layout.screenToCol(x, y);
        const row = this.layout.screenToRow(x, y);
        if (col !== this.dragCol || row !== this.dragRow || onBoard !== this.dragOnBoard) {
          this.dragCol     = col;
          this.dragRow     = row;
          this.dragOnBoard = onBoard;
          this.updatePlacementHighlights(this.drag.cardType, this.drag.spellType, col, row, x, y);
        }
      } else {
        const baseRect = this.boardView.getPlayerBaseRect();
        this.boardView.showBaseUpgradeHighlight(this.overRect(x, y, baseRect));
      }
      return;
    }

    // Tap-select hover: update Meteor target preview as pointer moves over board
    if (this.tapSelect?.cardType === CardType.Spell && this.tapSelect?.spellType === SpellType.Meteor) {
      if (!this.layout.isOutsideBoard(x, y)) {
        const col = this.layout.screenToCol(x, y);
        const row = this.layout.screenToRow(x, y);
        this.updatePlacementHighlights(CardType.Spell, SpellType.Meteor, col, row, x, y);
      }
    }
  }

  private handleUp(x: number, y: number): void {
    // Resolve pending card press
    if (this.pendingCardDown) {
      const pd = this.pendingCardDown;
      this.pendingCardDown = null;

      if (this.tapSelect && this.tapSelect.handIndex === pd.handIndex) {
        // Tapped the already-selected card → deselect
        this.cancelTapSelect();
        return;
      }
      // Activate tap-select for this card (cancels any previous selection first)
      this.cancelTapSelect();
      this.startTapSelect(pd.handIndex);
      return;
    }

    if (this.drag) {
      if (this.drag.kind === 'upgrade') {
        const baseRect = this.boardView.getPlayerBaseRect();
        if (this.overRect(x, y, baseRect)) this.engine.upgradeBase();
        this.cancelDrag();
        return;
      }
      // card drag
      if (this.layout.isOutsideBoard(x, y)) { this.cancelDrag(); return; }
      const col = this.layout.screenToCol(x, y);
      const row = this.layout.screenToRow(x, y);
      this.commitCardPlay(
        this.drag.handIndex, this.drag.cardType, this.drag.spellType, col, row,
      );
      this.cancelDrag();
      return;
    }

    // Tap-select mode: tap the board to place
    if (this.tapSelect) {
      // Tapping the selected card itself cancels
      const cardIdx = this.handView.hitTestCardIndex(x, y);
      if (cardIdx === this.tapSelect.handIndex) {
        this.cancelTapSelect();
        return;
      }
      if (!this.layout.isOutsideBoard(x, y)) {
        const col = this.layout.screenToCol(x, y);
        const row = this.layout.screenToRow(x, y);
        const { handIndex, cardType, spellType } = this.tapSelect;
        this.cancelTapSelect();
        this.commitCardPlay(handIndex, cardType, spellType, col, row);
      }
    }
  }

  // ── Event handling ─────────────────────────────────────────────────────────

  private handleEvent(event: GameEvent, state: GameState): void {
    switch (event.type) {
      case 'unit_attack_hit': {
        this.unitView.playHitEffect(event.targetId);
        this.unitView.showHpBar(event.targetId);
        // VFX at the target unit's `hit` attachment point (torso) — falls back
        // to the grid-cell centre for circle-placeholder / no-attachment units.
        const hitPos = this.unitView.getHitPoint(event.targetId);
        if (hitPos) {
          this.vfxSystem.play('hit', hitPos.x, hitPos.y, 0xffffff);
        }
        break;
      }
      case 'projectile_fired': {
        const pos = this.boardView.gridToScreen(event.from.col, fromFp(event.from.y_fp));
        const sprite = this.acquireProjectile(event.kind);
        sprite.x = pos.x;
        sprite.y = pos.y;
        this.projectileSprites.set(event.projectileId, sprite);
        this.projectileLayer.addChild(sprite);
        break;
      }
      case 'projectile_moved': {
        const sprite = this.projectileSprites.get(event.projectileId);
        if (!sprite) break;
        const pos = this.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.y_fp));
        // Point the arrow along its travel direction.
        const dx = pos.x - sprite.x;
        const dy = pos.y - sprite.y;
        if (dx !== 0 || dy !== 0) sprite.rotation = Math.atan2(dy, dx);
        sprite.x = pos.x;
        sprite.y = pos.y;
        break;
      }
      case 'projectile_hit':
      case 'projectile_expired': {
        const sprite = this.projectileSprites.get(event.projectileId);
        if (!sprite) break;
        this.projectileSprites.delete(event.projectileId);
        this.releaseProjectile(sprite);
        break;
      }
      case 'unit_died': {
        this.unitView.playDeathEffect(event.unitId);
        // Vec2_fp carries the authoritative death position
        const p = this.boardView.gridToScreen(event.pos.col, fromFp(event.pos.y_fp));
        this.vfxSystem.play('death_unit', p.x, p.y, 0x222222);
        break;
      }
      case 'building_destroyed': {
        this.buildingView.playDestroyEffect(event.buildingId);
        const p = this.boardView.gridToScreen(event.col, event.row);
        this.vfxSystem.play('death_building', p.x, p.y, 0x222222);
        break;
      }
      case 'building_hp_changed':
        break;
      case 'base_hp_changed':
        this.boardView.playBaseCrackEffect(event.owner, event.hp, event.maxHp);
        if (event.owner === this.localOwner) {
          this.vignetteAlpha = 1.0;
          this.drawVignette();
        }
        break;
      case 'spell_cast':
        if (event.spellType === SpellType.Meteor) {
          const row = Math.round(event.center.y_fp / 1000);
          this.boardView.playMeteorEffect(event.center.col, row);
        }
        break;
      case 'card_played':
        if (event.owner === this.localOwner) { this.cancelDrag(); this.cancelTapSelect(); }
        break;
      case 'card_expired':
        if (event.owner === this.localOwner) this.handView.notifyCardExpired(event.handIndex);
        break;
      case 'game_stats':
        this.pendingStats = event.stats;
        break;
      case 'game_over': {
        if (this.gameEnded) break;
        this.gameEnded = true;
        stateRecorder.setWinner(event.winner ?? -1);
        this.cancelDrag(); this.cancelTapSelect();
        this.netStatus.clear();
        this.hudView.showGameOver(event.winner, this.localOwner);
        const s = this.pendingStats;
        if (s) setTimeout(() => { this.onGameEnd?.(event.winner, s); }, 2000);
        break;
      }
      case 'game_draw': {
        if (this.gameEnded) break;
        this.gameEnded = true;
        stateRecorder.setWinner(-1);
        this.cancelDrag(); this.cancelTapSelect();
        this.netStatus.clear();
        this.hudView.showGameOver(null, this.localOwner);
        const s = this.pendingStats;
        if (s) setTimeout(() => { this.onGameEnd?.(null, s); }, 2000);
        break;
      }
      case 'escort_spawned': {
        const pos = this.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.row_fp));
        const sprite = this.buildEscortSprite(pos.x, pos.y, event.hp, event.maxHp);
        this.escortSprites.set(event.escortId, sprite);
        this.escortLayer.addChild(sprite);
        break;
      }
      case 'escort_moved': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        const pos = this.boardView.gridToScreen(fromFp(event.col_fp), fromFp(event.row_fp));
        sprite.x = pos.x;
        sprite.y = pos.y;
        break;
      }
      case 'escort_hp_changed': {
        const sprite = this.escortSprites.get(event.escortId);
        if (sprite) this.setEscortHpBar(sprite, event.hp, event.maxHp);
        break;
      }
      case 'escort_died': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        this.escortSprites.delete(event.escortId);
        let elapsed = 0;
        const tick = (): void => {
          elapsed += PIXI.Ticker.shared.deltaMS / 1000;
          sprite.alpha = Math.max(0, 1 - elapsed / 0.5);
          if (elapsed >= 0.5) {
            PIXI.Ticker.shared.remove(tick);
            sprite.parent?.removeChild(sprite);
            sprite.destroy();
          }
        };
        PIXI.Ticker.shared.add(tick);
        break;
      }
      case 'escort_arrived': {
        const sprite = this.escortSprites.get(event.escortId);
        if (!sprite) break;
        this.escortSprites.delete(event.escortId);
        let frames = 12;
        const tick = (): void => {
          sprite.alpha = frames % 3 === 0 ? 0.2 : 1;
          if (--frames <= 0) {
            PIXI.Ticker.shared.remove(tick);
            sprite.parent?.removeChild(sprite);
            sprite.destroy();
          }
        };
        PIXI.Ticker.shared.add(tick);
        break;
      }
    }
  }

  /**
   * Return a projectile container from the pool (or create one). The arrow is
   * drawn along +x; callers rotate it to the travel direction each move event.
   * `kind` is reserved for future looks (e.g. magic bolt); only 'arrow' today.
   */
  private acquireProjectile(_kind: string): PIXI.Container {
    const c = this.projectilePool.pop();
    if (c) {
      c.rotation = 0;
      c.alpha    = 1;
      return c;
    }
    const container = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.lineStyle(2, 0x2b2b2b, 1);
    g.moveTo(-7, 0);
    g.lineTo(5, 0);
    g.moveTo(5, 0);
    g.lineTo(1, -3);
    g.moveTo(5, 0);
    g.lineTo(1, 3);
    container.addChild(g);
    return container;
  }

  private releaseProjectile(sprite: PIXI.Container): void {
    sprite.removeFromParent();
    sprite.rotation = 0;
    sprite.alpha    = 1;
    this.projectilePool.push(sprite);
  }

  private buildEscortSprite(x: number, y: number, hp: number, maxHp: number): PIXI.Container {
    const c = new PIXI.Container();

    const gfx = new PIXI.Graphics();
    gfx.lineStyle(1.5, 0x226622);
    gfx.beginFill(0x44bb66, 0.85);
    gfx.drawPolygon([-9, 0, 0, -11, 9, 0, 0, 11]);
    gfx.endFill();
    gfx.name = 'body';

    const hpBg = new PIXI.Graphics();
    hpBg.beginFill(0x888888, 0.6);
    hpBg.drawRect(-10, -22, 20, 3);
    hpBg.endFill();
    hpBg.name = 'hpBg';

    const hpFill = new PIXI.Graphics();
    hpFill.name = 'hpFill';

    c.addChild(gfx, hpBg, hpFill);
    c.x = x;
    c.y = y;
    this.setEscortHpBar(c, hp, maxHp);
    return c;
  }

  private setEscortHpBar(sprite: PIXI.Container, hp: number, maxHp: number): void {
    const hpFill = sprite.getChildByName('hpFill') as PIXI.Graphics | null;
    if (!hpFill) return;
    hpFill.clear();
    const ratio = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
    hpFill.beginFill(ratio > 0.4 ? 0x44cc66 : 0xff8833);
    hpFill.drawRect(-10, -22, 20 * ratio, 3);
    hpFill.endFill();
  }

  // ── Card drag ──────────────────────────────────────────────────────────────

  private startCardDrag(handIndex: number): void {
    const player = this.localPlayer(this.engine.state);
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.ink < slot.card.cost) return;

    const card   = slot.card;
    const ghost  = this.buildDragGhost(t(card.nameKey as TranslationKey), card.cost);
    const center = this.handView.slotCenter(handIndex);
    ghost.x = center.x;
    ghost.y = center.y;
    this.container.addChild(ghost);

    this.drag        = { kind: 'card', handIndex, cardType: card.cardType, spellType: card.spellType, ghost };
    this.dragCol     = -1;
    this.dragRow     = -1;
    this.dragOnBoard = false;
    this.handView.setSelectedCard(handIndex);
    this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, center.x, center.y);
  }

  // ── Tap-select ─────────────────────────────────────────────────────────────

  private startTapSelect(handIndex: number): void {
    const player = this.localPlayer(this.engine.state);
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.ink < slot.card.cost) return;

    const card = slot.card;
    this.tapSelect = { handIndex, cardType: card.cardType, spellType: card.spellType };
    this.handView.setSelectedCard(handIndex);
    // Show placement highlights immediately (static for unit/building, empty for meteor until hover)
    this.updatePlacementHighlights(card.cardType, card.spellType, -1, -1, 0, 0);
  }

  private cancelTapSelect(): void {
    if (!this.tapSelect) return;
    this.tapSelect = null;
    this.handView.clearSelection();
    this.boardView.clearHighlights();
  }

  // ── Shared placement logic ─────────────────────────────────────────────────

  private commitCardPlay(
    handIndex: number, cardType: CardType, spellType: SpellType | undefined,
    col: number, row: number,
  ): void {
    switch (cardType) {
      case CardType.Unit: {
        if (!(ATTACK_LANES as readonly number[]).includes(col)) return;
        if (this.engine.state.board.isCellOccupiedByUnit(col, this.localSpawnRow)) return;
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Building: {
        if (this.engine.state.board.hasBuildingAt(col, this.localBuildRow)) return;
        if (this.engine.state.board.isNoBuild(col, this.localBuildRow)) return;
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Spell: {
        if (spellType === SpellType.Haste)       this.engine.playCard(handIndex, 0);
        else if (spellType === SpellType.Meteor)  this.engine.playCard(handIndex, col, row);
        break;
      }
    }
  }

  private updatePlacementHighlights(
    cardType: CardType, spellType: SpellType | undefined,
    col: number, row: number, x: number, y: number,
  ): void {
    this.boardView.clearHighlights();

    switch (cardType) {
      case CardType.Unit: {
        const blocked = new Set<number>();
        for (const lane of ATTACK_LANES) {
          if (this.engine.state.board.isCellOccupiedByUnit(lane, this.localSpawnRow)) blocked.add(lane);
        }
        this.boardView.showUnitLaneHighlights(Array.from(ATTACK_LANES), blocked, col);
        break;
      }
      case CardType.Building: {
        const valid: number[] = [];
        for (let c = 0; c < BOARD_COLS; c++) {
          if (!(ATTACK_LANES as readonly number[]).includes(c)) continue;
          if (this.engine.state.board.isNoBuild(c, this.localBuildRow)) continue;
          if (!this.engine.state.board.hasBuildingAt(c, this.localBuildRow)) valid.push(c);
        }
        this.boardView.showBuildingHighlights(valid, this.localBuildRow);
        break;
      }
      case CardType.Spell: {
        if (spellType === SpellType.Meteor && !this.layout.isOutsideBoard(x, y)) {
          this.boardView.showMeteorTargetHighlight(col, row);
        }
        break;
      }
    }
  }

  // ── Upgrade drag ───────────────────────────────────────────────────────────

  private startUpgradeDrag(x: number, y: number): void {
    const player = this.localPlayer(this.engine.state);
    if (!player.canUpgradeBase()) return;
    const ghost = this.buildDragGhost(t('hud.upgrade'), player.nextUpgradeCost!, 0xffcc00);
    ghost.x = x;
    ghost.y = y;
    this.container.addChild(ghost);
    this.drag = { kind: 'upgrade', ghost };
    this.boardView.showBaseUpgradeHighlight(false);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private cancelDrag(): void {
    this.pendingCardDown = null;
    if (!this.drag) return;
    this.drag.ghost.parent?.removeChild(this.drag.ghost);
    this.drag.ghost.destroy();
    this.drag        = null;
    this.dragCol     = -1;
    this.dragRow     = -1;
    this.dragOnBoard = false;
    this.handView.clearSelection();
    this.boardView.clearHighlights();
  }

  private overRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  // ── Screen-edge vignette flash (base damage feedback) ─────────────────────

  private drawVignette(): void {
    const g = this.vignetteGfx;
    g.clear();
    if (this.vignetteAlpha <= 0) return;

    const W = this.layout.designWidth;
    const H = this.layout.designHeight;
    const color = 0xcc0000;

    // Simulate radial vignette with 4 layered border strips.
    // Each layer is thinner and more opaque, stacking toward the screen edge.
    const N = 12;
    const maxW     = 140;
    const maxAlpha = 0.09;

    g.alpha = this.vignetteAlpha;
    for (let i = 0; i < N; i++) {
      // t=0 → innermost (narrow, faint); t=1 → outermost (wide, opaque)
      const t     = (N - 1 - i) / (N - 1);
      const w     = Math.round(maxW * (t * 0.7 + 0.3)); // range: 0.3–1.0 × maxW
      const alpha = maxAlpha * (t * 0.6 + 0.1);         // range: 0.1–0.7 × maxAlpha
      g.beginFill(color, alpha);
      g.drawRect(0,     0,     W, w);
      g.drawRect(0,     H - w, W, w);
      g.drawRect(0,     0,     w, H);
      g.drawRect(W - w, 0,     w, H);
      g.endFill();
    }
  }

  private buildDragGhost(label: string, cost: number, accentColor = 0x2244aa): PIXI.Container {
    const c   = new PIXI.Container();
    const gfx = new PIXI.Graphics();
    gfx.beginFill(0xfaf6ee, 0.9);
    gfx.lineStyle(2, accentColor);
    gfx.drawRoundedRect(-32, -42, 64, 84, 6);
    gfx.endFill();

    const nameText = new PIXI.Text(label, { fontSize: 11, fill: 0x222222, align: 'center' });
    nameText.anchor.set(0.5, 0.5);
    nameText.y = -10;

    const costText = new PIXI.Text(String(cost), { fontSize: 14, fill: accentColor, fontWeight: 'bold' });
    costText.anchor.set(0.5, 0.5);
    costText.y = 18;

    c.addChild(gfx, nameText, costText);
    c.alpha = 0.9;
    return c;
  }
}
