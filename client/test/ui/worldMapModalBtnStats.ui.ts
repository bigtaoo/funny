// A modal button's stat row — the `[glyph][figure]` chips under the label
// (WorldMapPanels/core.ts `buildStatRow` and the block layout around it, 2026-09-17).
//
// Why the row exists: the team picker spelled every figure into the label
// (`Team 1 · Troops 2525 · Stamina 100`), which at `FS.title` in a 210px column wraps to three
// lines inside an 84px button — the third one clipped, and the clipped part was the only part that
// differed between the five rows (see net/march.ts). The words are glyphs now; the figures keep
// their size.
//
// What these cases pin is the geometry that makes that trade real, none of which is visible from
// the picker's own seam (that one only sees `showModal`'s arguments):
//   1. both chips are drawn under the label, inside the button, in the order passed;
//   2. label + chips are centred as ONE block, so the label gives up the exact middle;
//   3. a chip row too wide for its column scales as a group instead of spilling out of the button;
//   4. a button without stats keeps the old layout exactly.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles), which measures every string
// at 7px/char at every font size — so the label widths below are in those units, not the real font's.
//
// NOT pinned here: that the chip row is charged to the LABEL's height budget (so the leading-glyph
// gate keeps judging the label against the room it actually has). The stub 2D context reports a line
// as ~10px tall at EVERY font size, so no label this harness can build ever runs out of an 84px
// button's height — the case would pass with the budget removed. It is a real-font property, checked
// on screen instead.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { ModalButton } from '../../src/scenes/worldmap/WorldMapPanels/modalLine';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Landscape design space wide enough for the modal to reach its `PANEL_W.md` tier (900). */
const [W, H] = [1920, 1080];

interface Rect { x: number; y: number; w: number; h: number }
interface Placed { id: string; x: number; y: number }

function buildHarness(): { ctx: WorldMapContext; panels: WorldMapPanels } {
  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    selectedTile: null,
    toastTimer: 0,
    topInset: 0,
    me: { joined: true },
    cb: { accountId: 'me', worldId: 'w1', getCoins: (): number => 0 },
    view: { renderMap: vi.fn(), centerAt: vi.fn() },
  } as unknown as WorldMapContext;
  return { ctx, panels: new WorldMapPanels(ctx) };
}

/**
 * Every label and icon the modal drew, in ABSOLUTE coordinates — a chip lives inside the stat row's
 * own (possibly scaled) container, so the walk has to carry the transform down. Icons identify
 * themselves by `render/iconTag`'s `icon:<kind>` name, which is what tells a 26px leading glyph
 * apart from a 20px chip glyph without measuring either.
 */
function drawn(ctx: WorldMapContext): { labels: Placed[]; icons: Placed[] } {
  const labels: Placed[] = [];
  const icons: Placed[] = [];
  const walk = (node: PIXI.Container, dx: number, dy: number, scale: number): void => {
    for (const child of node.children as PIXI.DisplayObject[]) {
      const x = dx + child.x * scale;
      const y = dy + child.y * scale;
      if (child instanceof PIXI.Text) {
        labels.push({ id: child.text, x, y });
      } else if (typeof child.name === 'string' && child.name.startsWith('icon:')) {
        icons.push({ id: child.name.slice('icon:'.length), x, y });
      } else if (child instanceof PIXI.Container && child.children.length > 0) {
        walk(child, x, y, scale * child.scale.x);
      }
    }
  };
  walk(ctx.modalLayer, 0, 0, 1);
  return { labels, icons };
}

const inside = (p: Placed, r: Rect): boolean =>
  p.x >= r.x - 1 && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

const teamBtn = (label: string, troops: string, stamina: string): ModalButton => ({
  label,
  action: vi.fn(),
  icon: 'swords',
  stats: [{ icon: 'unit', text: troops }, { icon: 'flame', text: stamina }],
});

describe('modal button stat chips', () => {
  it('draws both figures under the label, inside the button, in the order passed', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Pick a team'], [teamBtn('Team 1', '2525', '100')]);
    const rect = ctx.modalBtnRects[0]!.rect;
    const { labels, icons } = drawn(ctx);
    const name = labels.find((e) => e.id === 'Team 1')!;
    const troops = labels.find((e) => e.id === '2525')!;
    const stamina = labels.find((e) => e.id === '100')!;
    for (const chip of [troops, stamina]) {
      expect(inside(chip, rect)).toBe(true);
      expect(chip.y).toBeGreaterThan(name.y);
    }
    expect(troops.x).toBeLessThan(stamina.x);
    // Each figure has its own glyph, to its own left.
    const unit = icons.find((g) => g.id === 'unit')!;
    const flame = icons.find((g) => g.id === 'flame')!;
    expect(unit.x).toBeLessThan(troops.x);
    expect(flame.x).toBeLessThan(stamina.x);
    expect(unit.x).toBeLessThan(flame.x);
  });

  it('centres label + chips as one block, so the label gives up the exact middle', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Pick a team'], [teamBtn('Team 1', '2525', '100')]);
    const rect = ctx.modalBtnRects[0]!.rect;
    const mid = rect.y + rect.h / 2;
    const { labels, icons } = drawn(ctx);
    const name = labels.find((e) => e.id === 'Team 1')!;
    expect(name.y).toBeLessThan(mid);        // pushed up by the row beneath it
    expect(name.y).toBeGreaterThan(rect.y);  // ...but still well inside its own button
    // The leading glyph rides with the label, not with the button's middle.
    const lead = icons.find((g) => g.id === 'swords')!;
    expect(lead.y).toBeLessThan(mid);
  });

  it('leaves a button without stats on the middle line, exactly as before', () => {
    const { ctx, panels } = buildHarness();
    panels.showModal(['Pick a team'], [{ label: 'Close', action: vi.fn(), icon: 'close' }]);
    const rect = ctx.modalBtnRects[0]!.rect;
    expect(drawn(ctx).labels.find((e) => e.id === 'Close')!.y).toBe(rect.y + rect.h / 2);
  });

  it('scales a chip row too wide for its column instead of spilling it out of the button', () => {
    const { ctx, panels } = buildHarness();
    // Four buttons → one row at `btnW` 210, i.e. 194px for the row. Two chips of an 11-digit figure
    // want 30 + 6 + 77 + 18 + 30 + 6 + 77 = 244 at the headless 7px/char, so the row has to shrink
    // as a group rather than run past the button's edge.
    const FIG = '8'.repeat(11);
    panels.showModal(['Pick a team'], Array.from({ length: 4 }, () => teamBtn('Team 1', FIG, FIG)));
    const { labels } = drawn(ctx);
    const figures = labels.filter((e) => e.id === FIG);
    expect(figures).toHaveLength(8);
    for (const { rect } of ctx.modalBtnRects) {
      const own = figures.filter((f) => inside(f, rect)).sort((a, b) => a.x - b.x);
      expect(own).toHaveLength(2);
      // Non-vacuous: at scale 1 the second figure would start 131px after the first (77 + 18 + 30 + 6).
      const gap = own[1]!.x - own[0]!.x;
      expect(gap).toBeLessThan(131);
      // ...and the last figure, at that same group scale, still ends inside the button.
      expect(own[1]!.x + 77 * (gap / 131)).toBeLessThanOrEqual(rect.x + rect.w);
    }
  });
});
