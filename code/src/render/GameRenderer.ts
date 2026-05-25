import * as PIXI from 'pixi.js-legacy';
import { GameEngine } from '../game/GameEngine';
import { GameEvent, GameState } from '../game/GameState';
import { BoardView } from './BoardView';
import { BuildingView } from './BuildingView';
import { HandView } from './HandView';
import { HUDView } from './HUDView';
import { UnitView } from './UnitView';

export interface GameRendererConfig {
  width: number;
  height: number;
  canvas?: HTMLCanvasElement;
  devicePixelRatio?: number;
}

export class GameRenderer {
  readonly app: PIXI.Application;
  private readonly engine: GameEngine;

  private boardView!: BoardView;
  private unitView!: UnitView;
  private buildingView!: BuildingView;
  private handView!: HandView;
  private hudView!: HUDView;

  constructor(engine: GameEngine, config: GameRendererConfig) {
    this.engine = engine;

    this.app = new PIXI.Application({
      width: config.width,
      height: config.height,
      backgroundColor: 0xf5f0e8, // notebook paper
      view: config.canvas,
      antialias: false,
      resolution: config.devicePixelRatio ?? 1,
      autoDensity: true,
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

  private async loadAssets(): Promise<void> {
    // TODO: load sprite sheets when art is ready
    // PIXI.Assets.add('units', 'assets/units.json');
    // await PIXI.Assets.load('units');
  }

  private buildSceneGraph(): void {
    const { width, height } = this.app.screen;

    this.boardView = new BoardView(width, height);
    this.unitView = new UnitView();
    this.buildingView = new BuildingView();
    this.handView = new HandView(width, height);
    this.hudView = new HUDView(width, height);

    this.app.stage.addChild(this.boardView.container);
    this.app.stage.addChild(this.unitView.container);
    this.app.stage.addChild(this.buildingView.container);
    this.app.stage.addChild(this.handView.container);
    this.app.stage.addChild(this.hudView.container);

    // Wire hand interactions → game engine
    this.handView.onCardPlayed = (handIndex, col, row) => {
      this.engine.playCard(handIndex, col, row);
    };
  }

  private onTick = (deltaFrame: number): void => {
    const dt = deltaFrame / 60; // PIXI ticker uses frames at 60fps
    this.engine.tick(dt);

    const state = this.engine.state;

    // Process events
    for (const event of state.events) {
      this.handleEvent(event, state);
    }

    // Sync render state
    this.unitView.sync(state.board);
    this.buildingView.sync(state.board);
    this.handView.sync(state.bottomPlayer);
    this.hudView.sync(state);
  };

  private handleEvent(event: GameEvent, state: GameState): void {
    switch (event.type) {
      case 'unit_attacked':
        this.unitView.playHitEffect(event.targetId);
        break;
      case 'unit_died':
        this.unitView.playDeathEffect(event.unitId);
        break;
      case 'building_destroyed':
        this.buildingView.playDestroyEffect(event.buildingId);
        break;
      case 'spell_cast':
        if (event.spellType === 'meteor') {
          this.boardView.playMeteorEffect(event.col!, event.row!);
        }
        break;
      case 'game_over':
        this.hudView.showGameOver(event.winner);
        break;
    }
  }
}
