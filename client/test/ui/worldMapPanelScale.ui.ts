// Layout contract for the world-map modal panels (UI_DESIGN_LOG_2026-08.md §41).
//
// What this guards, and why it is a sweep rather than per-panel assertions: the 2026-08-30 audit
// found the shop / territory / replay panels had never been through any of the enlargement passes
// their peer components had (confirmDialog 1.5x, showModal 1.5x, the HUD chips 2x,
// SceneHeader.backSize 1.5x). Nothing caught that for months, because every existing test on these
// panels asserts *behaviour* — which item icon, which gate, which callback — and a panel drawn at
// half the size behaves identically. The regression was invisible to the suite and visible only to
// a person looking at a screenshot.
//
// So these tests assert the properties a person would have noticed, over every panel and tab at
// once: nothing is drawn at a font below the shared scale's floor, every tappable rect is big
// enough to hit, button labels are button-sized, and nothing pokes out the side of its panel. Each
// case below fails against the pre-2026-08-30 code (titles were FS.tiny, buttons 22-28px tall with
// FS.micro labels), and a new panel that forgets to import ./spec fails them too.
//
// Deliberately NOT asserted: exact pixel positions. Those are the numbers that get re-tuned; the
// contract is "on the shared scale", not "at these coordinates".
//
// The floors below are LITERALS and `FS` tokens, deliberately not spec.ts's own constants: a test
// that asserts `rect.h >= PANEL_ROW_BTN_H` passes no matter what PANEL_ROW_BTN_H is set to, which
// is exactly the drift this file exists to catch. Only the width-tier cases read spec, and what
// they pin there is the *mapping* (shop→md, territory→lg, replay→sm), not the tier values.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { PANEL_W, PANEL_MARGIN, PANEL_PAD } from '../../src/scenes/worldmap/WorldMapPanels/spec';
import { FS } from '../../src/render/fontScale';
import { ui as C } from '../../src/render/sketchUi';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type {
  SlgShopItemView,
  SiegeSummaryView,
  WorldTileView,
  NationView,
} from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Portrait design space (what ctx.w/h actually hold — layout.designWidth/Height), the tighter of
// the two orientations and therefore the one where a too-wide panel tier would show up first.
const [W, H] = [1080, 1920];

/**
 * Minimum height for anything tappable, in design px. UI_DESIGN.md §1 asks for ~80; the shared
 * confirm dialog has shipped 42-high OK/Cancel buttons since its own 1.5x pass, so 44 is the floor
 * these panels are actually held to — comfortably above the 22-28px controls this file was written
 * to prevent, and below the smallest control any conforming panel draws.
 */
const MIN_TAP_H = 44;

/** Left edge + width of a panel drawn at `tier`, mirroring what every renderXPanel computes. */
function panelBounds(tier: number): { px: number; pw: number } {
  const pw = Math.min(tier, W - PANEL_MARGIN * 2);
  return { px: (W - pw) / 2, pw };
}

const SHOP_ITEMS = [
  { id: 'sp1', kind: 'troop_speedup', cost: 200, effect: { duration_sec: 3600 } },
  { id: 'sp2', kind: 'troop_speedup', cost: 1400, effect: { duration_sec: 28800 } },
  { id: 'rp1', kind: 'resource_pack', cost: 300, effect: { each: 20000 } },
  { id: 'pr1', kind: 'protection', cost: 500, effect: { duration_sec: 28800 } },
  { id: 'bp1', kind: 'battle_pass', cost: 9800, effect: {} },
] as unknown as SlgShopItemView[];

const TERRITORIES = [
  { x: 1, y: 1, type: 'territory', level: 1, garrison: 5 },
  { x: 2, y: 2, type: 'territory', level: 1, garrison: 7 },
  { x: 3, y: 3, type: 'territory', level: 2, garrison: 9 },
] as unknown as WorldTileView[];

const NATIONS = Array.from({ length: 4 }, (_, i) => ({
  capitalIdx: i,
  x: 10 + i,
  y: 20 + i,
  nationName: i === 0 ? 'Mine' : '',
  // capital #0 is ours, so the in-row Rename button (the smallest control in these panels) is drawn.
  ownerId: i === 0 ? 'me' : i === 1 ? 'someone' : undefined,
})) as unknown as NationView[];

const SIEGES = [
  { siegeId: 's1', tile: 'w1:34:293', tileLevel: 2, outcome: 'attacker_win', role: 'attacker', ts: 1000, hasReplay: true },
  { siegeId: 's2', tile: 'w1:34:292', tileLevel: 2, outcome: 'defender_win', role: 'attacker', ts: 900, hasReplay: false },
] as unknown as SiegeSummaryView[];

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
    infoScrollDragging: false,
    infoScrollDragMoved: false,
    infoScrollDragStartY: 0,
    infoScrollDragStartScroll: 0,
    shopPanelOpen: false,
    shopItems: [],
    replayPanelOpen: false,
    sieges: [],
    territoryPanelOpen: false,
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
      getCoins: () => 95595208,
      worldId: 'w1',
      onReplaySiege: vi.fn(),
      worldApi: { getShopItems: vi.fn(async () => []), listSieges: vi.fn(async () => []), getNations: vi.fn(async () => []) },
    },
    view: { renderMap: vi.fn(), centerAt: vi.fn() },
    net: { refreshTerritories: vi.fn(async () => {}), doAbandonFromList: vi.fn(async () => {}), doBuyShopItem: vi.fn() },
    ...overrides,
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  return { ctx, panels };
}

/** Every PIXI.Text drawn anywhere under the modal layer, including inside masked scroll lists. */
function allTexts(ctx: WorldMapContext): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children as PIXI.DisplayObject[]) {
      if (child instanceof PIXI.Text) out.push(child);
      else if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(ctx.modalLayer);
  return out;
}

const fontOf = (txt: PIXI.Text): number => txt.style.fontSize as number;

/** PIXI normalises a numeric `fill` to a '#rrggbb' string on the way into the style object. */
const fillOf = (txt: PIXI.Text): number => {
  const fill = txt.style.fill as number | string;
  return typeof fill === 'string' ? parseInt(fill.replace('#', ''), 16) : fill;
};

/** The label a tappable rect carries, found by geometry (rects and texts share one coordinate frame). */
function labelIn(texts: PIXI.Text[], r: { x: number; y: number; w: number; h: number }): PIXI.Text | undefined {
  return texts.find((t) => {
    const b = t.getBounds();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  });
}

/** Renders one panel/tab and returns what the sweep needs from it. */
const CASES: { name: string; tier: number; render: () => { ctx: WorldMapContext } }[] = [
  {
    name: 'shop',
    tier: PANEL_W.md,
    render: () => {
      const { ctx, panels } = buildHarness({ shopPanelOpen: true, shopItems: SHOP_ITEMS });
      panels.renderShopPanel();
      return { ctx };
    },
  },
  {
    name: 'territory · overview',
    tier: PANEL_W.lg,
    render: () => {
      const { ctx, panels } = buildHarness({ territoryPanelOpen: true, territoryTab: 'overview' });
      panels.renderTerritoryPanel();
      return { ctx };
    },
  },
  {
    name: 'territory · list',
    tier: PANEL_W.lg,
    render: () => {
      const { ctx, panels } = buildHarness({ territoryPanelOpen: true, territoryTab: 'list', territories: TERRITORIES });
      panels.renderTerritoryPanel();
      return { ctx };
    },
  },
  {
    name: 'territory · world',
    tier: PANEL_W.lg,
    render: () => {
      const { ctx, panels } = buildHarness({ territoryPanelOpen: true, territoryTab: 'world', nations: NATIONS });
      panels.renderTerritoryPanel();
      return { ctx };
    },
  },
  {
    name: 'replay',
    tier: PANEL_W.sm,
    render: () => {
      const { ctx, panels } = buildHarness({ replayPanelOpen: true, sieges: SIEGES });
      panels.renderReplayPanel();
      return { ctx };
    },
  },
  {
    name: 'tile-action modal',
    tier: PANEL_W.md,
    render: () => {
      const { ctx, panels } = buildHarness();
      panels.showModal(
        ['Wild city', '(34, 293)', 'Durability 26000 / 26000'],
        [{ label: 'Siege', action: vi.fn() }, { label: 'Close', action: vi.fn() }]
      );
      return { ctx };
    },
  },
];

describe('world-map panels — shared layout scale (spec.ts)', () => {
  // FS.tiny is the scale's floor for secondary metadata (yield rates, the season footer). Anything
  // at FS.micro in a panel is the pre-2026-08-30 sizing: it was the font for whole list rows,
  // status columns and button labels, not for fine print.
  it.each(CASES)('$name draws no text below FS.tiny', ({ render }) => {
    const { ctx } = render();
    const texts = allTexts(ctx);
    expect(texts.length).toBeGreaterThan(0);
    const tooSmall = texts.filter((t) => fontOf(t) < FS.tiny).map((t) => `${t.text}@${fontOf(t)}`);
    expect(tooSmall).toEqual([]);
  });

  // The touch-target rule (UI_DESIGN.md §1). Row-action buttons are the smallest controls these
  // panels draw; MIN_TAP_H is the floor every tappable rect has to clear (see its doc for the value).
  it.each(CASES)('$name gives every tappable rect at least MIN_TAP_H of height', ({ render }) => {
    const { ctx } = render();
    expect(ctx.modalBtnRects.length).toBeGreaterThan(0);
    const tooShort = ctx.modalBtnRects
      .filter((b) => b.rect.h < MIN_TAP_H)
      .map((b) => `${b.rect.w}x${b.rect.h}@${b.rect.x},${b.rect.y}`);
    expect(tooShort).toEqual([]);
  });

  it.each(CASES)('$name labels its buttons at button size (>= FS.body)', ({ render }) => {
    const { ctx } = render();
    const texts = allTexts(ctx);
    const undersized = ctx.modalBtnRects
      .map((b) => labelIn(texts, b.rect))
      .filter((t): t is PIXI.Text => !!t && fontOf(t) < FS.body)
      .map((t) => `${t.text}@${fontOf(t)}`);
    expect(undersized).toEqual([]);
  });

  // Guards the width grid from the other side: a panel that grew onto a wider tier without its
  // content following (or vice versa) shows up here as a control hanging over the paper edge.
  it.each(CASES)('$name keeps every tappable rect inside the panel', ({ tier, render }) => {
    const { ctx } = render();
    const { px, pw } = panelBounds(tier);
    const outside = ctx.modalBtnRects
      .filter((b) => b.rect.x < px || b.rect.x + b.rect.w > px + pw)
      .map((b) => `${b.rect.x}..${b.rect.x + b.rect.w} vs ${px}..${px + pw}`);
    expect(outside).toEqual([]);
  });
});

describe('world-map panels — shared heading', () => {
  // The three standalone panels used to draw their own FS.tiny accent-blue title, which is the
  // single biggest reason they read as a different visual family from the scenes behind them.
  // drawPanelTitle() gives them SceneHeader's paper-variant treatment: dark ink, accent only as
  // the rule underneath.
  // Titles come from t() rather than literals: 'Territory' alone also happens to be the Overview
  // tab's troops/territory stat-card label, so a literal silently matched that FS.body chip instead
  // of the heading.
  const TITLED: { name: string; title: string; render: () => WorldMapContext }[] = [
    { name: 'shop', title: t('world.shopTitle'), render: () => { const { ctx, panels } = buildHarness({ shopPanelOpen: true, shopItems: SHOP_ITEMS }); panels.renderShopPanel(); return ctx; } },
    { name: 'territory', title: t('world.territoryTitle'), render: () => { const { ctx, panels } = buildHarness({ territoryPanelOpen: true }); panels.renderTerritoryPanel(); return ctx; } },
    { name: 'replay', title: t('world.replaysTitle'), render: () => { const { ctx, panels } = buildHarness({ replayPanelOpen: true, sieges: SIEGES }); panels.renderReplayPanel(); return ctx; } },
  ];

  it.each(TITLED)('$name draws its heading at heading size in dark ink', ({ title, render }) => {
    const ctx = render();
    const heading = allTexts(ctx).find((t) => t.text === title);
    expect(heading, `no "${title}" heading drawn`).toBeTruthy();
    expect(fontOf(heading!)).toBeGreaterThanOrEqual(FS.heading);
    expect(fillOf(heading!)).toBe(C.dark);
  });
});

describe('world-map panels — width grid', () => {
  // Each panel's scroll viewport is derived straight from its panel width, so pinning it pins the
  // tier without reaching into the sketchPanel container to measure paper.
  it('the shop grid spans its md-tier panel minus the shared padding', () => {
    const { ctx, panels } = buildHarness({ shopPanelOpen: true, shopItems: SHOP_ITEMS });
    panels.renderShopPanel();
    const { pw } = panelBounds(PANEL_W.md);
    expect(ctx.infoScrollRect?.w).toBe(pw - PANEL_PAD * 2);
  });

  it('the territory list spans its lg-tier panel', () => {
    const { ctx, panels } = buildHarness({ territoryPanelOpen: true, territoryTab: 'list', territories: TERRITORIES });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect?.w).toBe(panelBounds(PANEL_W.lg).pw);
  });

  it('the replay list spans its sm-tier panel', () => {
    const { ctx, panels } = buildHarness({ replayPanelOpen: true, sieges: SIEGES });
    panels.renderReplayPanel();
    expect(ctx.infoScrollRect?.w).toBe(panelBounds(PANEL_W.sm).pw);
  });
});
