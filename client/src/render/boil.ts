/**
 * boil.ts — "boiling lines", the soul of hand-drawn animation.
 *
 * Art direction §5.4: emphasis elements (titles, selection frames, hover marks)
 * should look alive — the line subtly wobbles frame to frame. We get that for
 * almost zero memory/CPU by baking N variants of the same drawing, each with a
 * different `Prng` seed (so the scrawl differs), then cycling which one is shown
 * at ~8fps. Nothing is redrawn per frame; we only flip sprite visibility.
 *
 * Static board/grid art does NOT boil (information carriers must stay still);
 * this is for charm accents only.
 */
import * as PIXI from 'pixi.js-legacy';
import { SketchPen } from './sketch';
import { bake } from './bake';

export interface BoilOpts {
  /** Number of baked variants to cycle (default 3). */
  variants?: number;
  /** Frames per second of the cycle (default 8 — the classic boil rate). */
  fps?:      number;
  /** Unique tag for the bake cache key (distinguishes same-size drawings). */
  tag?:      string;
}

/**
 * A container that cycles between a few baked variants of one hand-drawn shape.
 * Provide a `draw(pen, g)` callback that strokes into the given Graphics with
 * the supplied seeded pen; it is invoked once per variant with a fresh seed.
 */
export class BoilingSprite extends PIXI.Container {
  private readonly frames: PIXI.DisplayObject[] = [];
  private readonly interval: number;
  private acc = 0;
  private idx = 0;
  private readonly tick: () => void;

  constructor(
    w: number, h: number,
    draw: (pen: SketchPen, g: PIXI.Graphics) => void,
    opts: BoilOpts = {},
  ) {
    super();
    const n   = Math.max(2, opts.variants ?? 3);
    const fps = opts.fps ?? 8;
    this.interval = 1 / fps;

    for (let i = 0; i < n; i++) {
      const g = new PIXI.Graphics();
      draw(new SketchPen(g, 0x9e37 + i * 0x61c8 + 1), g);
      const tag = opts.tag ?? 'x';
      const tex = bake(`boil:${tag}:${Math.round(w)}x${Math.round(h)}:${i}:${n}`, g, w, h);
      if (tex) { this.frames.push(new PIXI.Sprite(tex)); g.destroy(); }
      else     { this.frames.push(g); }            // headless: keep live graphics
    }
    this.frames.forEach((f, i) => { f.visible = i === 0; this.addChild(f); });
    this.eventMode = 'none';

    this.tick = (): void => {
      this.acc += PIXI.Ticker.shared.deltaMS / 1000;
      if (this.acc < this.interval) return;
      this.acc = 0;
      this.frames[this.idx]!.visible = false;
      this.idx = (this.idx + 1) % this.frames.length;
      this.frames[this.idx]!.visible = true;
    };
    PIXI.Ticker.shared.add(this.tick);
  }

  override destroy(opts?: Parameters<PIXI.Container['destroy']>[0]): void {
    PIXI.Ticker.shared.remove(this.tick);
    super.destroy(opts);
  }
}
