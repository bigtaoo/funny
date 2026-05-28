import * as PIXI from 'pixi.js-legacy';
import { GameEngine } from '../game/GameEngine';
import { GameState } from '../game/GameState';
import {
  ATTACK_LANES,
  BOARD_COLS,
  BOTTOM_BUILDING_ROW,
} from '../game/config';
import { GameEvent, CardType, SpellType } from '../game/types';
import { BoardView } from './BoardView';
import { BuildingView } from './BuildingView';
import { HandView } from './HandView';
import { HUDView } from './HUDView';
import { UnitView } from './UnitView';

export interface GameRendererConfig {
  width:            number;
  height:           number;
  canvas?:          HTMLCanvasElement;
  devicePixelRatio?: number;
}

// Placement modes: what kind of card is waiting for a board target
type PlacementMode = 'unit' | 'building' | 'spell_meteor' | null;

export class GameRenderer {
  readonly app: PIXI.Application;
  private readonly engine: GameEngine;

  private boardView!:    BoardView;
  private unitView!:     UnitView;
  private buildingView!: BuildingView;
  private handView!:     HandView;
  private hudView!:      HUDView;

  // Placement state
  private placementMode:      PlacementMode = null;
  private selectedHandIndex:  number | null = null;

  constructor(engine: GameEngine, config: GameRendererConfig) {
    this.engine = engine;

    this.app = new PIXI.Application({
      width:           config.width,
      height:          config.height,
      backgroundColor: 0xf5f0e8, // notebook paper
      view:            config.canvas,
      antialias:       false,
      resolution:      config.devicePixelRatio ?? 1,
      autoDensity:     true,
    });
  }

  async init(): Promise<void> {
    await this.loadAssets();
    this.buildSceneGraph();
    this.app.ticker.add(this.onTick, this);
  }

  destroy(): void {
    this.app.ticker.remove(this.onTick, this);
    this.app.destroy(true);
  }

  // ─── Scene graph ──────────────────────────────────────────────────────────

  private async loadAssets(): Promise<void> {
    // Placeholder — load sprite sheets here when art is ready
  }

  private buildSceneGraph(): void {
    const { width, height } = this.app.screen;

    this.boardView    = new BoardView(width, height);
    this.unitView     = new UnitView(this.boardView);
    this.buildingView = new BuildingView(this.boardView);
    this.handView     = new HandView(width, height);
    this.hudView      = new HUDView(width, height);

    // Layer order: board → units → buildings → hand → HUD
    this.app.stage.addChild(this.boardView.container);
    this.app.stage.addChild(this.unitView.container);
    this.app.stage.addChild(this.buildingView.container);
    this.app.stage.addChild(this.handView.container);
    this.app.stage.addChild(this.hudView.container);

    // ── Wire interactions ─────────────────────────────────────────────────

    // Card selected → enter placement mode
    this.handView.onCardSelected = (handIndex) => {
      this.onCardSelected(handIndex);
    };

    // Board tapped during placement → confirm target
    this.boardView.onCellTap = (col, row) => {
      this.onBoardTap(col, row);
    };

    // Upgrade button → queue command
    this.hudView.onUpgradePressed = () => {
      this.engine.upgradeBase();
    };
  }

  // ─── Render loop ──────────────────────────────────────────────────────────

  private onTick = (): void => {
    // Use ticker.deltaMS for accurate wall-clock dt (ms → s)
    const dt = this.app.ticker.deltaMS / 1000;
    this.engine.tick(dt);

    const state = this.engine.state;

    for (const event of state.events) {
      this.handleEvent(event, state);
    }

    // Sync visual state every frame
    this.unitView.sync(state.board);
    this.buildingView.sync(state.board);
    this.handView.sync(state.bottomPlayer);
    this.hudView.sync(state);
  };

  // ─── Event handling ───────────────────────────────────────────────────────

  private handleEvent(event: GameEvent, _state: GameState): void {
    switch (event.type) {
      case 'unit_attack_hit':
        this.unitView.playHitEffect(event.targetId);
        break;

      case 'unit_died':
        this.unitView.playDeathEffect(event.unitId);
        break;

      case 'building_destroyed':
        this.buildingView.playDestroyEffect(event.buildingId);
        break;

      case 'spell_cast':
        if (event.spellType === SpellType.Meteor) {
          const row = Math.round(event.center.y_fp / 1000);
          this.boardView.playMeteorEffect(event.center.col, row);
        }
        break;

      case 'card_played':
        // Clear placement mode once the engine confirms the card was played
        if (event.owner === 0) this.clearPlacement();
        break;

      case 'game_over':
        this.clearPlacement();
        this.hudView.showGameOver(event.winner);
        break;
    }
  }

  // ─── Placement state machine ──────────────────────────────────────────────

  private onCardSelected(handIndex: number): void {
    const player = this.engine.state.bottomPlayer;
    const card   = player.hand.cards[handIndex];
    if (!card) return;

    // Tapping the same card again → deselect
    if (this.selectedHandIndex === handIndex) {
      this.clearPlacement();
      return;
    }

    this.selectedHandIndex = handIndex;
    this.handView.setSelectedCard(handIndex);

    switch (card.cardType) {
      case CardType.Unit: {
        this.placementMode = 'unit';
        this.boardView.showLaneHighlights();
        break;
      }

      case CardType.Building: {
        this.placementMode = 'building';
        // Valid columns: any column not already occupied in the player's building row
        const validCols: number[] = [];
        for (let col = 0; col < BOARD_COLS; col++) {
          if (!this.engine.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) {
            validCols.push(col);
          }
        }
        this.boardView.showBuildingHighlights(validCols, BOTTOM_BUILDING_ROW);
        break;
      }

      case CardType.Spell: {
        if (card.spellType === SpellType.Haste) {
          // Haste: no targeting — play immediately
          this.handView.clearSelection();
          this.selectedHandIndex = null;
          this.engine.playCard(handIndex, 0); // col ignored by engine for Haste
          // No need to set placementMode; clearPlacement handles cleanup via card_played event
        } else if (card.spellType === SpellType.Meteor) {
          this.placementMode = 'spell_meteor';
          this.boardView.showMeteorHighlights();
        }
        break;
      }
    }
  }

  private onBoardTap(col: number, row: number): void {
    if (this.placementMode === null || this.selectedHandIndex === null) return;

    const handIndex = this.selectedHandIndex;

    switch (this.placementMode) {
      case 'unit': {
        // Only valid attack lanes
        if (!(ATTACK_LANES as readonly number[]).includes(col)) return;
        this.engine.playCard(handIndex, col);
        break;
      }

      case 'building': {
        if (this.engine.state.board.hasBuildingAt(col, BOTTOM_BUILDING_ROW)) return;
        this.engine.playCard(handIndex, col);
        break;
      }

      case 'spell_meteor': {
        this.engine.playCard(handIndex, col, row);
        break;
      }
    }

    // Visual cleanup happens via card_played event in handleEvent
    // but clear immediately for snappier feel
    this.clearPlacement();
  }

  private clearPlacement(): void {
    this.placementMode     = null;
    this.selectedHandIndex = null;
    this.handView.clearSelection();
    this.boardView.clearHighlights();
  }
}
