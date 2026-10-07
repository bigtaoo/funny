/**
 * EntryGateDialog — RETENTION_LAUNCH_PLAN.md §3.1 "age gate + consent wall, merged": the common
 * brand-new-player path (both unanswered) as ONE screen and ONE tap, instead of two full-screen
 * gates in sequence ({@link AgeGateDialog} then {@link ConsentDialog}, as `createAppCore.gateConsent`
 * used to run them). The two answers still carry different legal weight (COMPLIANCE_GLOBAL §3.3/
 * §3.4 — "two legal bases, not bound to one button"), which is why the primary button(s) record
 * BOTH only where consent already has an unambiguous answer tied to the button pressed
 * ('accept-only' has one button, 'choice' has two, and either declares the currently picked year at
 * the same time as it answers consent). An underage year still gets its own confirm step
 * before anything is recorded, exactly as {@link AgeGateDialog} does, and the permanent 'blocked'
 * dead end stays that separate screen — nothing about declining consent or the below-threshold
 * outcome changes here, only how many screens a player who answers normally has to get through.
 *
 * `mode.age`/`mode.consent` are independent — a returning player who already declared an age but
 * not consent (or vice versa) sees only that section, with the same copy the standalone
 * {@link AgeGateDialog}/{@link ConsentDialog} use, so those less-common paths render exactly as
 * before this existed. Only `{age:'ask', consent: not null}` — the actual new-player case — uses
 * new combined copy (`entryGate.body`/`entryGate.bodyChoice`).
 *
 * **Birth year: a two-tap picker, not a stepper** (2026-10-07, ONBOARDING_DESIGN §11.8). The row
 * shows the current year as one field; tapping it swaps the card for a decade grid, a decade for
 * that decade's years, a year back to the card. Any year is two taps away instead of up to dozens of
 * ±1/±10 presses. The neutrality rules of COMPLIANCE_GLOBAL §3.4 are unchanged: it still asks for a
 * birth YEAR (never "are you 13?"), still starts from 30 years ago (neither the threshold nor an
 * obvious pass value), every decade is offered alike, and an underage year still needs its own
 * confirmation before anything is recorded.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText, monospaceWidth } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { drawButtonLabel } from '../widgets/buttonLabel';
import { snapFont, fitFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { tapHandler } from '../hits';
import { MIN_AGE_YEARS } from '../../app/appConstants';
import { legalUrl, type ConsentMode } from './ConsentDialog';
import { openExternalUrl } from '../../platform/externalLink';

export interface EntryGateMode {
  /** 'ask' shows the birth-year picker; 'ok' means age is already known — only consent is asked. */
  age: 'ask' | 'ok';
  /**
   * null when consent is already known too — only the birth-year picker (+ its own button) is shown.
   * 'terms': analytics consent is already answered but the current Terms of Use (EULA) are not
   * (the App Review 1.2 re-accept, see TERMS_ACCEPTED_FLAG) — one Accept button, terms copy.
   */
  consent: ConsentMode | 'terms' | null;
}

export interface EntryGateAnswer {
  /** Set only when `mode.age === 'ask'` and the picked year was confirmed — even on an underage answer. */
  birthYear?: number;
  /** Set only when `mode.consent !== null` and a consent button was the one pressed. */
  granted?: boolean;
}

export interface EntryGateCallbacks {
  /**
   * Fired once, with everything this screen asked. Never fired for the underage confirm path: that
   * one leads to a fresh {@link AgeGateDialog} `'blocked'` mount instead (see the core's
   * `gateConsent`), so `granted` is never set alongside an underage `birthYear`.
   */
  onAnswered(answer: EntryGateAnswer): void;
}

const MAX_AGE = 100;
const START_OFFSET = 30;

export class EntryGateDialog implements Scene {
  readonly container: PIXI.Container;

  private year: number;
  /** Set once an underage year has been confirmed once and needs a second confirmation. */
  private confirming = false;
  /** The year picker, when open: the decade grid, or the years of one decade (its first year). */
  private picking: 'decade' | number | null = null;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly mode: EntryGateMode,
    private readonly cb: EntryGateCallbacks,
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

  private declaredAge(): number {
    return this.thisYear - this.year;
  }

  private rebuild(): void {
    this.container.removeAllListeners();
    tearDownChildren(this.container);
    this.build();
  }

  private inRange(year: number): boolean {
    return year <= this.thisYear && year >= this.thisYear - MAX_AGE;
  }

  /** Every decade with at least one selectable year, newest first. */
  private decades(): number[] {
    const out: number[] = [];
    const oldest = Math.floor((this.thisYear - MAX_AGE) / 10) * 10;
    for (let d = Math.floor(this.thisYear / 10) * 10; d >= oldest; d -= 10) out.push(d);
    return out;
  }

  private yearsOf(decade: number): number[] {
    const out: number[] = [];
    for (let y = decade; y < decade + 10; y++) if (this.inRange(y)) out.push(y);
    return out;
  }

  private build(): void {
    this.container.addChild(buildPaperBackground('entrygatebg', this.w, this.h));

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, this.w, this.h).endFill();
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, this.w, this.h);
    this.container.addChild(dim);

    const landscape = this.w > this.h;
    const cardHmin = landscape
      ? Math.round(this.h * 0.8)
      : Math.round(Math.min(this.h * 0.72, this.w * 0.9 * 1.15));
    const cardW = landscape
      ? Math.round(Math.min(cardHmin * 0.95, this.w * 0.7))
      : Math.round(this.w * 0.9);
    const cardX = (this.w - cardW) / 2;

    const maxH = this.h * 0.96;
    if (this.picking !== null) { this.buildPicker(cardX, cardW, cardHmin, maxH); return; }
    let L = this.measure(cardHmin, cardW);
    if (L.contentH > maxH) {
      L.title.destroy(); L.body.destroy();
      L = this.measure(Math.floor(cardHmin * (maxH / L.contentH)), cardW);
    }
    const cardH = Math.min(Math.round(maxH), Math.max(cardHmin, Math.round(L.contentH)));
    const cardY = (this.h - cardH) / 2;

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 1) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    L.title.x = this.w / 2; L.title.y = cardY + L.dyTitle;
    this.container.addChild(L.title);
    L.body.x = this.w / 2; L.body.y = cardY + L.dyBody;
    this.container.addChild(L.body);

    const padX = Math.round(cardW * 0.07);
    const innerX = cardX + padX;
    const innerW = cardW - 2 * padX;

    if (this.showsStepper() && L.dyStep !== undefined) {
      this.buildYearField(innerX, cardY + L.dyStep, innerW, L.stepH!);
    }

    if (this.showsLinks() && L.dyLink1 !== undefined) {
      this.addLink(t('consent.privacyPolicy'), this.w / 2, cardY + L.dyLink1, L.unit, legalUrl('/privacy'));
      this.addLink(t('consent.terms'), this.w / 2, cardY + L.dyLink2!, L.unit, legalUrl('/terms'));
    }

    const bW = Math.round(cardW * 0.6);
    const bX = cardX + Math.round((cardW - bW) / 2);
    const fs = snapFont(Math.round(L.bH * 0.4));

    if (this.confirming) {
      this.addButton(bX, cardY + L.dyBtn, bW, L.bH, t('ageGate.confirmYes'), null, C.dark, 0xffffff, fs, 2,
        () => this.cb.onAnswered({ birthYear: this.year }));
      this.addButton(bX, cardY + L.dyBtn + L.bH + L.gapBtnBtn, bW, L.bH, t('ageGate.confirmBack'), null, C.paper, C.dark, fs, 3,
        () => { this.confirming = false; this.rebuild(); });
      return;
    }

    this.buildAnswerButtons(bX, cardY + L.dyBtn, bW, L.bH, L.gapBtnBtn, fs);
  }

  private showsStepper(): boolean {
    return this.mode.age === 'ask' && !this.confirming;
  }

  private showsLinks(): boolean {
    return this.mode.consent !== null && !this.confirming;
  }

  /** Whether the currently picked year (if asked) needs the underage confirm step. */
  private isUnderage(): boolean {
    return this.mode.age === 'ask' && this.declaredAge() < this.minAge;
  }

  /** The consent-mode buttons (1 or 2), or the lone age-only "Confirm" button when consent is null. */
  private buildAnswerButtons(x: number, y: number, w: number, bH: number, gap: number, fs: number): void {
    const declare = (granted?: boolean): void => {
      if (this.isUnderage()) { this.confirming = true; this.rebuild(); return; }
      const answer: EntryGateAnswer = {};
      if (this.mode.age === 'ask') answer.birthYear = this.year;
      if (granted !== undefined) answer.granted = granted;
      this.cb.onAnswered(answer);
    };

    if (this.mode.consent === null) {
      this.addButton(x, y, w, bH, t('ageGate.confirm'), null, C.green, 0xffffff, fs, 2, () => declare());
      return;
    }

    this.addButton(x, y, w, bH, t(this.mode.consent === 'choice' ? 'consent.acceptAll' : 'consent.accept'), 'check',
      C.green, 0xffffff, fs, 2, () => declare(true));

    if (this.mode.consent === 'choice') {
      this.addButton(x, y + bH + gap, w, bH, t('consent.essentialOnly'), null, C.paper, C.dark, fs, 3, () => declare(false));
    }
  }

  private addButton(
    x: number, y: number, w: number, h: number,
    label: string, icon: 'check' | null, fill: number, ink: number, fontSize: number,
    seedIdx: number, onTap: () => void,
  ): void {
    const box = sketchPanel(w, h, { fill, border: C.dark, width: 2.4, seed: seedFor(w, h, seedIdx) });
    box.x = x; box.y = y;
    box.eventMode = 'static';
    box.cursor = 'pointer';
    box.on('pointertap', tapHandler(onTap));
    this.container.addChild(box);
    drawButtonLabel(this.container, x, y, w, h, label, icon, ink, fontSize);
  }

  private addLink(label: string, cx: number, y: number, cardH: number, url: string): void {
    const link = txt('· ' + label, snapFont(Math.round(cardH * 0.042)), C.accent, true);
    link.anchor.set(0.5, 0); link.x = cx; link.y = y;
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointertap', tapHandler(() => {
      openExternalUrl(url);
    }));
    this.container.addChild(link);
  }

  /** The birth-year row: one field showing the current year; tapping it opens the picker. */
  private buildYearField(x0: number, y: number, rowW: number, hStep: number): void {
    const fs = snapFont(Math.round(hStep * 0.4));
    this.addButton(x0, y, rowW, hStep, t('entryGate.yearPick', { year: this.year }), null, C.paper, C.dark, fs, 4,
      () => { this.picking = 'decade'; this.rebuild(); });
    // A small "opens a list" caret at the right edge: drawn, not a glyph, so no font can drop it.
    const r = Math.round(hStep * 0.16);
    const cx = x0 + rowW - Math.round(hStep * 0.45);
    const cy = y + hStep / 2;
    const caret = new PIXI.Graphics();
    caret.beginFill(C.dark).drawPolygon([cx - r, cy - r / 2, cx + r, cy - r / 2, cx, cy + r * 0.7]).endFill();
    this.container.addChild(caret);
  }

  /**
   * The picker card: a decade grid, or one decade's years, plus a Back chip. 4 columns, at most
   * 3 rows (11 decades + Back, or 10 years + Back), shrunk to fit a short landscape screen.
   */
  private buildPicker(cardX: number, cardW: number, unit: number, maxH: number): void {
    const decadeMode = this.picking === 'decade';
    const chips: Array<{ label: string; selected: boolean; onTap: () => void }> = decadeMode
      ? this.decades().map((d) => ({
          label: t('entryGate.decade', { decade: d }),
          selected: Math.floor(this.year / 10) * 10 === d,
          onTap: () => { this.picking = d; this.rebuild(); },
        }))
      : this.yearsOf(this.picking as number).map((yr) => ({
          label: String(yr),
          selected: yr === this.year,
          onTap: () => { this.year = yr; this.picking = null; this.rebuild(); },
        }));
    chips.push({
      label: t('entryGate.pickBack'),
      selected: false,
      onTap: () => { this.picking = decadeMode ? null : 'decade'; this.rebuild(); },
    });

    const padX = Math.round(cardW * 0.07);
    const innerW = cardW - 2 * padX;
    const titleLabel = t(decadeMode ? 'entryGate.pickDecade' : 'entryGate.pickYear');
    const titleSize = snapFont(Math.round(unit * 0.06));
    let title = txt(titleLabel, titleSize, C.dark, true);
    const titleW = Math.max(title.width, monospaceWidth(titleLabel, titleSize));
    if (titleW > innerW) {
      const fitted = fitFont(titleSize, titleW, innerW);
      if (fitted < titleSize) { title.destroy({ texture: true, baseTexture: true }); title = txt(titleLabel, fitted, C.dark, true); }
    }
    title.anchor.set(0.5, 0);

    const cols = 4;
    const rows = Math.ceil(chips.length / cols);
    const gapX = Math.round(innerW * 0.03);
    const gapY = Math.round(unit * 0.03);
    const padTop = Math.round(unit * 0.06);
    const gapTitle = Math.round(unit * 0.05);
    const padBottom = Math.round(unit * 0.06);
    const fixedH = padTop + title.height + gapTitle + padBottom + gapY * (rows - 1);
    const chipH = Math.max(24, Math.min(Math.round(unit * 0.11), Math.floor((maxH - fixedH) / rows)));
    const chipW = Math.floor((innerW - gapX * (cols - 1)) / cols);
    const cardH = Math.round(fixedH + chipH * rows);
    const cardY = (this.h - cardH) / 2;

    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 5) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);
    title.x = this.w / 2; title.y = cardY + padTop;
    this.container.addChild(title);

    const fs = snapFont(Math.round(chipH * 0.38));
    const gridY = cardY + padTop + title.height + gapTitle;
    chips.forEach((c, i) => {
      const x = cardX + padX + (i % cols) * (chipW + gapX);
      const y = gridY + Math.floor(i / cols) * (chipH + gapY);
      this.addButton(x, y, chipW, chipH, c.label, null, c.selected ? C.dark : C.paper, c.selected ? 0xffffff : C.dark, fs, 6 + i, c.onTap);
    });
  }

  /**
   * Build the title/body text nodes at `unit` and return every vertical offset they imply, exactly
   * as {@link ConsentDialog.measure} does (same caller contract: measure, reject if too tall, and
   * measure again at a smaller scale — see `build`'s two-pass call). The year-field/links/button rows
   * are reserved by height only here (drawn later in `build`, which needs live refs to the year
   * label for `step()` to update in place).
   */
  private measure(unit: number, cardW: number) {
    const innerW = cardW * 0.84;

    const confirming = this.confirming;
    const titleKey = confirming ? 'ageGate.confirmTitle'
      : this.mode.age === 'ask' && this.mode.consent !== null ? 'entryGate.title'
      : this.mode.age === 'ask' ? 'ageGate.title'
      : this.mode.consent === 'terms' ? 'consent.termsUpdateTitle'
      : 'consent.title';
    const bodyKey = confirming ? 'ageGate.confirmBody'
      : this.mode.age === 'ask' && this.mode.consent === 'choice' ? 'entryGate.bodyChoice'
      : this.mode.age === 'ask' && (this.mode.consent === 'accept-only' || this.mode.consent === 'terms') ? 'entryGate.body'
      : this.mode.age === 'ask' ? 'ageGate.body'
      : this.mode.consent === 'choice' ? 'consent.bodyChoice'
      : this.mode.consent === 'terms' ? 'consent.termsUpdateBody'
      : 'consent.body';

    const titleLabel = t(titleKey as Parameters<typeof t>[0]);
    const titleSize = snapFont(Math.round(unit * 0.07));
    let title = txt(titleLabel, titleSize, C.dark, true);
    const titleW = Math.max(title.width, monospaceWidth(titleLabel, titleSize));
    if (titleW > innerW) {
      const fitted = fitFont(titleSize, titleW, innerW);
      if (fitted < titleSize) {
        title.destroy({ texture: true, baseTexture: true });
        title = txt(titleLabel, fitted, C.dark, true);
      }
    }
    title.anchor.set(0.5, 0);

    const bodyParams: Record<string, string | number> =
      confirming ? { year: this.year } : this.mode.age === 'ok' ? {} : { min: this.minAge };
    const body = makeText(t(bodyKey as Parameters<typeof t>[0], bodyParams), {
      fontSize: snapFont(Math.round(unit * 0.038)), fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: innerW, breakWords: true, lineHeight: Math.round(unit * 0.054),
    });
    body.anchor.set(0.5, 0);

    const padTop = unit * 0.06;
    const gapTitleBody = unit * 0.06;
    const gapBodyStep = unit * 0.06;
    const stepH = Math.round(unit * 0.11);
    const gapStepLink = unit * 0.05;
    const gapBodyLink = unit * 0.08;
    const linkStep = unit * 0.065;
    const linkH = unit * 0.04 * 1.4;
    const gapLinkBtn = unit * 0.06;
    const gapBodyBtn = unit * 0.07;
    const bH = Math.round(unit * 0.12);
    const gapBtnBtn = unit * 0.035;
    const padBottom = unit * 0.06;

    const dyTitle = padTop;
    const dyBody = dyTitle + title.height + gapTitleBody;

    const stepper = this.showsStepper();
    const links = this.showsLinks();

    const dyStep = stepper ? dyBody + body.height + gapBodyStep : undefined;
    const afterStep = stepper ? dyStep! + stepH : dyBody + body.height;

    const dyLink1 = links ? afterStep + (stepper ? gapStepLink : gapBodyLink) : undefined;
    const dyLink2 = links ? dyLink1! + linkStep : undefined;
    const afterLinks = links ? dyLink2! + linkH : afterStep;

    const nBtns = this.confirming ? 2 : this.mode.consent === 'choice' ? 2 : 1;
    const dyBtn = links ? afterLinks + gapLinkBtn : afterStep + gapBodyBtn;
    const contentH = dyBtn + bH * nBtns + gapBtnBtn * (nBtns - 1) + padBottom;

    return {
      unit, title, body, dyTitle, dyBody, dyStep, stepH: stepper ? stepH : undefined,
      dyLink1, dyLink2, dyBtn, bH, gapBtnBtn, contentH,
    };
  }
}
