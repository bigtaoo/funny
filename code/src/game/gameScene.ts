import * as PIXI from 'pixi.js-legacy';
import { GAME_HEIGHT, GAME_WIDTH } from './consts';
import { AssetsManager } from '../assetsManager/assetsManager';
import { config } from './config';
import { Numbers } from './numbers';
import { Grid } from './grid';
import { Orientation } from './enums';
import { display } from './display';
import { EffectManager } from './effectManager';
import { Header } from './header';

export class GameScene extends PIXI.Container {
  private numbers: Numbers;
  private grids: Grid;
  private effectManager: EffectManager;
  private background: PIXI.Sprite | undefined;

  constructor() {
    super();

    this.numbers = new Numbers(this);
    this.grids = new Grid(this);
    this.effectManager = new EffectManager(this);

    display.Initialize(this.grids, this.numbers, this.effectManager);
  }

  public Resize(windowWidth: number, windowHeight: number): void {
    if (windowWidth > windowHeight) {
      config.Width = GAME_HEIGHT;
      config.Height = GAME_WIDTH;
      config.Orientation = Orientation.Landscape;
    } else {
      config.Width = GAME_WIDTH;
      config.Height = GAME_HEIGHT;
      config.Orientation = Orientation.Portrait;
    }
    const scale = Math.min(windowWidth / config.Width, windowHeight / config.Height);

    config.Scale = scale;
    this.x = (windowWidth - config.Width * scale) / 2;
    this.y = (windowHeight - config.Height * scale) / 2;
    this.width = config.Width;
    this.height = config.Height;
    this.scale.set(scale);

    console.log('window w: ', windowWidth, 'window h: ', windowHeight, 'scale: ', scale);
  }

  public Draw(): void {
    this.drawBackground();
    this.grids.DrawGrids();
    this.numbers.DrawNumbers();

    const header = new Header();
    this.addChild(header);
  }

  public Update(delta: number): void {
    this.effectManager.Update(delta);
  }

  private drawBackground(): void {
    if (!this.background) {
      this.background = new PIXI.Sprite(AssetsManager().GetTexture('background.png'));
      this.addChild(this.background);
    }
    this.background.width = config.Width;
    this.background.height = config.Height;
    this.background.x = 0;
    this.background.y = 0;
  }
}
