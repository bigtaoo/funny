// The ghost-hand demo's drawing (ONBOARDING_DESIGN §11.4): a breathing frame around a hand card and a
// ghost of that card gliding from the hand to its target on a loop. Shared by TutorialDirector and the
// campaign build hint (render/GameRenderer/buildHint.ts) so both teach with the same gesture; the
// decision of *when* to show it stays with each caller.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import { GHOST_MOVE_SEC, GHOST_HOLD_SEC } from './beats';

/** Blue = player highlight (same value as the tutorial's own C_BLUE). */
const C_BLUE = 0x4a7fc1;

/** One full ghost pass: glide, then hold on the target. */
export const GHOST_LOOP_SEC = GHOST_MOVE_SEC + GHOST_HOLD_SEC;

/** Breathing frame around the card centred at `center`; `time` is any running clock in seconds. */
export function drawSlotRing(g: PIXI.Graphics, layout: ILayout, center: { x: number; y: number }, time: number): void {
  const a = 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(time * 5));
  const w = layout.cardWidth + 10;
  const h = layout.cardHeight + 10;
  g.clear();
  g.lineStyle(4, C_BLUE, a);
  g.drawRoundedRect(center.x - w / 2, center.y - h / 2, w, h, 8);
  g.visible = true;
}

/** Refill `layer` with the demo's pieces: the card ghost (when there is one) and a fingertip. */
export function fillGhostLayer(layer: PIXI.Container, layout: ILayout, card: PIXI.Container | null): void {
  layer.removeChildren().forEach((c) => c.destroy({ children: true }));
  if (card) {
    card.alpha = 0.85;
    card.scale.set(1.4); // the drag ghost is small; the demo has to be noticed
    layer.addChild(card);
  }
  const tip = new PIXI.Graphics();
  const r = layout.cellSize * 0.22;
  tip.lineStyle(3, 0xffffff, 0.95).beginFill(C_BLUE, 0.85).drawCircle(0, 0, r).endFill();
  layer.addChild(tip);
}

/** Place the demo `t` seconds into its loop (0 ≤ t < GHOST_LOOP_SEC): easeInOutQuad glide, fade at both ends. */
export function poseGhost(layer: PIXI.Container, t: number, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const k = Math.min(1, t / GHOST_MOVE_SEC);
  const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
  const x = from.x + (to.x - from.x) * e;
  const y = from.y + (to.y - from.y) * e;
  for (const c of layer.children) c.position.set(x, y);
  const holdLeft = GHOST_LOOP_SEC - t;
  layer.alpha = Math.max(0, Math.min(1, t / 0.15, holdLeft / 0.2));
  layer.visible = true;
}
