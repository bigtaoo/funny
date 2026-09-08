/**
 * AgeGateDialog — the neutral age gate shown once, before anything else (COMPLIANCE_GLOBAL §3.4,
 * `privacy-policy §9`: the game is self-rated 13+ and is not directed at children).
 *
 * Two things make this a *neutral* gate rather than a yes/no question, and both are deliberate:
 *
 *  * It asks for a **birth year**, not "are you over 13" — a question whose right answer is
 *    visible from the question biases the answer, which is exactly what a neutral gate must not do.
 *    The year starts 30 years back (a value that is neither the threshold nor an obvious pass) and
 *    moves by ±1 / ±10 taps, so no soft keyboard is involved and the screen behaves identically on
 *    web, the native shell and WeChat.
 *  * A declared age **below** the threshold gets a second, explicit confirmation before it is
 *    recorded. The recorded answer is permanent (see below), so the one mis-tap that would matter
 *    is the one this catches.
 *
 * The answer lands in `flags.ageOk` and is therefore permanent per account: this screen is not a
 * dismissible prompt, and a player who declared an age below the threshold lands on the blocked
 * card on every launch afterwards, with the support address as the only way out. That is the point
 * of an age gate — one that forgets is decoration.
 *
 * No telemetry leaves the device from here: the age gate runs *before* {@link ConsentDialog}
 * (see `createAppCore.gateConsent`), so it is on screen while analytics consent is still unknown.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawButtonLabel } from '../widgets/buttonLabel';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { tapHandler } from '../hits';
import { MIN_AGE_YEARS } from '../../app/appConstants';

/**
 * 'ask' collects the birth year; 'blocked' is the dead end shown to a player whose recorded
 * declaration is below the threshold (both right after they confirm it and on every later launch).
 */
export type AgeGateMode = 'ask' | 'blocked';

export interface AgeGateCallbacks {
  /**
   * The player confirmed `birthYear`. The core — not this dialog — decides what that means and
   * records it; the dialog only uses `minAge` to know when to ask for confirmation first.
   * Never called in 'blocked' mode.
   */
  onDeclared(birthYear: number): void;
}

/** How far back the stepper can reach, and where it starts (years before the current one). */
const MAX_AGE = 100;
const START_OFFSET = 30;
/** A stepper at the end of its range stays on screen at this alpha — dimmed, not missing. */
const DISABLED_ALPHA = 0.35;

export class AgeGateDialog implements Scene {
  readonly container: PIXI.Container;

  /** Current stepper value; only meaningful in 'ask' mode. */
  private year: number;
  /** Set once the player has confirmed a below-threshold year and is being asked to confirm it. */
  private confirming = false;
  /**
   * The live year label and the four stepper groups. A stepper tap updates these IN PLACE rather
   * than rebuilding the card: a full rebuild destroys the very button the gesture is on, and two
   * quick taps then land as one (measured in a real browser — the second tap was simply lost).
   * Switching cards (ask ⇄ confirm) still rebuilds; that is one tap, not a repeated one.
   */
  private yearText: PIXI.Text | null = null;
  private steps: Array<{ g: PIXI.Container; delta: number }> = [];

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly mode: AgeGateMode,
    private readonly cb: AgeGateCallbacks,
    /** The threshold this screen warns about. The core still decides what the answer means. */
    private readonly minAge: number = MIN_AGE_YEARS,
    /** Injectable for tests — the real clock is the only thing here that is not deterministic. */
    private readonly thisYear: number = new Date().getFullYear(),
  ) {
    this.container = new PIXI.Container();
    this.year = this.thisYear - START_OFFSET;
    this.build();
  }

  update(): void { /* static */ }

  destroy(): void {
    this.container.removeAllListeners();
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }

  /** Declared age in whole years, at year granularity (what a birth-year gate can know). */
  private declaredAge(): number {
    return this.thisYear - this.year;
  }

  private rebuild(): void {
    this.container.removeAllListeners();
    tearDownChildren(this.container); // frees Text baseTextures too — see its doc comment
    this.yearText = null;
    this.steps = [];
    this.build();
  }

  /** Whether `year` is a year someone could have been born in and still be playing. */
  private inRange(year: number): boolean {
    return year <= this.thisYear && year >= this.thisYear - MAX_AGE;
  }

  /** Move the year by `delta`, or do nothing at the ends of the range. */
  private step(delta: number): void {
    if (!this.inRange(this.year + delta)) return;
    this.year += delta;
    if (this.yearText) this.yearText.text = String(this.year);
    for (const s of this.steps) s.g.alpha = this.inRange(this.year + s.delta) ? 1 : DISABLED_ALPHA;
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('agegatebg', w, h));

    // Dim + swallow taps: like ConsentDialog, the backdrop is not a dismiss affordance.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);

    // Same orientation-aware card sizing as ConsentDialog (its comment explains the two cases);
    // `unit` is the minimum height, so type scale stays put even when the card grows to fit.
    const landscape = w > h;
    const cardHmin = landscape
      ? Math.round(h * 0.8)
      : Math.round(Math.min(h * 0.72, w * 0.9 * 1.15));
    const cardW = landscape
      ? Math.round(Math.min(cardHmin * 0.95, w * 0.7))
      : Math.round(w * 0.9);
    const cardX = (w - cardW) / 2;
    const unit = cardHmin;

    const blocked = this.mode === 'blocked';
    const title = txt(
      t(blocked ? 'ageGate.blockedTitle' : this.confirming ? 'ageGate.confirmTitle' : 'ageGate.title'),
      snapFont(Math.round(unit * 0.07)), C.dark, true,
    );
    title.anchor.set(0.5, 0);

    const body = makeText(
      blocked ? t('ageGate.blockedBody', { min: this.minAge })
        : this.confirming ? t('ageGate.confirmBody', { year: this.year })
        : t('ageGate.body'),
      {
        fontSize: snapFont(Math.round(unit * 0.04)), fill: C.dark, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: cardW * 0.84, breakWords: true, lineHeight: Math.round(unit * 0.06),
      },
    );
    body.anchor.set(0.5, 0);

    // Layout, top-down, with the same gap vocabulary as ConsentDialog.
    const padTop = unit * 0.06;
    const gapTitleBody = unit * 0.07;
    const gapBodyRow = unit * 0.07;
    const stepH = Math.round(unit * 0.11);
    const bH = Math.round(unit * 0.12);
    const gapRowBtn = unit * 0.07;
    const gapBtnBtn = unit * 0.04;
    const padBottom = unit * 0.06;

    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;
    // 'blocked' has no stepper and no buttons at all — it is a dead end by construction, so it
    // must not reserve the gap that would have preceded the stepper row either.
    const dyRow = dyBody + body.height + (blocked ? 0 : gapBodyRow);
    const rowH = blocked || this.confirming ? 0 : stepH + gapRowBtn;
    const dyBtn = dyRow + rowH;
    const btnRows = blocked ? 0 : this.confirming ? 2 : 1;
    const btnBlockH = btnRows === 0 ? 0 : btnRows * bH + (btnRows - 1) * gapBtnBtn;
    const contentH = (btnRows === 0 ? dyRow : dyBtn + btnBlockH) + padBottom;

    // Unlike ConsentDialog (whose long consent text fills the card), this card holds four short
    // lines: honouring `cardHmin` as a minimum left a third of the card empty below the button.
    // `unit` still derives from cardHmin, so the type scale is the consent screen's — only the box
    // shrinks. The cap keeps the tallest state (the confirm card, in German) on screen.
    const cardH = Math.min(Math.round(contentH), Math.round(h * 0.9));
    const cardY = Math.round((h - cardH) / 2);

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 1) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    title.x = w / 2; title.y = cardY + dyTitle;
    this.container.addChild(title);
    body.x = w / 2; body.y = cardY + dyBody;
    this.container.addChild(body);

    if (blocked) return;

    // Everything below sits inside the card's side padding — a button drawn at the full card width
    // touches the hand-drawn border and reads as part of it.
    const padX = Math.round(cardW * 0.07);
    const innerX = cardX + padX;
    const innerW = cardW - 2 * padX;
    const btnW = Math.round(cardW * 0.6);
    const btnX = cardX + Math.round((cardW - btnW) / 2);

    if (this.confirming) {
      // Confirm / go back. Confirm is the destructive one, so it is NOT the green primary.
      this.addButton(btnX, cardY + dyBtn, btnW, bH, t('ageGate.confirmYes'), C.dark, 0xffffff,
        () => this.cb.onDeclared(this.year));
      this.addButton(btnX, cardY + dyBtn + bH + gapBtnBtn, btnW, bH, t('ageGate.confirmBack'), C.paper, C.dark,
        () => { this.confirming = false; this.rebuild(); });
      return;
    }

    this.buildStepper(innerX, cardY + dyRow, innerW, stepH, unit);
    this.addButton(btnX, cardY + dyBtn, btnW, bH, t('ageGate.confirm'), C.green, 0xffffff, () => {
      if (this.declaredAge() < this.minAge) { this.confirming = true; this.rebuild(); return; }
      this.cb.onDeclared(this.year);
    });
  }

  /** `[-10] [-1]  YEAR  [+1] [+10]`, centred in the card. */
  private buildStepper(x0: number, y: number, rowW: number, hStep: number, unit: number): void {
    const stepW = Math.round(rowW * 0.17);
    const gap = Math.round(rowW * 0.025);
    const yearW = rowW - 4 * stepW - 4 * gap;
    const fs = snapFont(Math.round(hStep * 0.42));

    let x = x0;
    for (const d of [-10, -1]) {
      this.addStep(x, y, stepW, hStep, d, fs);
      x += stepW + gap;
    }

    const year = txt(String(this.year), snapFont(Math.round(unit * 0.085)), C.dark, true);
    year.anchor.set(0.5, 0.5);
    year.x = x + yearW / 2; year.y = y + hStep / 2;
    this.container.addChild(year);
    this.yearText = year;
    x += yearW + gap;

    for (const d of [1, 10]) {
      this.addStep(x, y, stepW, hStep, d, fs);
      x += stepW + gap;
    }
  }

  /**
   * One ±N stepper. It keeps its handler for the life of the card and dims at the ends of the
   * range instead of being redrawn as an inert twin — see {@link step}. Tapping a dimmed stepper
   * is a no-op, which is also what it looks like.
   */
  private addStep(x: number, y: number, wBtn: number, hBtn: number, delta: number, fs: number): void {
    const label = (delta > 0 ? '+' : '−') + String(Math.abs(delta));
    const g = this.addButton(x, y, wBtn, hBtn, label, C.paper, C.dark, () => this.step(delta), fs);
    g.alpha = this.inRange(this.year + delta) ? 1 : DISABLED_ALPHA;
    this.steps.push({ g, delta });
  }

  /**
   * A sketch-panel button with a centred label, as one group: the label is drawn by
   * `drawButtonLabel` into the group rather than into the card, so dimming the group dims both.
   * The panel itself carries the handler (as in ConsentDialog) — PIXI hit-tests it either way.
   */
  private addButton(
    x: number, y: number, wBtn: number, hBtn: number, label: string,
    fill: number, ink: number, onTap: () => void, fontSize?: number,
  ): PIXI.Container {
    const g = new PIXI.Container();
    g.x = x; g.y = y;
    const panel = sketchPanel(wBtn, hBtn, { fill, border: C.dark, width: 2.4, seed: seedFor(wBtn, hBtn, 2) });
    panel.eventMode = 'static';
    panel.cursor = 'pointer';
    panel.on('pointertap', tapHandler(onTap));
    g.addChild(panel);
    drawButtonLabel(g, 0, 0, wBtn, hBtn, label, null, ink, fontSize ?? snapFont(Math.round(hBtn * 0.4)));
    this.container.addChild(g);
    return g;
  }
}
