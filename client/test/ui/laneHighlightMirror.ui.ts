// BoardView lane-highlight mirror coverage — regression for the "red lane over an
// empty spawn cell" bug seen by the netplay joiner (localSide = Side.Top).
//
// Root cause: `BoardView.laneRect(col)` computed its screen band straight from the
// raw game col (`col * cell`), while `ILayout.gridToScreen` mirrors BOTH axes for
// the joiner. So the unit-lane / column-spell highlight landed on the mirror-
// opposite band from where units in that lane actually render — the joiner saw a
// blocked lane painted red over a spawn cell that looked empty, because the truly
// occupied lane was drawn on the far band.
//
// The invariant this pins: for every attack lane, the highlight band returned by
// laneRect(col) must contain the screen point where a unit at that col renders
// (gridToScreen). This holds for both orientations and both sides — and would fail
// for Side.Top before the mirror fix.
//
// Headless: constructs the real BoardView (pixiHeadless adapter via
// vitest.ui.config.ts setupFiles), same approach as gameScenes.ui.ts. laneRect is
// private; we reach it via `(bv as any)` — this is a geometry unit test, not a
// public-API contract.

import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { BoardView } from '../../src/render/BoardView';
import { Side } from '../../src/game';
import {
  ATTACK_LANES,
  BOARD_COLS,
  BOTTOM_SPAWN_ROW,
  TOP_SPAWN_ROW,
} from '../../src/game/config';

interface Rect { x: number; y: number; w: number; h: number; }

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Landscape (1280×800) and portrait (800×1280) both exercised; both mirror the
// col axis for the joiner, on different screen axes.
const CASES = [
  { name: 'landscape', screenW: 1280, screenH: 800 },
  { name: 'portrait',  screenW: 800,  screenH: 1280 },
] as const;

for (const c of CASES) {
  describe(`BoardView lane highlight mirror — ${c.name}`, () => {
    for (const side of [Side.Bottom, Side.Top] as const) {
      const spawnRow = side === Side.Bottom ? BOTTOM_SPAWN_ROW : TOP_SPAWN_ROW;
      const label = side === Side.Bottom ? 'host (Side.Bottom)' : 'joiner (Side.Top)';

      it(`${label}: each lane's highlight band covers where that lane's unit renders`, () => {
        const layout = createLayout(c.screenW, c.screenH, side);
        const bv = new BoardView(layout);
        try {
          for (const col of ATTACK_LANES) {
            const rect = (bv as any).laneRect(col) as Rect;
            const pos  = layout.gridToScreen(col, spawnRow);
            expect(
              contains(rect, pos.x, pos.y),
              `lane ${col}: band ${JSON.stringify(rect)} must contain unit @${JSON.stringify(pos)}`,
            ).toBe(true);
          }
        } finally {
          bv.destroy();
        }
      });
    }

    it('joiner (Side.Top): the band is mirror-flipped vs the host, not identical', () => {
      // Guards the actual fix: an off-center lane must land on the opposite band for
      // the joiner. Pre-fix laneRect ignored localSide, so host and joiner bands
      // were identical and this would fail.
      const host   = new BoardView(createLayout(c.screenW, c.screenH, Side.Bottom));
      const joiner = new BoardView(createLayout(c.screenW, c.screenH, Side.Top));
      try {
        const col = ATTACK_LANES[0]!; // 0 — maximally off-center, clearest mirror
        const hostRect   = (host   as any).laneRect(col) as Rect;
        const joinerRect = (joiner as any).laneRect(col) as Rect;
        // The joiner band for col N must equal the host band for the mirrored col.
        const hostMirror = (host as any).laneRect(BOARD_COLS - 1 - col) as Rect;
        expect({ x: joinerRect.x, y: joinerRect.y }).toEqual({ x: hostMirror.x, y: hostMirror.y });
        expect({ x: joinerRect.x, y: joinerRect.y }).not.toEqual({ x: hostRect.x, y: hostRect.y });
      } finally {
        host.destroy();
        joiner.destroy();
      }
    });
  });
}
