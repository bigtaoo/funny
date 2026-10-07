// HUDView's size-to-room rules for the pieces whose size is a literal design px while the strip or
// column they sit in is `× k` (layout/LandscapeLayout.ts). At the 1080 reference every bound below is
// slack and each helper returns the classic size; they only bite on a short landscape design (640–1078
// tall since 2026-10-07, ADR-105's landscape section), where each of them was caught out of its box.
import type * as PIXI from 'pixi.js-legacy';
import { FS, fitFont, currentFontFloor, snapFontDown } from '../fontScale';

/** The surrender button's height: its classic `base`, never taller than the top strip (36 at 640 tall). */
export function surrenderButtonHeight(stripH: number, base: number): number {
  return Math.min(base, Math.max(24, stripH - 4));
}

/**
 * Size the surrender / exit-level label for a `cellW` cell that may grow up to `maxW`. Fitting into
 * the fixed cell is right while it costs a step or two of size; once that lands on the legibility
 * floor ("EXIT LEVEL" at 8 CSS px on a small landscape design) the label keeps its full token and
 * the caller grows the cell instead, as far as `maxW` allows.
 */
export function fitSurrenderLabel(label: PIXI.Text, cellW: number, maxW: number, padX: number): void {
  const fullW = label.width;
  label.style.fontSize = fitFont(FS.small, fullW, cellW - 2 * padX);
  if (Number(label.style.fontSize) <= currentFontFloor() && FS.small > currentFontFloor()) {
    label.style.fontSize = fitFont(FS.small, fullW, maxW - 2 * padX);
  }
}

/** Fit a refresh / upgrade label (`FS.title`) to its `btnW × btnH` button — "⟳ 10g" ran out of it at 640 tall. */
export function fitActionLabel(label: PIXI.Text, btnW: number, btnH: number, padX: number): void {
  const maxSize = Math.min(FS.title, snapFontDown(btnH * 0.8));
  label.style.fontSize = maxSize;
  label.style.fontSize = fitFont(maxSize, label.width, btnW - 2 * padX - 4);
}

/** Set an action button's label, re-fitting it only when the text changed (HUDView.sync runs per frame). */
export function setActionLabel(label: PIXI.Text, text: string, btnW: number, btnH: number, padX: number): void {
  if (label.text === text) return;
  label.text = text;
  fitActionLabel(label, btnW, btnH, padX);
}

/**
 * Scale for the player's ten hearts (`barW`, literal design px) in landscape: they may use the whole
 * paper margin left of the board (`boardX`), and shrink only for what even that cannot hold — at
 * 722x406 the `300 × k` column alone put the tenth heart off the screen.
 */
export function playerHpScale(boardX: number, barW: number): number {
  const room = boardX - 14 - 8;
  return room < barW ? room / barW : 1;
}
