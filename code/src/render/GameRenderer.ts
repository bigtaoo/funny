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

  private drag:      DragState | null = null;
  private dragCol    = -1;
  private dragRow    = -1;
  private dragOnBoard = false;
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
    this.unitView.sync(state.board);
    this.buildingView.sync(state.board);
    this.handView.sync(state.bottomPlayer);
    this.hudView.sync(state);
  }

  destroy(): void {
    this.unsubs.forEach(u => u());
    this.drag?.ghost.destroy();
    this.drag = null;
  }

  // ── Scene graph ────────────────────────────────────────────────────────────

  private buildSceneGraph(): void {
    this.boardView    = new BoardView(this.layout);
    this.unitView     = new UnitView(this.boardView);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(this.layout);
    this.hudView      = new HUDView(this.layout);

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.handView.container);
    this.container.addChild(this.hudView.container);
  }

  // ── Input handling (design-space coords) ─────────────────────────────────

  private handleDown(x: number, y: number): void {
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
      this.hudView.onExitToLobby = () => this.onExitToLobby?.();
      this.hudView.showPause();
      return;
    }

    // Upgrade button
    if (this.hudView.upgradeEnabled && this.overRect(x, y, this.hudView.getUpgradeRect())) {
      this.startUpgradeDrag(x, y);
      return;
    }

    // Hand cards
    const cardIdx = this.handView.hitTestCardIndex(x, y);
    if (cardIdx >= 0) {
      this.startCardDrag(cardIdx);
      return;
    }

    // Board tap (fallback for card placement when drag ends on board)
    if (this.drag?.kind === 'card' && !this.layout.isOutsideBoard(x, y)) {
      const col = this.layout.screenToCol(x, y);
      const row = this.layout.screenToRow(x, y);
      this.commitCardDrag(col, row);
    }
  }

  private handleMove(x: number, y: number): void {
    if (!this.drag) return;

    this.drag.ghost.x = x;
    this.drag.ghost.y = y;

    if (this.drag.kind === 'card') {
      const onBoard = !this.layout.isOutsideBoard(x, y);
      const col = this.layout.screenToCol(x, y);
      const row = this.layout.screenToRow(x, y);
      // Always update when onBoard status changes, or when col/row changes
      if (col !== this.dragCol || row !== this.dragRow || onBoard !== this.dragOnBoard) {
        this.dragCol    = col;
        this.dragRow    = row;
        this.dragOnBoard = onBoard;
        this.updateCardDragHighlights(col, row, x, y);
      }
    } else {
      const baseRect = this.boardView.getPlayerBaseRect();
      this.boardView.showBaseUpgradeHighlight(this.overRect(x, y, baseRect));
    }
  }

  private handleUp(x: number, y: number): void {
    if (!this.drag) return;

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
    this.commitCardDrag(col, row);
  }

  // ── Event handling ─────────────────────────────────────────────────────────

  private handleEvent(event: GameEvent, _state: GameState): void {
    switch (event.type) {
      case 'unit_attack_hit':
        this.unitView.playHitEffect(event.targetId);
        this.unitView.showHpBar(event.targetId);
        break;
      case 'unit_died':
        this.unitView.playDeathEffect(event.unitId);
        break;
      case 'building_destroyed':
        this.buildingView.playDestroyEffect(event.buildingId);
        break;
      case 'building_hp_changed':
        break;
      case 'spell_cast':
        if (event.spellType === SpellType.Meteor) {
          const row = Math.round(event.center.y_fp / 1000);
          this.boardView.playMeteorEffect(event.center.col, row);
        }
        break;
      case 'card_played':
        if (event.owner === 0) this.cancelDrag();
        break;
      case 'card_expired':
        break;
      case 'game_stats':
        this.pendingStats = event.stats;
        break;
      case 'game_over': {
        this.cancelDrag();
        this.hudView.showGameOver(event.winner);
        const s = this.pendingStats;
        if (s) setTimeout(() => { this.onGameEnd?.(event.winner, s); }, 2000);
        break;
      }
      case 'game_draw': {
        this.cancelDrag();
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

    const card  = slot.card;
    const ghost = this.buildDragGhost(card.name, card.cost);
    const center = this.handView.slotCenter(handIndex);
    ghost.x = center.x;
    ghost.y = center.y;
    this.container.addChild(ghost);

    this.drag      = { kind: 'card', handIndex, cardType: card.cardType, spellType: card.spellType, ghost };
    this.dragCol    = -1;
    this.dragRow    = -1;
    this.dragOnBoard = false;
    this.handView.setSelectedCard(handIndex);
    this.updateCardDragHighlights(-1, -1, center.x, center.y);
  }

  private commitCardDrag(col: number, row: number): void {
    if (!this.drag || this.drag.kind !== 'card') return;
    const { handIndex, cardType, spellType } = this.drag;

    switch (cardType) {
      case CardType.Unit: {
        if (!(ATTACK_LANES as readonly number[]).includes(col)) { this.cancelDrag(); return; }
        if (this.engine.state.board.isCellOccupiedByUnit(col, BOTTOM_BUILDING_ROW + 1)) { this.cancelDrag(); return; }
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Building: {
        if (this.engine.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) { this.cancelDrag(); return; }
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Spell: {
        if (spellType === SpellType.Haste)         this.engine.playCard(handIndex, 0);
        else if (spellType === SpellType.Meteor)   this.engine.playCard(handIndex, col, row);
        break;
      }
    }
    this.cancelDrag();
  }

  private updateCardDragHighlights(col: number, row: number, x: number, y: number): void {
    if (!this.drag || this.drag.kind !== 'card') return;
    this.boardView.clearHighlights();

    switch (this.drag.cardType) {
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
          if (!this.engine.state.board.hasBuildingAt(c, BOTTOM_BUILDING_ROW)) valid.push(c);
        }
        this.boardView.showBuildingHighlights(valid, BOTTOM_BUILDING_ROW);
        break;
      }
      case CardType.Spell: {
        if (this.drag.spellType === SpellType.Meteor) {
          // Show 2×2 target preview only when pointer is on the board
          if (!this.layout.isOutsideBoard(x, y)) {
            this.boardView.showMeteorTargetHighlight(col, row);
          }
          // When outside board, highlights are already cleared above
        }
        break;
      }
    }
  }

  // ── Upgrade drag ───────────────────────────────────────────────────────────

  private startUpgradeDrag(x: number, y: number): void {
    const player = this.engine.state.bottomPlayer;
    if (!player.canUpgradeBase()) return;
    const ghost = this.buildDragGhost('↑ 升级', player.nextUpgradeCost!, 0xffcc00);
    ghost.x = x;
    ghost.y = y;
    this.container.addChild(ghost);
    this.drag = { kind: 'upgrade', ghost };
    this.boardView.showBaseUpgradeHighlight(false);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag.ghost.parent?.removeChild(this.drag.ghost);
    this.drag.ghost.destroy();
    this.drag      = null;
    this.dragCol    = -1;
    this.dragRow    = -1;
    this.dragOnBoard = false;
    this.handView.clearSelection();
    this.boardView.clearHighlights();
  }

  private overRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
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
