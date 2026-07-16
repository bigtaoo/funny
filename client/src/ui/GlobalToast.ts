import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../render/sketchUi';

// Global fallback toast: a temporary banner that floats above all scenes, used exclusively by
// createAppCore / the global error handler when a scene has no toast of its own (fallback for
// non-200 responses / network failures). Each scene still uses its own showToast — this is just
// a safety net for errors that slip through.
//
// Attached directly to app.stage (screen-pixel coordinates, not the gameLayer design space), so it
// is unaffected by Contain scaling or scene transitions; position is recalculated each frame from
// app.screen, which naturally follows window resizes.

const HOLD_S = 3.2;  // fully-opaque hold duration (seconds)
const FADE_S = 0.3;  // fade-in / fade-out duration each (seconds)

export class GlobalToast {
  private readonly layer = new PIXI.Container();
  private current: PIXI.Container | null = null;
  private age = 0;
  private ttl = 0;

  constructor(private readonly app: PIXI.Application) {
    this.layer.zIndex = 10_000; // covers all scene content
    app.stage.sortableChildren = true;
    app.stage.addChild(this.layer);
    app.ticker.add(this.tick, this);
  }

  /** Show a toast (default: red error bar). Repeated calls replace the current toast. */
  show(text: string, color: number = C.red): void {
    this.clear();
    const { width: w, height: h } = this.app.screen;
    const lbl = txt(text, Math.round(h * 0.052), 0xffffff, true);
    const padX = Math.round(w * 0.08);
    const padY = Math.round(h * 0.024);
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 2 / 3 - bh / 2);
    const bg = sketchPanel(bw, bh, {
      fill: color, fillAlpha: 0.95, border: color, width: 2, seed: seedFor(bw, bh, 2),
    });
    bg.x = bx; bg.y = by;
    lbl.anchor.set(0.5, 0.5);
    lbl.x = bx + bw / 2;
    lbl.y = by + bh / 2;

    const c = new PIXI.Container();
    c.alpha = 0;
    c.addChild(bg, lbl);
    this.layer.addChild(c);
    this.current = c;
    this.age = 0;
    this.ttl = FADE_S + HOLD_S + FADE_S;
  }

  private tick = (): void => {
    if (!this.current) return;
    this.age += this.app.ticker.deltaMS / 1000;
    const remain = this.ttl - this.age;
    if (remain <= 0) { this.clear(); return; }
    // Fade-in: min(age/FADE), fade-out: min(remain/FADE), take the smaller → trapezoid alpha curve.
    this.current.alpha = Math.min(1, this.age / FADE_S, remain / FADE_S);
  };

  private clear(): void {
    if (!this.current) return;
    this.layer.removeChild(this.current);
    this.current.destroy({ children: true });
    this.current = null;
  }
}
