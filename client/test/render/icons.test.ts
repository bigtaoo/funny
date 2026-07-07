// Guards the 2026-07-07 icons.ts split (855→123: draw fns moved into icons/*, dispatch became the
// exported DRAW record). Asserts the DRAW table resolves a live function for every IconKind — the
// residual risk after the split is a draw fn that fails to import (resolves to undefined at runtime,
// which the Record<IconKind,…> type cannot catch). No pixi rendering here, so no GL/canvas needed;
// lives in the render suite only because importing icons.ts pulls pixi.js-legacy. Run: npm run test:render
import { describe, it, expect } from 'vitest';
import { DRAW, type IconKind } from '../../src/render/icons';

// Exhaustive map of every IconKind. Typed Record<IconKind, true> so the compiler forces it to stay
// in sync with the union — adding a kind to IconKind without updating this map fails to compile.
const ALL_KINDS: Record<IconKind, true> = {
  book: true, globe: true, coin: true, trophy: true, castle: true, pencils: true,
  coins: true, coinStack: true, coinSack: true, coinChest: true,
  scrap: true, lead: true, binding: true,
  atk: true, hp: true, armor: true, spd: true, atkspd: true,
  brush: true,
  swords: true, replay: true, share: true, home: true,
  scope: true, flag: true, desk: true, cabinet: true, hammer: true,
  tag: true, capsule: true, cards: true, star: true, lock: true, medal: true, zoom: true, gift: true,
  close: true, check: true, play: true,
};

describe('icons DRAW dispatch table', () => {
  const kinds = Object.keys(ALL_KINDS) as IconKind[];

  it('resolves a live draw function for every IconKind (guards icons/* import wiring)', () => {
    for (const kind of kinds) {
      expect(typeof DRAW[kind], kind).toBe('function');
    }
  });

  it('has exactly the IconKind union as keys — no orphan or missing entries', () => {
    expect(Object.keys(DRAW).sort()).toEqual(kinds.sort());
  });
});
