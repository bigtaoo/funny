import { Orientation } from './enums';

class Config {
  public Width: number = 100;
  public Height: number = 100;
  public Scale: number = 1;
  public Orientation: Orientation = Orientation.Portrait;
  public Target: number = 10;
  public TimeCount: number = 30;
}

export const config = new Config();
