import { config } from './config';
import { OFFSET_Y } from './consts';
import { Orientation } from './enums';

export const offset_x = () => {
  if (config.Orientation === Orientation.Landscape) {
    return 300;
  }
  return 100;
};

export const grid_size = () => {
  return 120;
};

export const grid_count_w = () => {
  if (config.Orientation === Orientation.Landscape) {
    return 12;
  }
  return 6;
};

export const grid_count_h = () => {
  if (config.Orientation === Orientation.Landscape) {
    return 6;
  }
  return 12;
};

export const index = (x: number, y: number): number => {
  return x * 1000 + y;
};

export const get_pos = (ix: number): any => {
  const w = Math.floor(ix / 1000);
  const h = ix - w * 1000;
  const x = w * grid_size() + offset_x();
  const y = h * grid_size() + OFFSET_Y;
  // console.log(`get pos x: ${x}, y: ${y}, index: ${ix}, w: ${w}, h: ${h}`)
  return { x, y };
};
