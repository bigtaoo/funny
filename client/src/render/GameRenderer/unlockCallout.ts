// unlockCallout.ts — the campaign's mid-battle new-card callout (ONBOARDING_DESIGN §17.1/§17.4).
//
// A level's `cardUnlocks` force a card into the player's hand at a fixed tick; on its own that is just
// one more card. This frames it the way the tutorial frames its archer: once the card reaches the hand,
// an instruction strip names it and a breathing ring marks its slot for CALLOUT_SEC. Presentation only —
// it never pauses or blocks a tap.
import * as PIXI from 'pixi.js-legacy';
import type { GameState } from '../../game';
import type { ILayout, Rect } from '../../layout/ILayout';
import { drawStrip, clearStrip } from '../TutorialDirector/panels';
import { drawSlotRing } from '../TutorialDirector/ghostDemo';

/** How long the strip and the ring stay up once the card is in hand. */
const CALLOUT_SEC = 4;

/** One card to call out — supplied by the nav layer from the level's `cardUnlocks`. */
export interface UnlockCalloutEntry {
  cardId: string;
  title: string;
  body: string;
}

export interface UnlockCalloutHost {
  readonly container: PIXI.Container;
  readonly layout: ILayout;
  state(): GameState;
  handSlotCenter(index: number): { x: number; y: number };
}

export class UnlockCallout {
  private readonly root = new PIXI.Container();
  private readonly ring = new PIXI.Graphics();
  private readonly strip = new PIXI.Container();
  private readonly pending: UnlockCalloutEntry[];
  private active: UnlockCalloutEntry | null = null;
  private time = 0;
  private until = -Infinity;

  constructor(private readonly host: UnlockCalloutHost, entries: readonly UnlockCalloutEntry[]) {
    this.pending = [...entries];
    this.root.addChild(this.ring, this.strip);
    host.container.addChild(this.root);
  }

  update(dt: number): void {
    this.time += dt;
    const slots = this.host.state().bottomPlayer.hand.slots;
    if (this.active && this.time >= this.until) {
      this.active = null;
      this.ring.visible = false;
      clearStrip({ strip: this.strip });
    }
    if (!this.active) {
      const i = this.pending.findIndex((e) => slots.some((s) => s?.card.id === e.cardId));
      if (i < 0) return;
      this.active = this.pending.splice(i, 1)[0]!;
      this.until = this.time + CALLOUT_SEC;
      const L = this.host.layout;
      const slot = slots.findIndex((s) => s?.card.id === this.active!.cardId);
      const c = this.host.handSlotCenter(slot);
      const avoid: Rect[] = [{ x: c.x - L.cardWidth / 2, y: c.y - L.cardHeight / 2, w: L.cardWidth, h: L.cardHeight }];
      drawStrip({ layout: L, strip: this.strip }, this.active.title, this.active.body, avoid);
    }
    const slot = slots.findIndex((s) => s?.card.id === this.active!.cardId);
    if (slot >= 0) drawSlotRing(this.ring, this.host.layout, this.host.handSlotCenter(slot), this.time);
    else this.ring.visible = false;
  }

  destroy(): void {
    clearStrip({ strip: this.strip });
    this.root.destroy({ children: true });
  }
}
