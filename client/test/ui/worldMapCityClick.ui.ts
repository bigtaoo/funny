// Regression coverage for the ADR-074 P0 city-click branch in WorldMapInput.onTileClick.
//
// A wild city's whole footprint is `familyKeep` city ground: indivisible, siege-only, gated on sect
// membership (the siege itself is P1). Before ADR-074 there was NO `familyKeep` branch here at all — a
// city tile fell through to the neutral-tile fallthrough at the bottom of onTileClick and offered a plain
// 占领 / 移动到此 menu against the underlying resource tile's NPC garrison. That is exactly what the user
// reported on 2026-08-25: tapping inside a Lv.8 city's walls popped 「占领 / 墨水 · Lv.2 / 建议兵力 240」.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Harness mirrors
// worldMapTileResourceInfo.ui.ts.

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
const TX = 40, TY = 40; // far from the capital footprint

type Btn = { label: string; action: () => void };

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const showTeamPicker = vi.fn(async () => {});
  const showDeployDialog = vi.fn();

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, troops: 2000 } as PlayerWorldView,
    selectedTile: null,
    stationed: [],
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID },
    panels: { showModal, showToast, closeModal: vi.fn(), showDeployDialog },
    net: { showTeamPicker, doRecallStationed: vi.fn(), doInPlaceOccupy: vi.fn() },
  } as unknown as WorldMapContext;

  return { ctx, input: new WorldMapInput(ctx), showModal, showToast, showTeamPicker, showDeployDialog };
}

/** Put a city-ground tile at (TX,TY) — what the server sends for any cell of a city footprint. */
function setCityTile(ctx: WorldMapContext, level: number): void {
  ctx.tileCache.set(`${TX}:${TY}`, { x: TX, y: TY, type: 'familyKeep', level } as WorldTileView);
}

describe('WorldMapInput.onTileClick — wild city ground (ADR-074 P0)', () => {
  it('shows the city modal, not the neutral occupy menu', () => {
    const h = buildHarness();
    setCityTile(h.ctx, 8);
    h.input.onTileClick(TX, TY);

    expect(h.showModal).toHaveBeenCalledTimes(1);
    const [lines] = h.showModal.mock.calls[0] as [string[], Btn[]];
    expect(lines[0]).toBe(t('world.city'));
    expect(lines).toContain(t('world.cityHint'));
    expect(lines).toContain(t('world.cityLevel').replace('{lv}', '8'));
    expect(lines).toContain(`(${TX}, ${TY})`);
  });

  it('offers no march action at all — only dismiss', () => {
    const h = buildHarness();
    setCityTile(h.ctx, 5);
    h.input.onTileClick(TX, TY);

    const [, buttons] = h.showModal.mock.calls[0] as [string[], Btn[]];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.label).toBe('✕');
    // The three routes the neutral branch would have offered are the ones the server now rejects.
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actOccupy'));
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actSweep'));
    expect(buttons.map((b) => b.label)).not.toContain(t('world.actMove'));
  });

  it('never reaches the deploy dialog or team picker for a city tile', () => {
    const h = buildHarness();
    setCityTile(h.ctx, 10);
    h.input.onTileClick(TX, TY);
    const [, buttons] = h.showModal.mock.calls[0] as [string[], Btn[]];
    for (const b of buttons) b.action();
    expect(h.showTeamPicker).not.toHaveBeenCalled();
    expect(h.showDeployDialog).not.toHaveBeenCalled();
  });

  it('shows no 建议兵力 / resource line — a city plot has no farmable garrison or yield', () => {
    // The reported screenshot's giveaway was exactly these two lines: the city's cell was being described
    // as a level-2 ink tile with a 240-troop recommendation.
    const h = buildHarness();
    setCityTile(h.ctx, 8);
    h.input.onTileClick(TX, TY);
    const [lines] = h.showModal.mock.calls[0] as [string[], Btn[]];
    for (const line of lines) {
      expect(line).not.toContain(t('world.recommendTroops').replace('{n}', ''));
      expect(line).not.toBe(t('world.actOccupy'));
    }
  });

  it('still shows the world-center toast for center ground (unchanged neighbour branch)', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { x: TX, y: TY, type: 'center', level: 10 } as WorldTileView);
    h.input.onTileClick(TX, TY);
    expect(h.showToast).toHaveBeenCalledWith(t('world.center'));
    expect(h.showModal).not.toHaveBeenCalled();
  });

  it('omits the level line when the server sent no level', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${TX}:${TY}`, { x: TX, y: TY, type: 'familyKeep' } as WorldTileView);
    h.input.onTileClick(TX, TY);
    const [lines] = h.showModal.mock.calls[0] as [string[], Btn[]];
    expect(lines).toEqual([t('world.city'), `(${TX}, ${TY})`, t('world.cityHint')]);
  });
});
