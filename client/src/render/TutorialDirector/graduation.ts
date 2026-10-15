// The tutorial's way out once the WIN stamp is in (ONBOARDING_DESIGN §17.1): hold the stamp a beat and
// leave, or — only when it carries the analytics notice — pop the graduation card and leave on its
// button (or its auto-continue bar). Split out of TutorialDirector.ts for the 500-line rule
// (claudedocs/client-modules.md); the director owns the phase change, this owns the clocks.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { dispatchHit } from '../../ui/hits';
import { drawGradCard, type PanelHost } from './panels';
import type { TutorialConfig } from './types';
import { WIN_HOLD_SEC, GRAD_CARD_DELAY_SEC, GRAD_POP_SEC } from './beats';

export class Graduation {
  private gradAt = Infinity;
  /** No graduation card: the WIN stamp holds until this time, then the tutorial leaves by itself. */
  private leaveAt = Infinity;
  private footnoteShown = false;
  /** Auto-continue progress along the button's foot (lazily added to the card). */
  private bar: PIXI.Graphics | null = null;

  constructor(private readonly panels: () => PanelHost, private readonly config: TutorialConfig) {}

  /** The WIN stamp is in (`now` = the director's clock). */
  start(now: number): void {
    const cfg = this.config;
    if (!cfg.footnote) {
      // §17.1: no stop between the tutorial and level 1 — the WIN stamp, a beat, and on.
      this.leaveAt = now + WIN_HOLD_SEC;
      return;
    }
    const p = this.panels();
    drawGradCard(p, t('tutorial.grad.body'), cfg.teaser, cfg.ctaLabel, cfg.footnote);
    p.gradCard.scale.set(0);
    this.gradAt = now + GRAD_CARD_DELAY_SEC;
  }

  /** Per frame; true once it is time to leave. */
  tick(now: number): boolean {
    if (now >= this.leaveAt) return true;
    if (now < this.gradAt) return false;
    if (!this.footnoteShown) { this.footnoteShown = true; this.config.onFootnoteShown?.(); }
    const card = this.panels().gradCard;
    const k = Math.min(1, (now - this.gradAt) / GRAD_POP_SEC);
    // easeOutBack — a small overshoot reads as a stamp landing.
    const c = 1.70158;
    const s = 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
    card.scale.set(k >= 1 ? 1 : s);
    return k >= 1 && this.tickAutoContinue(now);
  }

  /**
   * A tap while graduating; true when it should leave. Without a card a tap just hurries the WIN stamp
   * along; with one only its button leaves, so a stray tap can't skip the moment.
   */
  tap(x: number, y: number): boolean {
    if (this.leaveAt !== Infinity) return true;
    const p = this.panels();
    let go = false;
    if (p.ctaRect && p.gradCard.scale.x >= 0.999) dispatchHit([{ rect: p.ctaRect, fn: () => { go = true; } }], x, y);
    return go;
  }

  /** {@link TutorialConfig.autoContinueSec}: fill the bar; true once it is full. */
  private tickAutoContinue(now: number): boolean {
    const sec = this.config.autoContinueSec;
    const { ctaRect: r, gradCard: card } = this.panels();
    if (!sec || !r) return false;
    const p = Math.min(1, (now - this.gradAt - GRAD_POP_SEC) / sec);
    if (!this.bar || this.bar.destroyed || this.bar.parent !== card) {
      this.bar = new PIXI.Graphics();
      card.addChild(this.bar);
    }
    const inset = r.h * 0.3; // clear of the button's rounded corners
    const barH = Math.max(3, Math.round(r.h * 0.08));
    this.bar.clear();
    this.bar.beginFill(0xffffff, 0.75);
    this.bar.drawRect(r.x + inset, r.y + r.h - barH * 2, (r.w - inset * 2) * p, barH);
    this.bar.endFill();
    return p >= 1;
  }
}
