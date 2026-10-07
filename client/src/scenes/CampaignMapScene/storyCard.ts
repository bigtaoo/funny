import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { ui as C, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildFittedSprite } from '../../render/cardArt';
import { UI_FONT_FAMILY } from '../../render/theme';

// ── One-shot story card over the campaign map (ONBOARDING_DESIGN §11.7) ─────────
//
// The opening story used to be a 7-line IntroScene before the first screen (~35 s of reading
// before anything playable). It now lives here, compressed to one illustration + one line, the
// first time the campaign map opens — which for most new players is right after their first real
// level, so the copy is "this is whose world you're fighting in", not "the story begins". The full
// version stays reachable from settings ("Replay story").
//
// Budget: on screen ≤ 3 s. Any tap dismisses it (and is swallowed, so it can't also select a level
// under the card); otherwise it fades out by itself. No button, no hint text — one line is the rule.

const FADE_IN = 0.35;   // seconds
const HOLD_UNTIL = 2.65; // seconds from open at which the auto fade-out starts (ends at 3.0 s)
const FADE_OUT = 0.35;  // seconds
const BACKDROP_ALPHA = 0.55;
/** Source art aspect (assets/story/*.png are 1200×800). */
const ART_ASPECT = 1.5;

export interface StoryCardSpec {
  illustrationUrl: string;
  /** Pre-translated single line. */
  text: string;
  /** Fires exactly once. `skipped` = dismissed by a tap rather than the timer. */
  onDone(skipped: boolean): void;
}

export class StoryCard {
  readonly container = new PIXI.Container();
  private t = 0;
  private closingFrom: number | null = null;
  private skipped = false;
  private finished = false;

  constructor(w: number, h: number, private readonly spec: StoryCardSpec) {
    const backdrop = new PIXI.Graphics();
    backdrop.beginFill(0x000000, BACKDROP_ALPHA);
    backdrop.drawRect(0, 0, w, h);
    backdrop.endFill();
    this.container.addChild(backdrop);

    // Card = illustration (contain-fit, so a portrait screen doesn't crop the two figures off the
    // sides the way IntroScene's full-bleed cover fit does) with the line underneath.
    const pad = Math.round(Math.min(w, h) * 0.025);
    const textW = Math.min(w * 0.86, h * 0.6 * ART_ASPECT);
    const artW = Math.round(textW - pad * 2);
    const artH = Math.round(artW / ART_ASPECT);
    const line = makeText(spec.text, {
      fontSize: FS.heading,
      fill: C.dark,
      fontFamily: UI_FONT_FAMILY,
      wordWrap: true,
      wordWrapWidth: artW,
      align: 'center',
      lineHeight: Math.round(FS.heading * 1.35),
    });
    const cardW = Math.round(textW);
    const cardH = pad + artH + pad + Math.ceil(line.height) + pad;
    const cardX = Math.round((w - cardW) / 2);
    const cardY = Math.round((h - cardH) / 2);

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2, seed: seedFor(cardX, cardY, cardW) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    const art = buildFittedSprite(spec.illustrationUrl, artW, artH);
    const artBox = new PIXI.Container();
    artBox.x = cardX + pad; artBox.y = cardY + pad;
    artBox.addChild(art);
    this.container.addChild(artBox);

    line.anchor.set(0.5, 0);
    line.x = w / 2;
    line.y = cardY + pad + artH + pad;
    this.container.addChild(line);

    this.container.alpha = 0;
  }

  get done(): boolean { return this.finished; }

  /** A tap anywhere: start closing now (the tap itself is consumed by the host). */
  dismiss(): void {
    if (this.closingFrom !== null) return;
    this.skipped = true;
    this.closingFrom = this.t;
  }

  update(dt: number): void {
    if (this.finished) return;
    this.t += dt;
    if (this.closingFrom === null && this.t >= HOLD_UNTIL) this.closingFrom = this.t;
    if (this.closingFrom === null) {
      this.container.alpha = Math.min(1, this.t / FADE_IN);
      return;
    }
    // Close from wherever the fade-in had got to, so an early tap doesn't pop to full alpha first.
    const from = Math.min(1, this.closingFrom / FADE_IN);
    const k = (this.t - this.closingFrom) / FADE_OUT;
    this.container.alpha = Math.max(0, from * (1 - k));
    if (k >= 1) {
      this.finished = true;
      this.spec.onDone(this.skipped);
    }
  }

  destroy(): void {
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }
}
