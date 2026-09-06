// Regression for the 2026-09-05 check-in focus pass (user report + screenshot): the eye landed on
// the milestone cells (days 7/14/21/30) and on the block of already-claimed cells before it found
// the one cell the player came to tap. Cause was a visual-weight ranking that had grown the wrong
// way round — the claimable cell owned a single channel (a pale mint fill) while a milestone owned
// three (warm fill + a heavier gold border + the gold bonus badge), and the claimed fill was the
// darkest swatch on the grid.
//
// What is pinned here is the RANKING, not the palette: these assertions compare cells against each
// other (claimable's stroke vs a milestone's, milestone's vs a plain cell's, whether a cell is
// scaled / drawn last) so re-tuning any individual colour stays free, while re-inverting the
// hierarchy fails. The one absolute check is that a milestone which is ALSO today's claimable slot
// renders in the claimable style — that path used to swap to a gold fill with no green anywhere,
// i.e. the focal cue silently vanished on days 7/14/21/30.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles), where sketchPanel takes
// its no-atlas fallback and returns one PIXI.Graphics carrying both the fill rect and the pen
// strokes — so a cell's fill colour and border weight are both readable off `geometry.graphicsData`.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { DailyScene, type DailyCallbacks } from '../../src/scenes/DailyScene';
import { CHECKIN_PULSE } from '../../src/scenes/DailyScene/panels';
import { makeNewSave, type SaveData } from '../../src/game/meta/SaveData';
import { makeDayKey, makeMonthKey } from '../../src/game/meta/retention';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const NOW = Date.now();

/** A save whose check-in state has `claimedCount` days banked, last claimed today or yesterday. */
function saveWith(claimedCount: number, lastClaimedToday: boolean): SaveData {
  const save = makeNewSave();
  save.retention = {
    checkin: {
      monthKey: makeMonthKey(NOW),
      claimedDays: Array.from({ length: claimedCount }, (_, i) => i + 1),
      lastClaimedDayKey: makeDayKey(NOW - (lastClaimedToday ? 0 : 24 * 3600_000)),
    },
  };
  return save;
}

async function buildCheckinTab(save: SaveData, w = 1280, h = 800): Promise<DailyScene> {
  const cb: DailyCallbacks = {
    onBack() {},
    getSave: () => save,
    onCheckin: () => Promise.resolve({ ok: true } as never),
  };
  const scene = new DailyScene(createLayout(w, h), new InputManager(), cb);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const s = scene as unknown as { activeTab: string; render(): void };
  s.activeTab = 'checkin';
  s.render();
  return scene;
}

interface CellInk { fill: number; strokeWidth: number; strokeColor: number }

/** Reads one cell's fill colour and border weight off the Graphics drawn just before its day number. */
function cellInk(root: PIXI.Container, day: number): CellInk {
  const parent = parentOfDay(root, day);
  const idx = parent.children.findIndex((c) => c instanceof PIXI.Text && c.text === String(day));
  expect(idx).toBeGreaterThan(0);
  // Walk back over the cell's own Graphics (an ordinary cell has one, the claimable cell also has
  // its second traced-again frame) and take the earliest — the filled panel underneath everything.
  let first = idx - 1;
  while (first > 0 && parent.children[first - 1] instanceof PIXI.Graphics) first--;
  const g = parent.children[first] as PIXI.Graphics;
  const data = (g.geometry as unknown as {
    graphicsData: { fillStyle: { color: number }; lineStyle: { width: number; color: number } }[];
  }).graphicsData;
  return { fill: data[0]!.fillStyle.color, strokeWidth: data[1]!.lineStyle.width, strokeColor: data[1]!.lineStyle.color };
}

/** The container a day number lives in: the shared grid container, or the claimable cell's own one. */
function parentOfDay(root: PIXI.Container, day: number): PIXI.Container {
  let found: PIXI.Container | null = null;
  const walk = (node: PIXI.Container): void => {
    for (const c of node.children) {
      if (c instanceof PIXI.Text && c.text === String(day)) { found = node; return; }
      if (c instanceof PIXI.Container) walk(c);
      if (found) return;
    }
  };
  walk(root);
  expect(found).not.toBeNull();
  return found!;
}

/** The scaled-up cell container renderCheckin appends last, or null when nothing is claimable. */
function focalCell(root: PIXI.Container): PIXI.Container | null {
  const last = root.children[root.children.length - 1];
  if (!(last instanceof PIXI.Container) || last instanceof PIXI.Text || last instanceof PIXI.Graphics) return null;
  return last.scale.x > 1 ? last : null;
}

function dayOf(cell: PIXI.Container): string {
  const t = cell.children.find((c) => c instanceof PIXI.Text) as PIXI.Text | undefined;
  return t?.text ?? '';
}

describe('DailyScene checkin grid — the claimable cell is the focal point (2026-09-05)', () => {
  it('draws the claimable cell last, in its own container, scaled above every neighbour', async () => {
    const scene = await buildCheckinTab(saveWith(3, false));   // days 1-3 banked → day 4 claimable
    const cell = focalCell(scene.container);
    expect(cell).not.toBeNull();
    expect(dayOf(cell!)).toBe('4');
    // Never drawn at 1.0: the size step has to survive a paused ticker, so the breathe rides on
    // top of a floor above 1 rather than starting from parity with the other 29 cells.
    expect(cell!.scale.x).toBeGreaterThan(1);
    expect(cell!.scale.x).toBe(CHECKIN_PULSE.min);
    // pivot === position, or scaling would swing the cell across the page instead of growing it.
    expect(cell!.pivot.x).toBe(cell!.position.x);
    expect(cell!.pivot.y).toBe(cell!.position.y);
    // Nothing else on the page is scaled — being the only moving/oversized thing IS the cue.
    for (const other of scene.container.children.slice(0, -1)) {
      expect((other as PIXI.Container).scale?.x ?? 1).toBe(1);
    }
    scene.destroy();
  });

  it('gives the claimable cell a heavier border than a milestone, and demotes the milestone to a plain cell weight', async () => {
    const scene = await buildCheckinTab(saveWith(3, false));   // day 4 claimable; 7 is a milestone
    const claimable = cellInk(scene.container, 4);
    const milestone = cellInk(scene.container, 7);
    const plain = cellInk(scene.container, 8);

    // The inversion this pass fixes: the milestone used to be the heaviest stroke on the page and
    // the claimable cell shared the plain weight.
    expect(claimable.strokeWidth).toBeGreaterThan(milestone.strokeWidth);
    expect(milestone.strokeWidth).toBe(plain.strokeWidth);
    // A milestone keeps exactly one channel — a warm fill. Its border ink may still differ, but its
    // weight may not, and its fill must sit closer to a plain cell's than the claimable cell's does.
    expect(milestone.fill).not.toBe(plain.fill);
    expect(chDist(milestone.fill, plain.fill)).toBeLessThan(chDist(claimable.fill, plain.fill));
    scene.destroy();
  });

  it('keeps a milestone that is ALSO the claimable day in the claimable style (it used to turn gold and lose the cue)', async () => {
    const midMonth = await buildCheckinTab(saveWith(3, false));
    const ordinaryClaimableFill = cellInk(midMonth.container, 4).fill;
    midMonth.destroy();

    const scene = await buildCheckinTab(saveWith(6, false));   // days 1-6 banked → day 7 claimable
    const cell = focalCell(scene.container);
    expect(cell).not.toBeNull();
    expect(dayOf(cell!)).toBe('7');
    expect(cellInk(scene.container, 7).fill).toBe(ordinaryClaimableFill);
    scene.destroy();
  });

  it('breathes the claimable cell within its bounds on update(), without re-rendering', async () => {
    const scene = await buildCheckinTab(saveWith(3, false));
    const cell = focalCell(scene.container)!;
    const seen: number[] = [];
    for (let i = 0; i < 24; i++) {
      scene.update(CHECKIN_PULSE.periodSec / 16);
      seen.push(cell.scale.x);
      expect(cell.scale.x).toBeGreaterThanOrEqual(CHECKIN_PULSE.min - 1e-9);
      expect(cell.scale.x).toBeLessThanOrEqual(CHECKIN_PULSE.max + 1e-9);
    }
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.01);
    // Same node throughout: the breathe must not be driving a re-render (which would re-mint 30
    // cells' worth of Text textures every frame — see tearDownChildren's iPad note).
    expect(focalCell(scene.container)).toBe(cell);
    scene.destroy();
  });

  it('stops breathing when the tab switches away, instead of writing into a destroyed node', async () => {
    const scene = await buildCheckinTab(saveWith(3, false));
    const stale = focalCell(scene.container)!;
    const s = scene as unknown as { activeTab: string; render(): void; pulseTarget: PIXI.Container | null };
    s.activeTab = 'tasks';
    s.render();
    expect(s.pulseTarget).toBeNull();
    // render() ran tearDownChildren over the old tab, so `stale` is a destroyed node — touching its
    // transform throws. That is exactly why the target has to be cleared rather than left dangling:
    // a stale reference here would take the whole frame down on the next tick.
    expect(() => stale.scale.x).toThrow();
    expect(() => scene.update(CHECKIN_PULSE.periodSec / 4)).not.toThrow();
    scene.destroy();
  });

  it('points at tomorrow\'s slot once today is already claimed, so the eye still has somewhere to land', async () => {
    const scene = await buildCheckinTab(saveWith(3, true));   // claimed today → nothing claimable
    expect(focalCell(scene.container)).toBeNull();

    const tomorrow = cellInk(scene.container, 4);
    const plain = cellInk(scene.container, 8);
    expect(tomorrow.strokeWidth).toBeGreaterThan(plain.strokeWidth);
    expect(tomorrow.fill).not.toBe(plain.fill);
    // …and says so in words on the title line.
    expect(findText(scene.container, (t) => t.includes('4') && /tomorrow/i.test(t))).not.toBeNull();
    scene.destroy();
  });

  it('names the claimable day on the title line', async () => {
    const scene = await buildCheckinTab(saveWith(3, false));
    expect(findText(scene.container, (t) => t.includes('4') && /claim/i.test(t))).not.toBeNull();
    scene.destroy();
  });

  // The hint is right-aligned to the content column and shares its line with the section title, so
  // a narrow column (portrait) or a long locale can run the two into each other. It is a redundant
  // cue and is dropped in that case — but it must never be drawn overlapping.
  it('never overlaps the section title, in either orientation and every locale', async () => {
    for (const [w, h] of [[1280, 800], [800, 2160]] as const) {
      const scene = await buildCheckinTab(saveWith(3, false), w, h);
      const title = findText(scene.container, (t) => /check-in/i.test(t) && !/claim/i.test(t));
      expect(title).not.toBeNull();
      const hint = findText(scene.container, (t) => /claim/i.test(t) && t.includes('4'));
      if (hint) expect(hint.x).toBeGreaterThan(title!.x + title!.width);
      scene.destroy();
    }
  });
});

// The hand-drawn half of the same pass (2026-09-05, `feat(client): point at the claimable check-in
// cell with hand-drawn art`): a curved arrow hooked into the claimable cell and a starburst behind
// it. checkinCueArt.test.ts measures the two PNGs as art (the baked green, the hollow centre); what
// nothing measured is where panels.ts PUTS them, which is where the arithmetic lives:
//
//   - The source arrow points down-and-right, so the directions used here are FLIPS of it, and
//     mirroring a Container scales it around its own origin — every flip needs a position
//     compensation of one whole sprite width. Get that backwards and the arrow lands a full sprite
//     away, on the wrong side of the cell. It would be wrong only for days in the right-hand half of
//     the grid, so a screenshot taken on the wrong day shows nothing at all.
//   - The burst is masked at the grid's top edge because a row-0 cell's upward rays otherwise strike
//     through the section title. The mask is invisible in every screenshot not taken on days 1-7,
//     and deleting it looks like removing a redundant node.
//
// Both cues also live inside the claimable cell's own (breathing, torn-down-on-tab-switch) container
// rather than the shared grid one, which is what makes them scale with it and die with it.
//
// The arrow assertions are written against its TAIL corner — with |scale| == 1 the sprite's local
// (0,0) maps exactly to (arrow.x, arrow.y) — because the art itself never decodes here (every .png
// import is stubbed to a 1x1 data URI, see vitest.ui.config.ts), so the node has a transform but no
// bounds. That is enough: the tail is the end the compensation moves.
describe('DailyScene checkin grid — the hand-drawn cue art points at the claimable cell (2026-09-05)', () => {
  /** The claimable cell's own container: [clip, burst, fill, trace, number, ...reward, arrow]. */
  function cueNodes(root: PIXI.Container): { focal: PIXI.Container; clip: PIXI.Graphics; burst: PIXI.Container; arrow: PIXI.Container } {
    const focal = focalCell(root);
    expect(focal, 'no claimable cell to carry the cues').not.toBeNull();
    const kids = focal!.children;
    return {
      focal: focal!,
      clip: kids[0] as PIXI.Graphics,
      burst: kids[1] as PIXI.Container,
      arrow: kids[kids.length - 1] as PIXI.Container,
    };
  }

  /** A cell's rectangle in design space, read off the filled panel drawn under its day number. */
  function cellRect(root: PIXI.Container, day: number): { x: number; y: number; w: number; h: number } {
    const parent = parentOfDay(root, day);
    const idx = parent.children.findIndex((c) => c instanceof PIXI.Text && c.text === String(day));
    let first = idx - 1;
    while (first > 0 && parent.children[first - 1] instanceof PIXI.Graphics) first--;
    const g = parent.children[first] as PIXI.Graphics;
    const shape = (g.geometry as unknown as { graphicsData: { shape: { width: number; height: number } }[] })
      .graphicsData[0]!.shape;
    return { x: g.x, y: g.y, w: shape.width, h: shape.height };
  }

  // Day 3 sits in the left half of the week row, day 6 in the right half — the two sides of
  // `fromLeft`, i.e. the mirrored branch and the unmirrored one.
  for (const [claimed, day, side] of [[2, 3, 'left'], [5, 6, 'right']] as const) {
    it(`hooks the arrow in from below and outward on a ${side}-half day, one whole sprite of compensation and all`, async () => {
      const scene = await buildCheckinTab(saveWith(claimed, false));
      const { focal, arrow } = cueNodes(scene.container);
      expect(dayOf(focal)).toBe(String(day));
      expect(arrow instanceof PIXI.Text || arrow instanceof PIXI.Graphics).toBe(false);
      expect(arrow.parent, 'the arrow must breathe and tear down with the cell').toBe(focal);

      // A mirror, not a resize: the two halves differ in the SIGN of scale.x and nothing else.
      expect(Math.abs(arrow.scale.x)).toBeCloseTo(1, 6);
      expect(arrow.scale.x).toBe(side === 'left' ? 1 : -1);
      expect(arrow.scale.y, 'always drawn from below, so the vertical flip is unconditional').toBe(-1);

      const cell = cellRect(scene.container, day);
      // The tail corner: below the cell, and on the side that faces the page edge. Drop either
      // branch's `± aSize` compensation and the tail lands inside the cell instead.
      expect(arrow.y).toBeGreaterThan(cell.y + cell.h);
      if (side === 'left') expect(arrow.x).toBeLessThan(cell.x);
      else expect(arrow.x).toBeGreaterThan(cell.x + cell.w);
      // …but only just below: it may fall on the next row's number-free lower half, never further.
      const rowPitch = cellRect(scene.container, day + 7).y - cell.y;
      expect(arrow.y - (cell.y + cell.h)).toBeLessThan(rowPitch);
      scene.destroy();
    });
  }

  it('lays the burst under the cell’s own fill and clips it off the section title', async () => {
    const scene = await buildCheckinTab(saveWith(2, false));   // day 3 → row 0, the row that can reach the title
    const { focal, clip, burst } = cueNodes(scene.container);
    expect(burst.parent).toBe(focal);
    expect(burst.mask, 'the burst is the one masked node in the grid').toBe(clip);
    // Added before the cell's own panel, so only the ray tips show past the fill.
    const fillIdx = focal.children.findIndex((c) => c instanceof PIXI.Graphics && c !== clip);
    expect(focal.children.indexOf(burst)).toBeLessThan(fillIdx);

    // The section title above the grid: the last "check-in" line drawn above the mask's edge (the
    // others are the header title and the tab rail's own labels, which sit further down the page).
    const clipTop = (clip.geometry as unknown as { graphicsData: { shape: { y: number } }[] })
      .graphicsData[0]!.shape.y;
    const maskTop = focal.toGlobal(new PIXI.Point(0, clipTop)).y;
    const titles = allTexts(scene.container).filter((t) => /check-in/i.test(t.text) && t.y < maskTop);
    const title = titles.reduce((a, b) => (a.y > b.y ? a : b));
    const titleBottom = title.y + title.height;

    expect(maskTop, 'the burst is clipped at or below the section title').toBeGreaterThanOrEqual(titleBottom);
    // …and the clip is load-bearing rather than decorative: unmasked, the burst really does reach up
    // through that line. Without this the case above would still pass with the mask deleted.
    expect(focal.toGlobal(new PIXI.Point(0, burst.y)).y).toBeLessThan(titleBottom);
    scene.destroy();
  });

  it('draws no cue at all once today is claimed — nothing to point at, so nothing points', async () => {
    const scene = await buildCheckinTab(saveWith(3, true));
    expect(focalCell(scene.container)).toBeNull();
    // The burst is the only masked node the grid ever builds, so its absence is checkable even
    // though the stubbed art makes every raster node look alike.
    const grid = parentOfDay(scene.container, 8);
    let masked = 0;
    const walk = (n: PIXI.Container): void => {
      for (const c of n.children) {
        if ((c as PIXI.Container).mask) masked++;
        if (c instanceof PIXI.Container) walk(c);
      }
    };
    walk(grid);
    expect(masked).toBe(0);
    scene.destroy();
  });
});

/** Depth-first collect of every PIXI.Text under `root`. */
function allTexts(root: PIXI.Container, out: PIXI.Text[] = []): PIXI.Text[] {
  for (const c of root.children) {
    if (c instanceof PIXI.Text) out.push(c);
    else if (c instanceof PIXI.Container) allTexts(c, out);
  }
  return out;
}

/** Sum of per-channel distance between two RGB ints — "how far apart do these two swatches read". */
function chDist(a: number, b: number): number {
  return Math.abs((a >> 16 & 0xff) - (b >> 16 & 0xff))
    + Math.abs((a >> 8 & 0xff) - (b >> 8 & 0xff))
    + Math.abs((a & 0xff) - (b & 0xff));
}

function findText(container: PIXI.Container, predicate: (s: string) => boolean): PIXI.Text | null {
  let found: PIXI.Text | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && predicate(node.text)) { found = node; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}
