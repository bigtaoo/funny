import { config } from './config';
import { EffectManager } from './effectManager';
import { Grid } from './grid';
import { logic } from './logic';
import { Numbers } from './numbers';

class Display {
  private grids: Grid | undefined;
  private numbers: Numbers | undefined;
  private effects: EffectManager | undefined;
  private slectedIndex: number = -1;

  constructor() {}

  public Initialize(g: Grid, n: Numbers, e: EffectManager): void {
    this.grids = g;
    this.numbers = n;
    this.effects = e;
  }

  public OnClick(index: number) {
    // console.log('clicked index: ', index);
    if (this.slectedIndex === -1) {
      this.slectedIndex = index;
      this.grids?.DrawSelectedImage(index);
    } else if (this.slectedIndex === index) {
      return;
    } else {
      const selectedValue = logic.getNumberByIndex(this.slectedIndex);
      const currentValue = logic.getNumberByIndex(index);
      if (selectedValue + currentValue === config.Target) {
        this.grids?.HideSelctedImage();
        this.grids?.HideGrid(this.slectedIndex);
        this.grids?.HideGrid(index);
        this.numbers?.HideNumber(this.slectedIndex);
        this.numbers?.HideNumber(index);
        this.effects?.PlayEffect(index);
        this.effects?.PlayEffect(this.slectedIndex);
        this.slectedIndex = -1;
      } else {
        this.slectedIndex = index;
        this.grids?.DrawSelectedImage(index);
      }
    }
  }
}

export const display = new Display();
