// `ILayout.isOutsideBoard` + `ILayout.mirrored` for both layouts (2026-09-10 FNDA sweep: all four
// were at zero hits, in two files that otherwise have thorough geometry suites).
//
// Why they are worth their own file rather than four more cases in each layout's suite: both are
// consumed by someone OTHER than the layout's own scene maths, and both fail without an error.
//
//   · isOutsideBoard is the drag/placement gate (GameRenderer/input.ts calls it four times,
//     placementHighlights once). Widen it and a spell aimed at the last column is silently
//     cancelled mid-drag; narrow it and a tap on the hand strip places a unit. Neither logs, and
//     the player reads both as "the game didn't register my tap". Nothing else pins that this
//     gate agrees with `boardRect`, which is the rectangle the board actually DRAWS itself into —
//     the two are separate expressions of the same bounds in both layouts.
//   · mirrored() is the joiner's whole view of the world: ReplayScene builds the opponent's side
//     with it, and a mirror that hands back the same side (or a layout built for a different
//     screen) draws the enemy base where the player's base is. This is not hypothetical — the
//     base-rect mirroring bug it is a sibling of is what PortraitLayout.test.ts's last case
//     exists for (the joiner saw damage flash on the wrong castle).
import { describe, it, expect } from 'vitest';
import { PortraitLayout } from '../src/layout/PortraitLayout';
import { LandscapeLayout } from '../src/layout/LandscapeLayout';
import { Side } from '../src/game';
import { BOARD_COLS, BOARD_ROWS } from '@nw/engine/config';
import type { ILayout, Rect } from '../src/layout/ILayout';

const LAYOUTS = [
  {
    name: 'PortraitLayout',
    make: (side: Side = Side.Bottom): ILayout => new PortraitLayout(390, 844, side),
    ctor: PortraitLayout,
  },
  {
    name: 'LandscapeLayout',
    make: (side: Side = Side.Bottom): ILayout => new LandscapeLayout(844, 390, side),
    ctor: LandscapeLayout,
  },
] as const;

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

describe.each(LAYOUTS)('$name.isOutsideBoard', ({ make }) => {
  it('accepts the middle of the board', () => {
    const l = make();
    const c = center(l.boardRect);
    expect(l.isOutsideBoard(c.x, c.y)).toBe(false);
  });

  it('accepts all four corners of the drawn board rect', () => {
    // Inclusive on every edge: the outermost lane and the last column are playable cells, and a
    // half-open rectangle would make the right/bottom column unusable for placement only.
    const l = make();
    const { x, y, w, h } = l.boardRect;
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]] as const) {
      expect(l.isOutsideBoard(px, py), `${px},${py}`).toBe(false);
    }
  });

  it('rejects a point just past each edge', () => {
    const l = make();
    const { x, y, w, h } = l.boardRect;
    const c = center(l.boardRect);
    expect(l.isOutsideBoard(x - 1, c.y), 'left').toBe(true);
    expect(l.isOutsideBoard(x + w + 1, c.y), 'right').toBe(true);
    expect(l.isOutsideBoard(c.x, y - 1), 'top').toBe(true);
    expect(l.isOutsideBoard(c.x, y + h + 1), 'bottom').toBe(true);
  });

  it('rejects the hand strip — the surface a player drags FROM', () => {
    const l = make();
    const c = center(l.handRect);
    expect(l.isOutsideBoard(c.x, c.y)).toBe(true);
  });

  it('agrees with boardRect on every cell centre, and only there', () => {
    // The sweep that catches a one-cell-wide drift between "where the board is drawn" and "where
    // a drop counts", which no single corner probe would show.
    const l = make();
    const { x, y, w, h } = l.boardRect;
    const cols = Math.round(w / l.cellSize);
    const rows = Math.round(h / l.cellSize);
    let inside = 0;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const px = x + i * l.cellSize + l.cellSize / 2;
        const py = y + j * l.cellSize + l.cellSize / 2;
        expect(l.isOutsideBoard(px, py), `${i},${j}`).toBe(false);
        inside += 1;
      }
    }
    expect(inside).toBe(cols * rows); // non-vacuity: the sweep actually ran over a full grid
    expect(inside).toBeGreaterThan(100);
  });

  it('is side-independent: mirroring moves the contents, not the frame', () => {
    const bottom = make(Side.Bottom);
    const top = make(Side.Top);
    expect(top.boardRect).toEqual(bottom.boardRect);
    const c = center(bottom.boardRect);
    expect(top.isOutsideBoard(c.x, c.y)).toBe(bottom.isOutsideBoard(c.x, c.y));
  });
});

describe.each(LAYOUTS)('$name.mirrored', ({ make, ctor }) => {
  it('returns the same layout built for the opposite side', () => {
    const l = make(Side.Bottom);
    const m = l.mirrored();

    expect(m).toBeInstanceOf(ctor);
    expect(m).not.toBe(l);
    expect(m.localSide).toBe(Side.Top);
    expect(l.localSide).toBe(Side.Bottom); // the original is untouched
    // Same screen, so the frame is identical — a mirror built from stale/default dimensions would
    // still "work" and simply draw the other side at the wrong scale.
    expect(m.designWidth).toBe(l.designWidth);
    expect(m.designHeight).toBe(l.designHeight);
    expect(m.boardRect).toEqual(l.boardRect);
  });

  it('mirrors from Top back to Bottom as well', () => {
    expect(make(Side.Top).mirrored().localSide).toBe(Side.Bottom);
  });

  it('keeps YOUR castle on the near side — the wrong-castle bug in one assertion', () => {
    // The mirror does not move the two castles on screen; it changes which game rows they stand
    // for. Both sides must see their own base near them (bottom in portrait, left in landscape),
    // which is precisely what the 2026 joiner bug got wrong: the damage flash for the enemy base
    // landed on the player's own castle.
    const l = make(Side.Bottom);
    const m = l.mirrored();
    expect(m.playerBaseRect()).toEqual(l.playerBaseRect());
    expect(m.enemyBaseRect()).toEqual(l.enemyBaseRect());
    // Non-vacuity: the two rects are genuinely different places, so the two lines above are not
    // comparing one rectangle with itself.
    expect(l.playerBaseRect()).not.toEqual(l.enemyBaseRect());
  });

  it('is an involution: mirroring twice restores the original geometry', () => {
    const l = make(Side.Bottom);
    const back = l.mirrored().mirrored();
    expect(back.localSide).toBe(l.localSide);
    expect(back.playerBaseRect()).toEqual(l.playerBaseRect());
    expect(back.gridToScreen(0, 0)).toEqual(l.gridToScreen(0, 0));
  });

  it('flips the row axis, which is the point of the exercise', () => {
    // Game row 0 (the player base row) sits at opposite ends of the board for the two sides; a
    // mirror that only relabelled `localSide` without re-deriving the geometry would return the
    // same screen position here and go unnoticed until a netplay joiner ran it.
    const l = make(Side.Bottom);
    const m = l.mirrored();
    expect(m.gridToScreen(0, 0)).not.toEqual(l.gridToScreen(0, 0));
    // …and it is the 180° flip, not an arbitrary offset: game cell (0,0) — the corner of the
    // player's own base row — is drawn in the mirror exactly where the opposite corner sits in
    // the original.
    expect(m.gridToScreen(0, 0)).toEqual(l.gridToScreen(BOARD_COLS - 1, BOARD_ROWS - 1));
    // The reverse direction too, so a mirror that flipped only one axis is caught.
    expect(m.gridToScreen(BOARD_COLS - 1, BOARD_ROWS - 1)).toEqual(l.gridToScreen(0, 0));
  });
});
