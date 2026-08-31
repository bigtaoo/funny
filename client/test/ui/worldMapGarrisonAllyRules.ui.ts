// Regression coverage for the 驻守 (garrison) targeting rule (2026-08-02, user-reported): a team may only be
// sent to Garrison (驻扎) on the player's OWN territory or an ALLY's territory (family §8.2 / allied sect) —
// never neutral or enemy land. Before this fix, WorldMapInput.onTileClick's neutral-tile branch offered
// "Move & garrison" unconditionally, and ally-owned tiles had no dedicated branch at all (they fell through
// to the generic "enemy tile" menu, offering an Attack that always fails server-side with ALLY_TILE).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Mirrors worldMapBaseClick.ui.ts's
// hand-rolled WorldMapContext harness pattern.

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView, StationedView } from '../../src/net/WorldApiClient';

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
const ANCHOR = { x: 20, y: 20 }; // capital footprint = x19..21, y19..21 — far from every tile under test below.

type Btn = { label: string; action: () => void };

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, troops: 2000, ...overrides } as PlayerWorldView;
}

function buildHarness() {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const showDeployDialog = vi.fn();
  const showTeamPicker = vi.fn(async () => {});
  const doRecallStationed = vi.fn(async () => ({}) as never);

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: makeMe(),
    selectedTile: null,
    stationed: [] as StationedView[],
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID },
    panels: { showModal, showToast, showDeployDialog, closeModal: vi.fn() },
    net: { doScout: vi.fn(), showTeamPicker, doRecallStationed, doInPlaceOccupy: vi.fn() },
  } as unknown as WorldMapContext;

  const input = new WorldMapInput(ctx);
  return { ctx, input, showModal, showToast, showTeamPicker, doRecallStationed };
}

const FAR = { x: 100, y: 100 }; // any tile well outside ANCHOR's footprint/connectivity

describe('WorldMapInput garrison targeting rule (own + ally only, 2026-08-02)', () => {
  it('a neutral tile offers Move but never Garrison', () => {
    const h = buildHarness();
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    expect(labels).toContain(t('world.actMove'));
    expect(labels).not.toContain(t('world.actGarrison'));
  });

  it('an enemy tile offers neither Move nor Garrison (only Attack)', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, ownerName: 'Rival' } as WorldTileView);
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    expect(labels).toEqual([t('world.actAttack'), t('common.close')]);
  });

  it('a family-ally tile (tile.ally) offers Garrison, not Attack or Move, and never routes through the enemy branch', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, ally: true, ownerName: 'Ally' } as WorldTileView);
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    expect(labels).toEqual([t('world.actGarrison'), t('common.close')]);
    const headLines = h.showModal.mock.calls[0][0] as string[];
    expect(headLines[0]).toBe(t('world.allyTile'));
    expect(headLines).toContain('Ally');
  });

  it('an allied-sect tile (tile.allySect) also offers Garrison, not Attack', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, allySect: true, ownerName: 'SectMate' } as WorldTileView);
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    expect(labels).toEqual([t('world.actGarrison'), t('common.close')]);
  });

  it('a sect-mate tile (tile.sectmate, own sect different family — 2026-08-08 ADR-060) also offers Garrison, never Attack', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, sectmate: true, ownerName: 'SiblingFam' } as WorldTileView);
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    // Before this branch included `sectmate`, this tile fell through to the generic enemy branch and
    // offered Attack — which the server's friendlyAccountIds would reject with ALLY_TILE.
    expect(labels).toEqual([t('world.actGarrison'), t('common.close')]);
    expect(labels).not.toContain(t('world.actAttack'));
  });

  it('tapping Garrison on an ally tile dispatches move with garrison intent', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, ally: true } as WorldTileView);
    h.input.onTileClick(FAR.x, FAR.y);
    const garrisonBtn = (h.showModal.mock.calls[0][1] as Btn[]).find((b) => b.label === t('world.actGarrison'))!;
    garrisonBtn.action();
    expect(h.showTeamPicker).toHaveBeenCalledWith(FAR.x, FAR.y, 'move', 'garrison');
  });

  it('an ally tile where I already have a team garrisoned offers Recall instead of Garrison', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${FAR.x}:${FAR.y}`, { occupied: true, ally: true } as WorldTileView);
    h.ctx.stationed.push({
      tile: `${WORLD_ID}:${FAR.x}:${FAR.y}`,
      x: FAR.x,
      y: FAR.y,
      teamId: 't3',
      troops: 100,
      sinceAt: 0,
      mine: true,
      mode: 'garrison',
    } as StationedView);
    h.input.onTileClick(FAR.x, FAR.y);
    const labels = (h.showModal.mock.calls[0][1] as Btn[]).map((b) => b.label);
    expect(labels).toEqual([t('world.actRecallStation'), t('common.close')]);
    const recallBtn = (h.showModal.mock.calls[0][1] as Btn[]).find((b) => b.label === t('world.actRecallStation'))!;
    recallBtn.action();
    expect(h.doRecallStationed).toHaveBeenCalledWith('t3');
  });
});
