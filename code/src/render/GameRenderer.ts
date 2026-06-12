import * as PIXI from 'pixi.js-legacy';
import {
  ATTACK_LANES,
  BOARD_COLS,
  BOARD_ROWS,
  BOTTOM_BUILDING_ROW,
} from '../game/config';
import {
  IGameEngine,
  GameEvent,
  CardType,
  SpellType,
  OwnerId,
  PlayerStats,
  GameState,
} from '../game';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { BoardView } from './BoardView';
import { BuildingView } from './BuildingView';
import { HandView } from './HandView';
import { HUDView } from './HUDView';
import { UnitView } from './UnitView';
import { VFXSystem } from './VFXSystem';
import { fromFp } from '../game';
import { t } from '../i18n';

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

  private readonly engine: IGameEngine;
  private readonly layout: ILayout;

  private boardView!:    BoardView;
  private unitView!:     UnitView;
  private buildingView!: BuildingView;
  private handView!:     HandView;
  private hudView!:      HUDView;
  private vfxSystem!:    VFXSystem;

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

  constructor(engine: IGameEngine, layout: ILayout, input: InputManager) {
    this.engine    = engine;
    this.layout    = layout;
    this.container = new PIXI.Container();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y)   => this.handleUp(x, y)));
  }

  init(): void {
    this.buildSceneGraph();
  }

  update(dt: number): void {
    this.engine.tick(dt);
    const state = this.engine.state;
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
    this.handView.sync(state.bottomPlayer);
    this.hudView.sync(state);
  }

  destroy(): void {
    this.unsubs.forEach(u => u());
    this.drag?.ghost.destroy();
    this.drag            = null;
    this.tapSelect       = null;
    this.pendingCardDown = null;
    this.vfxSystem.destroy();
  }

  // ── Scene graph ────────────────────────────────────────────────────────────

  private buildSceneGraph(): void {
    this.boardView    = new BoardView(this.layout);
    this.boardView.markNoBuildCells(this.engine.state.board.getNoBuildCells());
    this.unitView     = new UnitView(this.boardView);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(this.layout);
    this.hudView      = new HUDView(this.layout);
    this.vfxSystem    = new VFXSystem();

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.vfxSystem.container);  // above units, below HUD
    this.container.addChild(this.hudView.backgroundContainer);  // bottom strip bg, behind hand
    this.container.addChild(this.handView.container);
    this.container.addChild(this.hudView.container);            // HUD foreground + overlays, above hand

    this.vignetteGfx = new PIXI.Graphics();
    this.vignetteGfx.interactiveChildren = false;
    this.container.addChild(this.vignetteGfx);                  // topmost — screen-edge flash
  }

  // ── Input handling (design-space coords) ─────────────────────────────────

  private handleDown(x: number, y: number): void {
    this.downX = x;
    this.downY = y;

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

    // Hand cards — defer drag start until we see movement (tap vs drag)
    const cardIdx = this.handView.hitTestCardIndex(x, y);
    if (cardIdx >= 0) {
      this.pendingCardDown = { x, y, handIndex: cardIdx };
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
    if (this.tapSelect?.cardType === CardType.Spell && this.tapSelect.spellType === SpellType.Meteor) {
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
        // VFX at the target unit's current position
        const hitUnit = state.board.units.get(event.targetId);
        if (hitUnit) {
          const p = this.boardView.gridToScreen(hitUnit.colExact, hitUnit.rowExact);
          this.vfxSystem.play('hit', p.x, p.y, 0xffffff);
        }
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
        if (event.owner === 0) {
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
        if (event.owner === 0) { this.cancelDrag(); this.cancelTapSelect(); }
        break;
      case 'card_expired':
        if (event.owner === 0) this.handView.notifyCardExpired(event.handIndex);
        break;
      case 'game_stats':
        this.pendingStats = event.stats;
        break;
      case 'game_over': {
        this.cancelDrag(); this.cancelTapSelect();
        this.hudView.showGameOver(event.winner);
        const s = this.pendingStats;
        if (s) setTimeout(() => { this.onGameEnd?.(event.winner, s); }, 2000);
        break;
      }
      case 'game_draw': {
        this.cancelDrag(); this.cancelTapSelect();
        this.hudView.showGameOver(null);
        const s = this.pendingStats;
        if (s) setTimeout(() => { this.onGameEnd?.(null, s); }, 2000);
        break;
      }
    }
  }

  // ── Card drag ──────────────────────────────────────────────────────────────

  private startCardDrag(handIndex: number): void {
    const player = this.engine.state.bottomPlayer;
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.coins < slot.card.cost) return;

    const card   = slot.card;
    const ghost  = this.buildDragGhost(t(card.nameKey), card.cost);
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
    const player = this.engine.state.bottomPlayer;
    const slot   = player.hand.slots[handIndex];
    if (!slot || player.coins < slot.card.cost) return;

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
        if (this.engine.state.board.isCellOccupiedByUnit(col, BOTTOM_BUILDING_ROW + 1)) return;
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Building: {
        if (this.engine.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) return;
        if (this.engine.state.board.isNoBuild(col, BOTTOM_BUILDING_ROW)) return;
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
          if (this.engine.state.board.isCellOccupiedByUnit(lane, BOTTOM_BUILDING_ROW + 1)) blocked.add(lane);
        }
        this.boardView.showUnitLaneHighlights(Array.from(ATTACK_LANES), blocked, col);
        break;
      }
      case CardType.Building: {
        const valid: number[] = [];
        for (let c = 0; c < BOARD_COLS; c++) {
          if (!(ATTACK_LANES as readonly number[]).includes(c)) continue;
          if (this.engine.state.board.isNoBuild(c, BOTTOM_BUILDING_ROW)) continue;
          if (!this.engine.state.board.hasBuildingAt(c, BOTTOM_BUILDING_ROW)) valid.push(c);
        }
        this.boardView.showBuildingHighlights(valid, BOTTOM_BUILDING_ROW);
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
    const player = this.engine.state.bottomPlayer;
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
