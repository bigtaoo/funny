// inkHint.ts — the one-time "not enough ink" bubble (ONBOARDING_DESIGN §9 item 9).
//
// The old tutorial spent its seventh text card on ink before the player had ever run short. The
// rebuilt tutorial deals enough ink that nobody can (§11), so the lesson moved to where it is
// needed: the first time a real match rejects a card for cost, a single line floats above the
// hand for a few seconds. It never pauses and never blocks a tap. Whether it is still owed is the
// save's business (flag `hint.ink`), so the renderer only asks through {@link InkHintGate}.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { FS } from '../fontScale';
import { t } from '../../i18n';
import type { Rect } from '../../layout/ILayout';

/** Supplied by the nav layer: `claim()` answers "show it now?" and marks it shown when it says yes. */
export interface InkHintGate {
  claim(): boolean;
}

const SHOW_S = 3;
const FADE_S = 0.5;

export class InkHintBubble {
  private node: PIXI.Container | null = null;
  private left = 0;

  constructor(private readonly parent: PIXI.Container, private readonly gate: InkHintGate | null) {}

  /** A card was refused for cost. Shows the bubble when the gate still owes it. */
  offer(handRect: Rect): void {
    if (this.node || !this.gate || !this.gate.claim()) return;
    const c = new PIXI.Container();
    c.name = 'inkHint';
    const label = makeText(t('hint.ink'), {
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
    this.left = SHOW_S;
  }

  update(dt: number): void {
    if (!this.node) return;
    this.left -= dt;
    if (this.left <= 0) { this.node.destroy({ children: true }); this.node = null; return; }
    this.node.alpha = Math.min(1, this.left / FADE_S);
  }
}
