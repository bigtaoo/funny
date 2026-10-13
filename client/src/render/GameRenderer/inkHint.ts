// inkHint.ts — the one-time "not enough ink" bubble (ONBOARDING_DESIGN §9 item 9).
//
// The old tutorial spent its seventh text card on ink before the player had ever run short. The
// rebuilt tutorial deals enough ink that nobody can (§11), so the lesson moved to where it is
// needed: the first time a real match rejects a card for cost, a single line floats above the
// hand for a few seconds. It never pauses and never blocks a tap. Whether it is still owed is the
// save's business (flag `hint.ink`), so the renderer only asks through {@link InkHintGate}.
//
// The same bubble carries the "ink is full, spend it" nudge (ONBOARDING_DESIGN §14.1): CrazyGames
// battle snapshots showed most ch1_lv1 leavers sitting on a full 100 ink with a Meteor in hand,
// so the first time ink stays capped while a spell is playable, one line points at the spell.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { FS } from '../fontScale';
import { t } from '../../i18n';
import type { Rect } from '../../layout/ILayout';

/** Supplied by the nav layer: `claim()` answers "show it now?" and marks it shown when it says yes. */
export interface InkHintGate {
  claim(): boolean;
  /** Same contract for the "ink is full" nudge; absent = never shown. */
  claimFull?(): boolean;
}

const SHOW_S = 3;
const SHOW_FULL_S = 4.5;
/** Seconds ink must sit at the cap (with a spell playable) before the full nudge is offered. */
const FULL_AFTER_S = 2;
const FADE_S = 0.5;

export class InkHintBubble {
  private node: PIXI.Container | null = null;
  private left = 0;
  /** How long the "ink is full" condition has held without a break. */
  private fullFor = 0;

  constructor(private readonly parent: PIXI.Container, private readonly gate: InkHintGate | null) {}

  /** A card was refused for cost. Shows the bubble when the gate still owes it. */
  offer(handRect: Rect): void {
    if (this.node || !this.gate || !this.gate.claim()) return;
    this.show(handRect, t('hint.ink'), SHOW_S);
  }

  /**
   * Called every frame with whether ink is capped while a spell is playable. Once that has held for
   * FULL_AFTER_S, shows the spend-it line when the gate still owes it.
   */
  tickFull(dt: number, full: boolean, handRect: Rect): void {
    if (!full) { this.fullFor = 0; return; }
    this.fullFor += dt;
    if (this.fullFor < FULL_AFTER_S) return;
    this.fullFor = 0;
    if (this.node || !this.gate?.claimFull || !this.gate.claimFull()) return;
    this.show(handRect, t('hint.inkFull'), SHOW_FULL_S);
  }

  private show(handRect: Rect, text: string, seconds: number): void {
    const c = new PIXI.Container();
    c.name = 'inkHint';
    const label = makeText(text, {
      fontSize: FS.body, fill: 0xfdf8ec, fontWeight: 'bold',
      wordWrap: true, wordWrapWidth: Math.round(handRect.w * 0.8), align: 'center',
    });
    label.anchor.set(0.5);
    const padX = Math.round(FS.body * 0.8), padY = Math.round(FS.body * 0.5);
    const bg = new PIXI.Graphics();
    bg.beginFill(0x2b2b2b, 0.88);
    bg.drawRoundedRect(-label.width / 2 - padX, -label.height / 2 - padY, label.width + padX * 2, label.height + padY * 2, 10);
    bg.endFill();
    c.addChild(bg, label);
    c.x = handRect.x + handRect.w / 2;
    c.y = handRect.y - label.height / 2 - padY - 8;
    this.parent.addChild(c);
    this.node = c;
    this.left = seconds;
  }

  update(dt: number): void {
    if (!this.node) return;
    this.left -= dt;
    if (this.left <= 0) { this.node.destroy({ children: true }); this.node = null; return; }
    this.node.alpha = Math.min(1, this.left / FADE_S);
  }
}
