// What a battle-pass reward cell is allowed to say about its own state (2026-09-15, §53.3).
//
// `drawCell` draws a GLYPH for the three states that are facts (claimed / locked / pass-required)
// and a WORD only for `claimable`, which is an affordance rather than a status. That split is a
// judgement about REPETITION, not about width: at Lv.1 thirty-nine of the forty cells are locked,
// so `[lock] Locked` prints the same word thirty-nine times — measurably busier than a column of
// locks and saying nothing the lock does not. The one-off rows elsewhere (achievement tiers,
// recharge milestones, the mail banner) make the opposite trade through `ui/widgets/statusTag.ts`.
// Nothing about that reasoning is visible from inside this file, so it is pinned from outside.
//
// The second half is the bug this cell was patched for twice. The state marker is drawn FIRST and
// its width is what the reward band has left (`reserveW`); when the marker was a word, German's
// `Gesperrt` reserved 282 of a 465-px cell and the reward's `×N` ran 36 px into it on five rows of
// every German phone (sweep §50.12). A glyph reserves one glyph. The wiring is asserted directly:
// the reward group has to end left of the marker, in every state, at a cell width narrow enough
// that a regression would actually collide.
//
// `drawCell` is a pure function over a container, so no scene, no layout and no callbacks are
// needed. Runs under the headless PIXI adapter (vitest.ui.config.ts), whose measureText is a flat
// 7px per character — fine here: both sides of every comparison are measured with it.
// Run: npm run test:ui

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t } from '../../src/i18n';
import { drawCell, cellState, type CellState } from '../../src/scenes/BattlePassScene/cell';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Portrait's real cell box on a 390-wide phone: two columns of a 1080-wide design space. */
const CELL = { x: 0, y: 0, w: 465, h: 150 };

function draw(state: CellState, reward: { kind: string; id?: string; count: number } | null = { kind: 'coins', count: 60 }): PIXI.Container {
  const parent = new PIXI.Container();
  drawCell(parent, CELL.x, CELL.y, CELL.w, CELL.h, 5, reward, state);
  return parent;
}

function nodes(root: PIXI.Container): PIXI.DisplayObject[] {
  const out: PIXI.DisplayObject[] = [];
  const walk = (n: PIXI.Container): void => {
    out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  for (const c of root.children) walk(c as PIXI.Container);
  return out;
}

const iconsNamed = (root: PIXI.Container, kind: string): PIXI.DisplayObject[] =>
  nodes(root).filter((n) => n.name === `icon:${kind}`);
const texts = (root: PIXI.Container): string[] =>
  nodes(root).filter((n): n is PIXI.Text => n instanceof PIXI.Text).map((n) => n.text);

describe('BattlePassScene drawCell — state marker', () => {
  it('marks claimed with a check and no word', () => {
    const cell = draw('claimed');
    expect(iconsNamed(cell, 'check')).toHaveLength(1);
    expect(iconsNamed(cell, 'lock')).toHaveLength(0);
    // Only the level badge and the reward count. A state word reappearing here is the regression.
    expect(texts(cell)).toEqual([t('battlepass.level', { n: '5' }), '×60']);
  });

  it('marks locked and pass-required with a lock and no word', () => {
    for (const state of ['locked', 'pass_required'] as const) {
      const cell = draw(state);
      expect(iconsNamed(cell, 'lock'), state).toHaveLength(1);
      expect(iconsNamed(cell, 'check'), state).toHaveLength(0);
      expect(texts(cell), state).toEqual([t('battlepass.level', { n: '5' }), '×60']);
    }
  });

  it('keeps the WORD for claimable, which is an affordance and not a status', () => {
    const cell = draw('claimable');
    expect(texts(cell)).toContain(t('battlepass.claim'));
    expect(iconsNamed(cell, 'check')).toHaveLength(0);
    expect(iconsNamed(cell, 'lock')).toHaveLength(0);
  });

  it('leaves the reward group clear of the marker in every state', () => {
    for (const state of ['claimed', 'locked', 'pass_required'] as const) {
      const cell = draw(state, { kind: 'coins', count: 999_999 });
      const marker = [...iconsNamed(cell, 'check'), ...iconsNamed(cell, 'lock')][0]!;
      const amount = nodes(cell).find((n): n is PIXI.Text => n instanceof PIXI.Text && n.text.startsWith('×'))!;
      expect(amount.x + amount.width, `${state}: reward runs into the state marker`)
        .toBeLessThanOrEqual(marker.x);
    }
  });

  it('still derives the four states the same way', () => {
    // Guards the marker assertions above against silently testing states the scene cannot produce.
    const claimedFree = new Set([1]);
    const claimedPaid = new Set<number>();
    expect(cellState('free', 1, 5, claimedFree, claimedPaid, false, true)).toBe('claimed');
    expect(cellState('free', 9, 5, claimedFree, claimedPaid, false, true)).toBe('locked');
    expect(cellState('paid', 2, 5, claimedFree, claimedPaid, false, true)).toBe('pass_required');
    expect(cellState('paid', 2, 5, claimedFree, claimedPaid, true, true)).toBe('claimable');
    expect(cellState('free', 2, 5, claimedFree, claimedPaid, true, false)).toBe('locked');
  });
});
