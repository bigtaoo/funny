// Regression coverage for the 2026-08-10 "recharge page bottom half blocked" fix: peekViewportH
// used to require a *comfortable* ~28%-tall natural peek before leaving the viewport untouched,
// and otherwise discarded an entire already-fully-fitting row to manufacture one — wasting up to
// almost a full row's height of unrendered background below the fold. See scrollPeek.ts's doc
// comment for the full root-cause writeup.
import { describe, it, expect } from 'vitest';
import { peekViewportH } from '../src/ui/widgets/scrollPeek';

describe('peekViewportH', () => {
  it('returns availH unchanged when content already fits', () => {
    expect(peekViewportH(1000, 300, 900)).toBe(1000);
    expect(peekViewportH(1000, 300, 1000)).toBe(1000);
  });

  it('returns availH unchanged when unit is degenerate', () => {
    expect(peekViewportH(1000, 0, 5000)).toBe(1000);
    expect(peekViewportH(1000, -1, 5000)).toBe(1000);
  });

  it('keeps the full height when the naive remainder is already a comfortable peek (>= 28%)', () => {
    // unit=697, availH=1753 → fullRows=2, rem=359 (~51% of unit) — well past the old 28% bar.
    expect(peekViewportH(1753, 697, 2301)).toBe(1753);
  });

  it('regression: keeps the full height for a thin-but-visible natural remainder too (was the bug)', () => {
    // Exact numbers from the reported bug: Shop Coins tab, portrait, squat aspect (designHeight
    // clamped to the 1920 floor). fullRows=2, rem=47 (~6.7% of unit) — below the old 28% bar, so
    // the pre-fix code discarded an entire already-fully-fitting row and wasted ~549px on nothing.
    const availH = 1441;
    const unit = 697;
    const contentH = 2264;
    expect(peekViewportH(availH, unit, contentH)).toBe(availH);
  });

  it('still backs off a row for a truly razor-flush cut (naive remainder near 0)', () => {
    // unit=700, availH=2100 → fullRows=3, rem=0 exactly: nothing would peek at all without help.
    const availH = 2100;
    const unit = 700;
    const contentH = 3500; // > availH, so peekViewportH actually engages
    const peek = Math.round(unit * 0.28); // 196
    expect(peekViewportH(availH, unit, contentH)).toBe((3 - 1) * unit + peek);
  });

  it('never backs off when only one row fits, even razor-flush (would hide the only visible row)', () => {
    const availH = 700;
    const unit = 700;
    const contentH = 2000;
    expect(peekViewportH(availH, unit, contentH)).toBe(availH);
  });

  it('a remainder right at the MIN_VISIBLE_REM boundary is treated as already-visible (no waste)', () => {
    // fullRows=2, unit=100 → rem=12 exactly at the boundary.
    const availH = 212;
    const unit = 100;
    const contentH = 500;
    expect(peekViewportH(availH, unit, contentH)).toBe(availH);
  });

  it('a remainder just under the boundary still gets the manufactured peek', () => {
    // fullRows=2, unit=100 → rem=11, one px under the boundary.
    const availH = 211;
    const unit = 100;
    const contentH = 500;
    const peek = Math.round(unit * 0.28); // 28
    expect(peekViewportH(availH, unit, contentH)).toBe((2 - 1) * unit + peek);
  });
});
