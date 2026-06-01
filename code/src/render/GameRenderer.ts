import * as PIXI from 'pixi.js-legacy';
import {
  ATTACK_LANES,
  BASE_COLS,
  BOARD_COLS,
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
import { BoardView } from './BoardView';
import { BuildingView } from './BuildingView';
import { HandView } from './HandView';
import { HUDView } from './HUDView';
import { UnitView } from './UnitView';

// ─── Drag state ───────────────────────────────────────────────────────────────

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

// ─── GameRenderer ─────────────────────────────────────────────────────────────

/**
 * GameRenderer manages the visual representation of a single game session.
 * It does NOT create a PIXI.Application — the caller provides width, height,
 * and adds `renderer.container` to the stage. Call `update(dt)` each frame.
 */
export class GameRenderer {
  /** Add this to the PIXI stage; remove it to hide the game view. */
  readonly container: PIXI.Container;

  /** Called when game ends. winner=null means draw. */
  onGameEnd: ((winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) => void) | null = null;

  /** Called when player exits to lobby via settings overlay. */
  onExitToLobby: (() => void) | null = null;

  private readonly engine: IGameEngine;
  private readonly width: number;
  private readonly height: number;

  private boardView!:    BoardView;
  private unitView!:     UnitView;
  private buildingView!: BuildingView;
  private handView!:     HandView;
  private hudView!:      HUDView;

  private drag: DragState | null = null;
  /** Column the card-drag ghost is hovering over (-1 = none). */
  private dragCol = -1;
  /** Row the card-drag ghost is hovering over (meteor only). */
  private dragRow = -1;

  private pendingStats: [PlayerStats, PlayerStats] | null = null;

  constructor(engine: IGameEngine, width: number, height: number) {
    this.engine    = engine;
    this.width     = width;
    this.height    = height;
    this.container = new PIXI.Container();
  }

  /** Call once after adding the container to the stage. Synchronous (no assets yet). */
  init(): void {
    this.buildSceneGraph();
  }

  /** Call every render frame with wall-clock dt (seconds). */
  update(dt: number): void {
    this.engine.tick(dt);
    const state = this.engine.state;

    for (const event of state.events) {
      this.handleEvent(event, state);
    }

    this.unitView.sync(state.board);
    this.buildingView.sync(state.board);
    this.handView.sync(state.bottomPlayer);
    this.hudView.sync(state);
  }

  /** Remove listeners and tear down the scene graph. */
  destroy(): void {
    this.container.removeAllListeners();
    this.drag?.ghost.destroy();
    this.drag = null;
  }

  // ─── Scene graph ──────────────────────────────────────────────────────────

  private buildSceneGraph(): void {
    const { width, height } = this;

    // Compute base center X for HP bar positioning in HUD
    const bv = new BoardView(width, height);
    const [baseMin, baseMax] = BASE_COLS;
    const baseCenterX = (bv.gridToScreen(baseMin, 0).x + bv.gridToScreen(baseMax, 0).x) / 2
                      + bv.cellWidth / 2;

    this.boardView    = bv;
    this.unitView     = new UnitView(this.boardView);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(width, height);
    this.hudView      = new HUDView(width, height, baseCenterX);

    // Full-screen transparent hit area so pointer events are captured
    const hitArea = new PIXI.Graphics();
    hitArea.beginFill(0xffffff, 0.001);
    hitArea.drawRect(0, 0, width, height);
    hitArea.endFill();
    hitArea.interactive = true;

    // Layer order: hit-area → board → units → buildings → hand → HUD
    this.container.addChild(hitArea);
    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.handView.container);
    this.container.addChild(this.hudView.container);

    // ── Wire card drag ─────────────────────────────────────────────────────
    this.handView.onCardDragStart = (handIndex) => {
      this.startCardDrag(handIndex);
    };

    // ── Wire upgrade drag ─────────────────────────────────────────────────
    this.hudView.onUpgradeDragStart = (cx, cy) => {
      this.startUpgradeDrag(cx, cy);
    };

    // Global pointer tracking
    this.container.interactive = true;
    this.container.on('pointermove',      this.onPointerMove, this);
    this.container.on('pointerup',        this.onPointerUp,   this);
    this.container.on('pointerupoutside', this.onPointerUp,   this);

    // Board cell tap (non-drag fallback)
    this.boardView.onCellTap = (col, row) => {
      if (this.drag?.kind === 'card') this.commitCardDrag(col, row);
    };

    // Settings button — toggle pause overlay
    this.hudView.onSettingsPressed = () => {
      if (this.hudView.isPaused) {
        this.hudView.hidePause();
      } else {
        this.hudView.onExitToLobby = () => { this.onExitToLobby?.(); };
        this.hudView.showPause();
      }
    };
  }

  // ─── Event handling ───────────────────────────────────────────────────────

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
        break; // BuildingView syncs from state each frame

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
        break; // HandView re-syncs each frame

      case 'game_stats':
        this.pendingStats = event.stats;
        break;

      case 'game_over': {
        this.cancelDrag();
        this.hudView.showGameOver(event.winner);
        const statsOver = this.pendingStats;
        if (statsOver) {
          setTimeout(() => { this.onGameEnd?.(event.winner, statsOver); }, 2000);
        }
        break;
      }

      case 'game_draw': {
        this.cancelDrag();
        this.hudView.showGameOver(null);
        const statsDraw = this.pendingStats;
        if (statsDraw) {
          setTimeout(() => { this.onGameEnd?.(null, statsDraw); }, 2000);
        }
        break;
      }
    }
  }

  // ─── Pointer handling ─────────────────────────────────────────────────────

  private onPointerMove = (e: PIXI.FederatedPointerEvent): void => {
    if (!this.drag) return;
    const pos = e.getLocalPosition(this.container);
    this.drag.ghost.x = pos.x;
    this.drag.ghost.y = pos.y;

    if (this.drag.kind === 'card') {
      const col = this.boardView.screenToCol(pos.x);
      const row = this.boardView.screenToRow(pos.y);
      if (col !== this.dragCol || row !== this.dragRow) {
        this.dragCol = col;
        this.dragRow = row;
        this.updateCardDragHighlights(col, row);
      }
    } else {
      // upgrade drag — highlight base when hovering over it
      const baseRect = this.boardView.getPlayerBaseRect();
      const overBase = this.isOverRect(pos.x, pos.y, baseRect);
      this.boardView.showBaseUpgradeHighlight(overBase);
    }
  };

  private onPointerUp = (e: PIXI.FederatedPointerEvent): void => {
    if (!this.drag) return;
    const pos = e.getLocalPosition(this.container);

    if (this.drag.kind === 'upgrade') {
      const baseRect = this.boardView.getPlayerBaseRect();
      if (this.isOverRect(pos.x, pos.y, baseRect)) {
        this.engine.upgradeBase();
      }
      this.cancelDrag();
      return;
    }

    // card drag
    if (this.boardView.isOutsideBoard(pos.x, pos.y)) {
      this.cancelDrag();
      return;
    }
    const col = this.boardView.screenToCol(pos.x);
    const row = this.boardView.screenToRow(pos.y);
    this.commitCardDrag(col, row);
  };

  // ─── Card drag ────────────────────────────────────────────────────────────

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

    this.drag    = { kind: 'card', handIndex, cardType: card.cardType, spellType: card.spellType, ghost };
    this.dragCol = -1;
    this.dragRow = -1;

    this.handView.setSelectedCard(handIndex);
    this.updateCardDragHighlights(-1, -1);
  }

  private commitCardDrag(col: number, row: number): void {
    if (!this.drag || this.drag.kind !== 'card') return;
    const { handIndex, cardType, spellType } = this.drag;

    switch (cardType) {
      case CardType.Unit: {
        if (!(ATTACK_LANES as readonly number[]).includes(col)) { this.cancelDrag(); return; }
        const spawnFree = !this.engine.state.board.isCellOccupiedByUnit(col, BOTTOM_BUILDING_ROW + 1);
        if (!spawnFree) { this.cancelDrag(); return; }
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Building: {
        if (this.engine.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) { this.cancelDrag(); return; }
        this.engine.playCard(handIndex, col);
        break;
      }
      case CardType.Spell: {
        if (spellType === SpellType.Haste) {
          this.engine.playCard(handIndex, 0);
        } else if (spellType === SpellType.Meteor) {
          this.engine.playCard(handIndex, col, row);
        }
        break;
      }
    }

    this.cancelDrag();
  }

  private updateCardDragHighlights(col: number, _row: number): void {
    if (!this.drag || this.drag.kind !== 'card') return;
    this.boardView.clearHighlights();

    switch (this.drag.cardType) {
      case CardType.Unit: {
        const blockedCols = new Set<number>();
        for (const lane of ATTACK_LANES) {
          if (this.engine.state.board.isCellOccupiedByUnit(lane, BOTTOM_BUILDING_ROW + 1)) {
            blockedCols.add(lane);
          }
        }
        this.boardView.showUnitLaneHighlights(Array.from(ATTACK_LANES), blockedCols, col);
        break;
      }
      case CardType.Building: {
        const validCols: number[] = [];
        for (let c = 0; c < BOARD_COLS; c++) {
          if (!(ATTACK_LANES as readonly number[]).includes(c)) continue;
          if (!this.engine.state.board.hasBuildingAt(c, BOTTOM_BUILDING_ROW)) validCols.push(c);
        }
        this.boardView.showBuildingHighlights(validCols, BOTTOM_BUILDING_ROW);
        break;
      }
      case CardType.Spell: {
        if (this.drag.spellType === SpellType.Meteor) {
          this.boardView.showMeteorHighlights();
        }
        break;
      }
    }
  }

  // ─── Upgrade drag ─────────────────────────────────────────────────────────

  private startUpgradeDrag(cx: number, cy: number): void {
    const player = this.engine.state.bottomPlayer;
    if (!player.canUpgradeBase()) return;

    const cost  = player.nextUpgradeCost!;
    const ghost = this.buildDragGhost('↑ 升级', cost, 0xffcc00);
    ghost.x = cx;
    ghost.y = cy;
    this.container.addChild(ghost);

    this.drag = { kind: 'upgrade', ghost };
    this.boardView.showBaseUpgradeHighlight(false);
  }

  // ─── Shared drag helpers ──────────────────────────────────────────────────

  private cancelDrag(): void {
    if (!this.drag) return;
    this.drag.ghost.parent?.removeChild(this.drag.ghost);
    this.drag.ghost.destroy();
    this.drag = null;
    this.dragCol = -1;
    this.dragRow = -1;
    this.handView.clearSelection();
    this.boardView.clearHighlights();
  }

  private isOverRect(x: number, y: number, rect: { x: number; y: number; w: number; h: number }): boolean {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
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
