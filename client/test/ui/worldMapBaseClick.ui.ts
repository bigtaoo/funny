// Regression coverage for WorldMapInput.onTileClick's "is this the main city?" check.
//
// The base is an indivisible 3×3 block anchored (centered) on playerWorld.mainBaseTile
// (ADR-025 — "nine cells, one entity"), but the click handler used to compare the clicked
// tile against the anchor coordinate only (`bx === tx && by === ty`). Clicking any of the
// other 8 cells that visually belong to the same city fell through to the generic
// "my tile" menu (reinforce/defense/watchtower/abandon) instead of entering the city.
//
// Fix: treat any cell inside baseFootprintCells(anchor) as "the city".
//
// 2026-07-18: the main-city tap no longer opens a menu at all — it goes straight into the
// desk (city) scene (no Enter City / Train / Defense / Manage team popup). Base defense is
// not a manual setting; teams left in the city auto-defend (ADR-026 §2) and teams out on a
// march simply leave it undefended, so there is no "Defense" concept at the base tile anymore.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Uses a minimal
// hand-rolled WorldMapContext (mirrors worldMapInfoScroll.ui.ts's harness pattern) with
// panels/cb/net replaced by spies — onTileClick only calls through their public methods.

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const WORLD_ID = 'world:1:0';
const ANCHOR = { x: 20, y: 20 };

const MINE_TILE_MENU_LABELS = [t('world.actReinforce'), t('world.actDefense'), t('world.actWatchtower'), t('world.actRelocate'), t('world.actAbandon'), '✕'];
// Relocate is only offered when the player already has a main base (me.mainBaseTile set).
const MINE_TILE_MENU_LABELS_NO_BASE = [t('world.actReinforce'), t('world.actDefense'), t('world.actWatchtower'), t('world.actAbandon'), '✕'];

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return {
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    troops: 2000,
    ...overrides,
  } as PlayerWorldView;
}

/** Builds a fake ctx + a real WorldMapInput wired against it. Only the fields onTileClick's
 *  branches actually touch are populated; panels/cb/net are spies so we can assert which
 *  menu (city vs. generic-mine-tile) a click routed to, without rendering PIXI panels. */
function buildHarness(opts: { me?: PlayerWorldView; mapW?: number; mapH?: number } = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const openTrainPanel = vi.fn();
  const showDeployDialog = vi.fn();

  const ctx = {
    mapW: opts.mapW ?? 500,
    mapH: opts.mapH ?? 500,
    tileCache: new Map<string, WorldTileView>(),
    me: opts.me ?? makeMe(),
    selectedTile: null,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: {
      worldId: WORLD_ID,
      onOpenCity: vi.fn(),
      onOpenDefense: vi.fn(),
      onOpenTeams: vi.fn(),
    },
    panels: { showModal, showToast, closeModal, openTrainPanel, showDeployDialog },
    net: { doJoin: vi.fn(), doAbandon: vi.fn(), confirmWatchtower: vi.fn(), doScout: vi.fn(), showTeamPicker: vi.fn() },
  } as unknown as WorldMapContext;

  // Mark every tile in the 3×3 base footprint as mine (matches server: all 9 cells share ownerId).
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.tileCache.set(`${ANCHOR.x + dx}:${ANCHOR.y + dy}`, { mine: true } as WorldTileView);
    }
  }

  const input = new WorldMapInput(ctx);
  return { ctx, input, showModal, closeModal, openTrainPanel };
}

describe('WorldMapInput.onTileClick — main city hit area (ADR-025 3×3 footprint)', () => {
  it('clicking the exact anchor tile enters the city directly (no menu)', () => {
    const { ctx, input, showModal } = buildHarness();
    input.onTileClick(ANCHOR.x, ANCHOR.y);
    expect(showModal).not.toHaveBeenCalled();
    expect(ctx.cb.onOpenCity).toHaveBeenCalledTimes(1);
  });

  it('clicking any other cell of the same 3×3 footprint also enters the city directly (regression)', () => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue; // anchor itself, covered above
        const { ctx, input, showModal } = buildHarness();
        input.onTileClick(ANCHOR.x + dx, ANCHOR.y + dy);
        // Regression: before the footprint-aware fix, all 8 non-anchor cells fell through to
        // MINE_TILE_MENU_LABELS (reinforce/defense/watchtower/abandon) instead of entering the city.
        expect(showModal).not.toHaveBeenCalled();
        expect(ctx.cb.onOpenCity).toHaveBeenCalledTimes(1);
      }
    }
  });

  it('never routes the base tap through Defense/Teams/Train — main-city defense has no manual UI (ADR-041/ADR-026)', () => {
    const { ctx, input, openTrainPanel } = buildHarness();
    input.onTileClick(ANCHOR.x, ANCHOR.y);
    expect(ctx.cb.onOpenDefense).not.toHaveBeenCalled();
    expect(ctx.cb.onOpenTeams).not.toHaveBeenCalled();
    expect(openTrainPanel).not.toHaveBeenCalled();
  });

  it('clicking a tile outside the base footprint (but still mine) falls through to the generic mine-tile menu', () => {
    const { ctx, input, showModal } = buildHarness();
    ctx.tileCache.set(`${ANCHOR.x + 5}:${ANCHOR.y + 5}`, { mine: true } as WorldTileView);
    input.onTileClick(ANCHOR.x + 5, ANCHOR.y + 5);
    expect(showModal).toHaveBeenCalledTimes(1);
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    expect(buttons.map((b) => b.label)).toEqual(MINE_TILE_MENU_LABELS);
  });

  it('has no main base yet (mainBaseTile unset) — a mine tile never matches isBase', () => {
    const { ctx, input, showModal } = buildHarness({ me: makeMe({ mainBaseTile: undefined }) });
    ctx.tileCache.set('7:7', { mine: true } as WorldTileView);
    input.onTileClick(7, 7);
    expect(showModal).toHaveBeenCalledTimes(1);
    const buttons = showModal.mock.calls[0][1] as { label: string; action: () => void }[];
    expect(buttons.map((b) => b.label)).toEqual(MINE_TILE_MENU_LABELS_NO_BASE);
  });
});
