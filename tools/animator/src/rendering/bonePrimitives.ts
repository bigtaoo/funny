// Stateless stickman drawing primitives — split out of Renderer.ts (2026-09-21) once
// that file crossed the 500-line convention again, same move as skinHandles.ts before
// it. These three were already `this`-free: each takes its Graphics target and plain
// numbers, so they were methods only by habit. Taking a plain Graphics (rather than
// reaching for a Renderer field) keeps this a one-way dependency — Renderer.ts calls
// in here, this file never reaches back into Renderer.ts.
import * as PIXI from 'pixi.js';
import { Skeleton } from '../skeleton/Skeleton';

export function drawTubularBone(
  g: PIXI.Graphics,
  sx: number, sy: number, ex: number, ey: number,
  outerW: number, innerW: number, alpha: number,
): void {
  g.lineStyle({ width: outerW, color: 0x222222, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(sx, sy); g.lineTo(ex, ey);
  g.lineStyle({ width: innerW, color: 0xFFFFFF, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  g.moveTo(sx, sy); g.lineTo(ex, ey);
}

export function drawHead(g: PIXI.Graphics, cx: number, cy: number, alpha: number): void {
  g.lineStyle({ width: 4, color: 0x222222, alpha });
  g.beginFill(0xFFFFFF, alpha);
  g.drawCircle(cx, cy, Skeleton.HEAD_R);
  g.endFill();
  g.lineStyle(0);
  g.beginFill(0x222222, alpha);
  g.drawCircle(cx + Skeleton.HEAD_R * 0.38, cy - Skeleton.HEAD_R * 0.1, 3);
  g.endFill();
}

export function drawJoint(g: PIXI.Graphics, x: number, y: number, r: number): void {
  g.lineStyle({ width: 2.5, color: 0x222222, alpha: 1 });
  g.beginFill(0xFFFFFF);
  g.drawCircle(x, y, r);
  g.endFill();
}
