import { grid_count_h, grid_count_w, index } from './helper';

class Logic {
  private numbers: Map<number, number> = new Map();

  public Initialize(target: number): void {
    this.numbers.clear();
    const w = grid_count_w();
    const h = grid_count_h();
    // console.log('logic w: ', w, 'h:', h);
    const n: number[] = [];
    const count = (w * h) / 2;
    for (let i = 0; i < count; ++i) {
      // const rdm = Math.random() * 100000 % 9;
      // console.log('random: ', rdm);
      const first = Math.floor((Math.random() * 1000000) % 9) + 1;
      const second = target - first;
      n.push(first, second);
    }
    this.shuffle(n);
    for (let i = 0; i < w; ++i) {
      for (let j = 0; j < h; ++j) {
        const s = index(i, j);
        this.numbers.set(s, n.pop() ?? 0);
      }
    }
    // console.log('nums: ', this.numbers, ' n: ', n);
  }

  public getNumber(x: number, y: number): number {
    const s = index(x, y);
    const v = this.numbers.get(s) ?? 0;
    // console.log('get number, s: ', s, 'v: ', v);
    return v;
  }

  public getNumberByIndex(index: number): number {
    return this.numbers.get(index) ?? 0;
  }

  private shuffle(arr: number[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

export const logic = new Logic();
