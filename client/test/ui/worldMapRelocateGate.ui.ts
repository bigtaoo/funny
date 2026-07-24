// Regression coverage for the §3.4 (2026-07-14) "relocate only onto an already fully-owned 3×3" gate in
// WorldMapInput.onTileClick's owned-tile branch.
//
// Rule: the capital may be relocated only onto a 3×3 block the player ALREADY fully owns, initiated by
// clicking the centre cell. On any owned (non-base) tile the "Relocate here" button is offered; it is
// enabled only when the clicked cell plus all 8 neighbours are cached as `mine`, otherwise it is greyed out
// and tapping it surfaces the "occupy the surrounding tiles first" toast (world.err.relocateNeedSurround).
// Mirrors the Occupy-connectivity gate pattern in worldMapOccupyConnectivity.ui.ts.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

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
const ANCHOR = { x: 20, y: 20 }; // capital footprint = x19..21, y19..21
const FAR = { x: 100, y: 100 };  // an owned tile well away from the base footprint

type Btn = { label: string; action: () => void; disabled?: boolean };

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return {
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    troops: 2000,
    ...overrides,
  } as PlayerWorldView;
}

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const confirmRelocate = vi.fn();

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: makeMe(),
    selectedTile: null,
    stationed: [],
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID, onOpenDefense: vi.fn() },
    panels: { showModal, showToast, showDeployDialog: vi.fn(), closeModal: vi.fn() },
    net: { doScout: vi.fn(), confirmRelocate, confirmWatchtower: vi.fn(), doAbandon: vi.fn() },
  } as unknown as WorldMapContext;

  return { ctx, input: new WorldMapInput(ctx), showModal, showToast, confirmRelocate };
}

/** Mark a set of cells as owned (mine) in the cache. */
function ownCells(ctx: WorldMapContext, cells: Array<[number, number]>) {
  for (const [x, y] of cells) ctx.tileCache.set(`${x}:${y}`, { occupied: true, mine: true } as WorldTileView);
}

/** The full 3×3 footprint anchored at (cx,cy). */
function block(cx: number, cy: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push([cx + dx, cy + dy]);
  return out;
}

/** Click an owned tile and return its Relocate button from the shown menu. */
function relocateBtnAt(ctx: WorldMapContext, input: WorldMapInput, showModal: ReturnType<typeof vi.fn>, x: number, y: number) {
  input.onTileClick(x, y);
  expect(showModal).toHaveBeenCalledTimes(1);
  const buttons = showModal.mock.calls[0][1] as Btn[];
  const relocate = buttons.find((b) => b.label === t('world.actRelocate'));
  expect(relocate).toBeTruthy();
  return relocate!;
}

describe('WorldMapInput relocate gate (§3.4, 2026-07-14)', () => {
  it('enables Relocate when the clicked owned tile and all 8 neighbours are mine', () => {
    const h = buildHarness();
    ownCells(h.ctx, block(FAR.x, FAR.y));
    const relocate = relocateBtnAt(h.ctx, h.input, h.showModal, FAR.x, FAR.y);
    expect(relocate.disabled).toBeFalsy();
  });

  it('tapping the enabled Relocate opens the confirm modal (net.confirmRelocate)', () => {
    const h = buildHarness();
    ownCells(h.ctx, block(FAR.x, FAR.y));
    const relocate = relocateBtnAt(h.ctx, h.input, h.showModal, FAR.x, FAR.y);
    relocate.action();
    expect(h.confirmRelocate).toHaveBeenCalledWith(FAR.x, FAR.y);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('greys out Relocate when the surrounding ring is not fully owned (only the centre is mine)', () => {
    const h = buildHarness();
    ownCells(h.ctx, [[FAR.x, FAR.y]]); // centre only
    const relocate = relocateBtnAt(h.ctx, h.input, h.showModal, FAR.x, FAR.y);
    expect(relocate.disabled).toBe(true);
  });

  it('greys out Relocate when even one neighbour is missing from the owned ring', () => {
    const h = buildHarness();
    const cells = block(FAR.x, FAR.y).filter(([x, y]) => !(x === FAR.x + 1 && y === FAR.y + 1)); // drop one corner
    ownCells(h.ctx, cells);
    const relocate = relocateBtnAt(h.ctx, h.input, h.showModal, FAR.x, FAR.y);
    expect(relocate.disabled).toBe(true);
  });

  it('tapping the disabled Relocate surfaces the "occupy surrounding tiles first" toast, not the confirm modal', () => {
    const h = buildHarness();
    ownCells(h.ctx, [[FAR.x, FAR.y]]);
    const relocate = relocateBtnAt(h.ctx, h.input, h.showModal, FAR.x, FAR.y);
    relocate.action();
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast.mock.calls[0][0]).toBe(t('world.err.relocateNeedSurround'));
    expect(h.confirmRelocate).not.toHaveBeenCalled();
  });
});
