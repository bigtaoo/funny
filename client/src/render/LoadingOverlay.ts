/**
 * LoadingOverlay — the first-load gate's visible face (ASSET_PACKAGING §3).
 *
 * A minimal notebook-paper loading screen drawn on top of the PIXI stage while
 * `preloadBoot` runs. Language-neutral (i18n isn't initialised yet at this point
 * in boot): just a hand-drawn progress bar + percentage on the paper background.
 * Destroyed once the L0 tier is ready, immediately before the first scene shows.
 */
import * as PIXI from 'pixi.js-legacy';
import { FS } from './fontScale';

const INK = 0x3a3a3a;        // pencil/pen ink
const HIGHLIGHT = 0x4a7fb5;  // faction-blue highlighter wash (our side, §3.2)
const PAPER = 0xf5f0e8;      // same as PIXI.Application backgroundColor

export class LoadingOverlay {
  private readonly container = new PIXI.Container();
  private readonly bg = new PIXI.Graphics();
  private readonly bar = new PIXI.Graphics();
  private readonly pct: PIXI.Text;
  private progress = 0;

  constructor(private readonly app: PIXI.Application) {
    const { width, height } = app.screen;

    // Opaque paper sheet so the half-built scene underneath never peeks through.
    this.bg.beginFill(PAPER).drawRect(0, 0, width, height).endFill();
    this.container.addChild(this.bg);

    this.pct = new PIXI.Text('0%', {
      fontFamily: 'sans-serif',
      fontSize: FS.body,
      fill: INK,
    });
    this.pct.anchor.set(0.5);
    this.container.addChild(this.bar, this.pct);

    this.redraw();
    app.stage.addChild(this.container); // top-most: added after all other layers
  }

  /** p in [0,1]. */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
    this.redraw();
  }

  private redraw(): void {
    const { width, height } = this.app.screen;
    const barW = Math.min(360, width * 0.6);
    const barH = 12;
    const x = (width - barW) / 2;
    const y = height / 2;
    const r = barH / 2;

    this.bar.clear();
    // Track outline (hand-drawn capsule).
    this.bar.lineStyle(2, INK, 1).drawRoundedRect(x, y, barW, barH, r);
    // Fill.
    const fillW = barW * this.progress;
    if (fillW > 1) {
      this.bar.lineStyle(0).beginFill(HIGHLIGHT, 0.85)
        .drawRoundedRect(x, y, Math.max(fillW, barH), barH, r).endFill();
    }

    this.pct.text = `${Math.round(this.progress * 100)}%`;
    this.pct.position.set(width / 2, y + barH + 22);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
