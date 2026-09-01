// Contract: the world-map panels route through the game's SHARED widgets, not private copies
// (UI_DESIGN_LOG_2026-08.md §42).
//
// Sibling of worldMapPanelScale.ui.ts, and written for the same reason. That file guards the
// enlargement pass (§41); this one guards the widget pass (§42). Both exist because every other
// test on these panels asserts *behaviour* — which callback fires, which gate blocks — and a panel
// that hand-rolls its own tab strip, its own confirm dialog and its own scroll viewport behaves
// exactly like one that uses the shared ones. The 2026-08-30 audit found four such hand-rolled
// components that had drifted for months with the suite fully green.
//
// So each case below asserts a property a hand-rolled replacement would NOT have:
//   - tab strip   : inactive cells read as paper (C.mid label), not solid slabs (C.light label),
//                   and the tab you are already on is not tappable
//   - confirm     : the rects are identical to what drawConfirmDialog itself produces, and the
//                   panel body is not drawn behind it
//   - scroll list : a razor-flush viewport gets backed off, i.e. peekViewportH is really in the path
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapPanelsCore } from '../../src/scenes/worldmap/WorldMapPanels/core';
import { drawConfirmDialog } from '../../src/ui/dialogs/confirmDialog';
import { PANEL_W, PANEL_MARGIN, PANEL_PAD } from '../../src/scenes/worldmap/WorldMapPanels/spec';
import { ui as C } from '../../src/render/sketchUi';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1080, 1920];

const TERRITORIES = [
  { x: 1, y: 1, type: 'territory', level: 1, garrison: 5 },
  { x: 2, y: 2, type: 'territory', level: 1, garrison: 7 },
  { x: 3, y: 3, type: 'territory', level: 2, garrison: 9 },
] as unknown as WorldTileView[];

function buildHarness(overrides: Partial<Record<string, unknown>> = {}) {
  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    infoScrollRect: null,
    infoScrollY: 0,
    infoMaxScroll: 0,
    infoScrollRerender: null,
    shopPanelOpen: false,
    shopItems: [],
    replayPanelOpen: false,
    sieges: [],
    territoryPanelOpen: true,
    territoryTab: 'overview',
    territories: [],
    territoryHiddenLevels: new Set<number>(),
    territoryAbandonConfirm: null,
    nations: [],
    season: null,
    selectedTile: null,
    toastTimer: 0,
    topInset: 0,
    me: {
      joined: true,
      resources: { ink: 100, paper: 200, graphite: 300, metal: 400, sticker: 500 },
      yieldRate: { ink: 12, paper: 7, graphite: 3, metal: 20, sticker: 1 },
      troops: 320, troopCap: 800, territoryCount: 12,
    },
    cb: {
      accountId: 'me',
      getCoins: () => 1000,
      worldId: 'w1',
      worldApi: { getNations: vi.fn(async () => []) },
    },
    view: { renderMap: vi.fn(), centerAt: vi.fn() },
    net: { refreshTerritories: vi.fn(async () => {}), doAbandonFromList: vi.fn(async () => {}) },
    ...overrides,
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  return { ctx, panels };
}

/** Every PIXI.Text under a container, masked scroll layers included. */
function allTexts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children as PIXI.DisplayObject[]) {
      if (child instanceof PIXI.Text) out.push(child);
      else if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(root);
  return out;
}

/** PIXI normalises a numeric `fill` to a '#rrggbb' string on the way into the style object. */
const fillOf = (txt: PIXI.Text): number => {
  const fill = txt.style.fill as number | string;
  return typeof fill === 'string' ? parseInt(fill.replace('#', ''), 16) : fill;
};

const TAB_LABELS = (): string[] => [
  t('world.territoryTabOverview'),
  t('world.territoryTabList'),
  t('world.info'),
];

/**
 * The tab strip's three labels.
 *
 * Located by geometry, not by string alone: in English `world.territoryTabList` and
 * `world.territory` are both "Territory", so a plain text match also picks up the Overview tab's
 * stat card. The tab hits are pushed first, so `modalBtnRects[0]` is always one of the strip's
 * cells and its rect gives the band the three labels must sit in.
 */
function tabTextsOf(ctx: WorldMapContext): PIXI.Text[] {
  const band = ctx.modalBtnRects[0]!.rect;
  const labels = TAB_LABELS();
  return allTexts(ctx.modalLayer).filter((x) => {
    if (!labels.includes(x.text)) return false;
    const b = x.getBounds();
    const cy = b.y + b.height / 2;
    return cy >= band.y && cy <= band.y + band.h;
  });
}

describe('Territory panel tabs are the shared hub-tab strip, not three solid slabs', () => {
  // The visual tell, and the whole point of the swap: `drawHubTabs` paints inactive cells as PAPER
  // with a `C.mid` label, so the strip reads as "these are pages you can switch between". The
  // hand-rolled `panelButton` version it replaced filled every cell solid (dark, red for the active
  // one) and drew EVERY label in `C.light` — three buttons, not a tab bar.
  it('draws exactly one white active label and paints the rest C.mid, never all-C.light', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'overview' });
    panels.renderTerritoryPanel();

    const tabTexts = tabTextsOf(ctx);
    expect(tabTexts).toHaveLength(3);

    const white = tabTexts.filter((x) => fillOf(x) === 0xffffff);
    expect(white).toHaveLength(1);
    expect(white[0]!.text).toBe(t('world.territoryTabOverview')); // the open tab
    expect(white[0]!.style.fontWeight).toBe('bold');

    for (const x of tabTexts) {
      if (x === white[0]) continue;
      expect(fillOf(x)).toBe(C.mid);
    }
    // The pre-2026-08-30 strip drew all three in C.light (0xdddddd). None may be.
    expect(tabTexts.some((x) => fillOf(x) === C.light)).toBe(false);
  });

  it('gives the open tab no hit rect: only the two you can switch TO are tappable', () => {
    const cases = [
      { tab: 'overview', targets: [t('world.territoryTabList'), t('world.info')] },
      { tab: 'list', targets: [t('world.territoryTabOverview'), t('world.info')] },
      { tab: 'world', targets: [t('world.territoryTabOverview'), t('world.territoryTabList')] },
    ];
    for (const { tab, targets } of cases) {
      const { ctx, panels } = buildHarness({ territoryTab: tab, territories: TERRITORIES });
      panels.renderTerritoryPanel();

      // A label "belongs to" a hit rect when the label's centre falls inside it.
      const tappable = tabTextsOf(ctx).filter((x) => {
        const b = x.getBounds();
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        return ctx.modalBtnRects.some(
          (r) => cx >= r.rect.x && cx <= r.rect.x + r.rect.w && cy >= r.rect.y && cy <= r.rect.y + r.rect.h,
        );
      });
      expect(tappable.map((x) => x.text).sort()).toEqual([...targets].sort());
    }
  });

  it('spans the panel inner width: the strip is placed against the panel, not the screen', () => {
    // `drawHubTabs` was written for a full-width strip starting at x=0 with a `w*0.04` pad; the
    // panel passes `{x: px, pad: PANEL_PAD, gap: MARGIN}` to re-home it inside the modal. Drop that
    // argument and the cells shrink toward the screen's left, stranding the last one well short of
    // the panel's right edge — so pin BOTH edges against the panel, not just "inside it somewhere".
    const { ctx, panels } = buildHarness({ territoryTab: 'overview' });
    panels.renderTerritoryPanel();

    const pw = Math.min(PANEL_W.lg, W - PANEL_MARGIN * 2);
    const px = (W - pw) / 2;
    const bounds = tabTextsOf(ctx).map((x) => x.getBounds());
    const stripLeft = Math.min(...bounds.map((b) => b.x));
    const stripRight = Math.max(...bounds.map((b) => b.x + b.width));

    // Labels are centred in their cells, so they sit inside the padding, never past it.
    expect(stripLeft).toBeGreaterThanOrEqual(px + PANEL_PAD);
    expect(stripRight).toBeLessThanOrEqual(px + pw - PANEL_PAD);
    // ...and the three cells together really do fill the panel.
    expect(stripRight).toBeGreaterThan(px + pw * 0.8);
  });

  it('still switches tabs when one of those rects is fired', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'overview' });
    panels.renderTerritoryPanel();
    // Tab hits are pushed first and in tab order; on Overview that is [list, world].
    ctx.modalBtnRects[0]!.fn();
    expect(ctx.territoryTab).toBe('list');
  });
});

describe('Abandon confirm is the shared drawConfirmDialog', () => {
  function openConfirm() {
    const { ctx, panels } = buildHarness({ territoryTab: 'list', territories: TERRITORIES });
    (ctx as unknown as { territoryAbandonConfirm: unknown }).territoryAbandonConfirm = { x: 9, y: 4 };
    panels.renderTerritoryPanel();
    return { ctx, panels };
  }

  it('produces exactly the rects drawConfirmDialog itself would, for the same viewport', () => {
    // The strongest available "this really is the shared dialog" assertion: draw the shared one
    // into a scratch container at the same w/h and compare geometry. A re-hand-rolled dialog (the
    // one this replaced used 180x56 buttons against the shared 126x42) fails here even while it
    // still calls doAbandonFromList correctly.
    const { ctx } = openConfirm();
    const scratch = new PIXI.Container();
    const reference = drawConfirmDialog(scratch, W, H, 'x', () => {}, () => {});

    expect(ctx.modalBtnRects.map((r) => r.rect)).toEqual(reference.map((r) => r.rect));
  });

  it('replaces the panel rather than drawing over it, so the list underneath cannot be clicked through', () => {
    // Note on what enforces this: `drawConfirmDialog` tears the modal layer down itself, so routing
    // through it buys the guarantee for free — that is the point. This case fails for a
    // re-hand-rolled dialog that paints onto the live panel (which is what the pre-2026-08-30 code
    // did, leaving the list's Jump/Abandon buttons drawn and, worse, its drag-to-scroll region
    // live; that second half is pinned separately in worldMapTerritoryPanel.ui.ts).
    const { ctx } = openConfirm();
    const texts = allTexts(ctx.modalLayer).map((x) => x.text);

    // Nothing from the panel body survives: not the title, not the tabs, not a row's buttons.
    expect(texts).not.toContain(t('world.territoryTitle'));
    expect(texts).not.toContain(t('world.territoryTabList'));
    expect(texts).not.toContain(t('world.territoryJump'));
    expect(texts).not.toContain(t('world.actAbandon'));
    // Only the dialog's own two buttons are live.
    expect(ctx.modalBtnRects).toHaveLength(2);
    expect(texts).toContain(t('common.ok'));
    expect(texts).toContain(t('common.cancel'));
  });
});

describe('beginScrollList routes its viewport through peekViewportH', () => {
  function core() {
    const { ctx } = buildHarness();
    return { ctx, c: new WorldMapPanelsCore(ctx) };
  }

  it('backs a razor-flush viewport off a row so part of the next one shows', () => {
    // availH an exact multiple of the row pitch: without peekViewportH the mask lands dead on a row
    // boundary and the list reads as "that is all of it". (peekViewportH's own arithmetic is covered
    // by test/scrollPeek.test.ts — what this pins is that it is in the path at all.)
    const { ctx, c } = core();
    const unit = 64;
    const availH = unit * 10;
    c.beginScrollList(0, 100, 500, availH, unit * 30, () => {}, unit);

    expect(ctx.infoScrollRect!.h).toBeLessThan(availH);
    // Everything stays reachable: the height the mask gave up is added to the scrollable range.
    expect(ctx.infoMaxScroll).toBe(unit * 30 - ctx.infoScrollRect!.h);
  });

  it('leaves the viewport alone when the content already fits', () => {
    const { ctx, c } = core();
    c.beginScrollList(0, 100, 500, 640, 300, () => {}, 64);
    expect(ctx.infoScrollRect!.h).toBe(640);
    expect(ctx.infoMaxScroll).toBe(0);
  });

  it('is inert for a caller that passes no pitch, so opting in stays explicit', () => {
    const { ctx, c } = core();
    c.beginScrollList(0, 100, 500, 640, 2000, () => {});
    expect(ctx.infoScrollRect!.h).toBe(640);
  });
});

// ── Every scroll region opts in, not just the ones that existed on 2026-08-30 ──────────────────
//
// The unit tests above prove peekViewportH is reachable through beginScrollList. They cannot prove
// the panels actually reach it: `unit` defaults to 0 (inert) so a call site that omits it compiles,
// runs, scrolls, and renders — it just silently loses the affordance. Verified: dropping the pitch
// at the territory-list call site leaves the entire 2330-case suite green.
//
// That is precisely how the game ended up with 21 list pages on scrollPeek and these four without
// it for months. A source scan is the only thing that catches the NEXT panel to forget.
describe('every beginScrollList call site passes a row pitch', () => {
  const SRC = path.resolve(__dirname, '../../src');

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  /** Top-level argument count of the call whose '(' is at `open`. Depth-counts brackets so the
   *  commas inside an inline arrow's own body/args are not miscounted. */
  function argCount(src: string, open: number): number {
    let depth = 0;
    let args = 1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return args;
      } else if (ch === ',' && depth === 1) args++;
    }
    throw new Error('unbalanced call starting at ' + String(open));
  }

  it('passes all 7 arguments everywhere it is called', () => {
    // `.beginScrollList(` — the leading dot is what separates a CALL from core.ts's own method
    // declaration, which this must not flag.
    const CALL = /\.beginScrollList\s*\(/g;
    const found: { file: string; args: number }[] = [];

    for (const file of tsFiles(SRC)) {
      // CRLF-normalised: this checkout writes CRLF, and offset maths over a
      // mixed-ending buffer is how source scans here have silently mis-sliced before.
      const src = fs.readFileSync(file, 'utf8').split(String.fromCharCode(13)).join('');
      for (const m of src.matchAll(CALL)) {
        const open = m.index! + m[0].length - 1;
        found.push({ file: path.relative(SRC, file), args: argCount(src, open) });
      }
    }

    // Guard the guard: a rename or a move that makes the scan match nothing must fail here rather
    // than pass vacuously. Four call sites today (shop grid, territory list, world-tab nations,
    // replays) — the floor only has to prove the scan still finds them.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.filter((f) => f.args !== 7)).toEqual([]);
  });
});
