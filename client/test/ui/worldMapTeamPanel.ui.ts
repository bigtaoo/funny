// The world-map team panel (2026-08-30, replaces the march list) — the render→hit-test wiring.
//
// The row DERIVATION is covered as pure logic in test/worldMapTeamStatus.test.ts; what can only be
// checked here is that renderHud actually emits one hit rect per row with the right jump target and
// the right action button, and that WorldMapInput routes a tap on each to the right call. The two
// halves of the feature the user asked for meet exactly at that seam: "点击队伍后直接跳转到队伍所在
// 位置，队伍在家时直接跳转到基地".
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { MarchView, StationedView, TeamTemplate } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 600];
const TOP_INSET = 86;
const WORLD_ID = 'w1';
const BASE = { x: 30, y: 40 };

function zeroRect(): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: 0, h: 0 };
}

const parseTileId = (id: string): [number, number] => {
  const p = id.split(':');
  return [Number(p[p.length - 2]), Number(p[p.length - 1])];
};

function tmpl(id: string): TeamTemplate {
  return { id, name: '', army: [{ cardInstanceId: `card-${id}` }] } as TeamTemplate;
}

function buildHudHarness(opts: {
  teams?: TeamTemplate[];
  marches?: MarchView[];
  stationed?: StationedView[];
  expanded?: boolean;
  teamsLoaded?: boolean;
}) {
  const cardState: Record<string, { currentTroops: number }> = {};
  for (const t of opts.teams ?? []) cardState[`card-${t.id}`] = { currentTroops: 500 };
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: {
      joined: true, mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`,
      troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate: {}, cardState,
    },
    marches: opts.marches ?? [],
    occupations: [],
    stationed: opts.stationed ?? [],
    teams: opts.teams ?? [],
    teamsLoaded: opts.teamsLoaded ?? true,
    teamPanelExpanded: opts.expanded ?? true,
    parseTileId,
    cb: { accountId: 'me', getCoins: () => 0, worldId: WORLD_ID },
  } as unknown as WorldMapContext;
  return { ctx, panels: new WorldMapPanels(ctx) };
}

function buildInputHarness(ctx: WorldMapContext) {
  const centerAt = vi.fn();
  const doRecallStationed = vi.fn();
  const doRecall = vi.fn();
  Object.assign(ctx as unknown as Record<string, unknown>, {
    panX: 0, panY: 0, dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0,
    modalDimRect: null, modalBtnRects: [], infoScrollRect: null,
    zoomBtnRect: zeroRect(), aucBtnRect: zeroRect(), shopBtnRect: zeroRect(),
    homeBtnRect: zeroRect(), replayBadgeRect: zeroRect(), chatBarRect: zeroRect(),
    resClusterRect: zeroRect(), mapW: 500, mapH: 500,
    tileCache: new Map(), selectedTile: null,
    view: { renderMap: vi.fn(), screenToTile: () => ({ x: 0, y: 0 }), centerAt },
    net: { doRecallStationed, doRecall, refreshTeams: vi.fn().mockResolvedValue(undefined) },
    panels: { showModal: vi.fn(), closeModal: vi.fn(), renderHud: vi.fn() },
  });
  return { input: new WorldMapInput(ctx), centerAt, doRecallStationed, doRecall };
}

/** Every Text under a container, flattened — the badge label lives several children deep. */
function allTexts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const child of c.children) {
      if (child instanceof PIXI.Text) out.push(child);
      if (child instanceof PIXI.Container) walk(child);
    }
  };
  walk(root);
  return out;
}

describe('WorldMapPanels.renderHud — team panel rows', () => {
  it('emits one row per team, including the ones sitting at home', () => {
    // The whole point of the replacement: with no marches at all, the old list rendered nothing.
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1'), tmpl('t2'), tmpl('t3')] });
    panels.renderHud();
    expect(ctx.teamRowRects).toHaveLength(3);
  });

  it('a home team\'s row jumps to the main base, and a tap on it drives centerAt there', () => {
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1')] });
    panels.renderHud();
    const row = ctx.teamRowRects[0]!;
    expect([row.jumpX, row.jumpY]).toEqual([BASE.x, BASE.y]);

    const { input, centerAt } = buildInputHarness(ctx);
    input.handleDown(row.rowRect.x + 5, row.rowRect.y + 5);
    expect(centerAt).toHaveBeenCalledWith(BASE.x, BASE.y);
  });

  it('a marching team\'s row jumps to its destination', () => {
    const marches: MarchView[] = [{
      marchId: 'm1', kind: 'attack', fromTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`, toTile: `${WORLD_ID}:60:70`,
      troops: 500, departAt: 0, arriveAt: Number.MAX_SAFE_INTEGER, status: 'marching', mine: true, teamId: 't1',
    }];
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1')], marches });
    panels.renderHud();
    const row = ctx.teamRowRects[0]!;
    expect([row.jumpX, row.jumpY]).toEqual([60, 70]);
    expect(row.recallRect).not.toBeNull();

    const { input, centerAt } = buildInputHarness(ctx);
    input.handleDown(row.rowRect.x + 5, row.rowRect.y + 5);
    expect(centerAt).toHaveBeenCalledWith(60, 70);
  });

  it('a field-stationed team gets a recall button that dispatches doRecallStationed', () => {
    const stationed: StationedView[] = [
      { tile: `${WORLD_ID}:20:21`, x: 20, y: 21, teamId: 't1', troops: 500, sinceAt: 0, mode: 'garrison', mine: true },
    ];
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1')], stationed });
    panels.renderHud();
    const row = ctx.teamRowRects[0]!;
    expect(row.recallStationRect).not.toBeNull();
    expect(row.stationedTeamId).toBe('t1');

    const { input, doRecallStationed, centerAt } = buildInputHarness(ctx);
    const btn = row.recallStationRect!;
    input.handleDown(btn.x + btn.w / 2, btn.y + btn.h / 2);
    expect(doRecallStationed).toHaveBeenCalledWith('t1');
    expect(centerAt).not.toHaveBeenCalled(); // the button wins over the row's jump
  });

  it('the row\'s tap target stops short of its action button, so jump and recall never overlap', () => {
    const stationed: StationedView[] = [
      { tile: `${WORLD_ID}:20:21`, x: 20, y: 21, teamId: 't1', troops: 500, sinceAt: 0, mode: 'idle', mine: true },
    ];
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1')], stationed });
    panels.renderHud();
    const row = ctx.teamRowRects[0]!;
    expect(row.rowRect.x + row.rowRect.w).toBeLessThanOrEqual(row.recallStationRect!.x);
  });

  it('collapsed, the panel emits no rows but keeps its badge tappable', () => {
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1')], expanded: false });
    panels.renderHud();
    expect(ctx.teamRowRects).toHaveLength(0);
    expect(ctx.teamBadgeRect.w).toBeGreaterThan(0);
  });
});

describe('WorldMapPanels.renderHud — team badge label', () => {
  it('shows away/total once the teams fetch has landed', () => {
    const marches: MarchView[] = [{
      marchId: 'm1', kind: 'attack', fromTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`, toTile: `${WORLD_ID}:60:70`,
      troops: 500, departAt: 0, arriveAt: Number.MAX_SAFE_INTEGER, status: 'marching', mine: true, teamId: 't2',
    }];
    const { ctx, panels } = buildHudHarness({ teams: [tmpl('t1'), tmpl('t2')], marches, expanded: false });
    panels.renderHud();
    expect(allTexts(ctx.hudLayer).some((t) => t.text === 'Teams (1/2)')).toBe(true);
  });

  it('omits the count until the fetch lands — a marches-only count would understate the roster', () => {
    const { ctx, panels } = buildHudHarness({ teams: [], teamsLoaded: false, expanded: false });
    panels.renderHud();
    expect(allTexts(ctx.hudLayer).some((t) => t.text === 'Teams')).toBe(true);
  });
});
