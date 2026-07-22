// Regression coverage for the ADR-039 "连地" (territory-connectivity) occupy pre-filter in
// WorldMapInput.onTileClick's neutral-tile branch.
//
// Server-side, POST /world/march (kind:'occupy') is rejected with TERRITORY_NOT_CONNECTED unless the
// target 4-neighbours land the player's sect already holds (the player's own 3×3 capital footprint counts
// as guaranteed initial territory). The client used to always offer an enabled Occupy button, so a player
// tapping a tile that only *looks* adjacent to their base (isometric projection makes a 2-rows-away tile
// sit visually next to the city) got a click-then-reject error. The fix greys out Occupy up front.
//
// Scope guard: the pre-filter is applied only for SOLO players (no familyId). The server counts own family
// ∪ sibling families in the same sect, but the client only tags its own family's tiles (mine/ally); a
// sibling family's territory has no client flag, so for anyone in a family we cannot prove non-connection
// and must NOT pre-disable (server still validates). These tests pin both behaviours.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Minimal hand-rolled
// WorldMapContext, mirroring worldMapBaseClick.ui.ts's harness pattern.

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

type Btn = { label: string; action: () => void; disabled?: boolean };

function makeMe(overrides: Partial<PlayerWorldView> = {}): PlayerWorldView {
  return {
    joined: true,
    mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
    troops: 2000,
    ...overrides,
  } as PlayerWorldView;
}

function buildHarness(opts: { me?: PlayerWorldView } = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const showDeployDialog = vi.fn();
  // Occupy now routes through the team picker (§4.2), not the flat deploy dialog.
  const showTeamPicker = vi.fn(async () => {});

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(),
    me: opts.me ?? makeMe(),
    selectedTile: null,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: () => {} },
    cb: { worldId: WORLD_ID },
    panels: { showModal, showToast, showDeployDialog, closeModal: vi.fn() },
    net: { doScout: vi.fn(), confirmRelocate: vi.fn(), showTeamPicker },
  } as unknown as WorldMapContext;

  const input = new WorldMapInput(ctx);
  return { ctx, input, showModal, showToast, showDeployDialog, showTeamPicker };
}

/** Click a neutral tile and return its Occupy button from the shown menu. */
function occupyBtnFor(x: number, y: number, opts: { me?: PlayerWorldView } = {}) {
  const h = buildHarness(opts);
  h.input.onTileClick(x, y);
  expect(h.showModal).toHaveBeenCalledTimes(1);
  const buttons = h.showModal.mock.calls[0][1] as Btn[];
  const occupy = buttons.find((b) => b.label === t('world.actOccupy'));
  expect(occupy).toBeTruthy();
  return { ...h, occupy: occupy! };
}

describe('WorldMapInput occupy connectivity pre-filter (ADR-039)', () => {
  it('greys out Occupy on a tile not bordering own territory (the reported bug: 2 rows below the base)', () => {
    const { occupy } = occupyBtnFor(ANCHOR.x, ANCHOR.y + 3); // (20,23): nearest footprint cell y21 → 2 gap, not adjacent
    expect(occupy.disabled).toBe(true);
  });

  it('greys out Occupy on a diagonal-only-adjacent tile (4-neighbour rule, not 8)', () => {
    const { occupy } = occupyBtnFor(ANCHOR.x + 2, ANCHOR.y + 2); // (22,22): touches footprint only at the (21,21) corner
    expect(occupy.disabled).toBe(true);
  });

  it('tapping the disabled Occupy surfaces the "not connected" toast instead of opening the team picker', () => {
    const { occupy, showToast, showTeamPicker } = occupyBtnFor(ANCHOR.x, ANCHOR.y + 3);
    occupy.action();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][0]).toBe(t('world.err.notConnected'));
    expect(showTeamPicker).not.toHaveBeenCalled();
  });

  it('enables Occupy on a tile 4-adjacent to the capital footprint (initial territory, before any expansion)', () => {
    for (const [x, y] of [[ANCHOR.x, ANCHOR.y + 2], [ANCHOR.x - 2, ANCHOR.y], [ANCHOR.x + 2, ANCHOR.y], [ANCHOR.x, ANCHOR.y - 2]]) {
      const { occupy } = occupyBtnFor(x, y);
      expect(occupy.disabled).toBeFalsy();
    }
  });

  it('tapping an enabled Occupy opens the team picker', () => {
    const { occupy, showTeamPicker, showToast } = occupyBtnFor(ANCHOR.x, ANCHOR.y + 2);
    occupy.action();
    expect(showTeamPicker).toHaveBeenCalledWith(ANCHOR.x, ANCHOR.y + 2, 'occupy');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('enables Occupy on a tile bordering own captured (non-base) territory', () => {
    const h = buildHarness();
    h.ctx.tileCache.set(`${ANCHOR.x + 10}:${ANCHOR.y + 10}`, { occupied: true, mine: true } as WorldTileView);
    h.input.onTileClick(ANCHOR.x + 11, ANCHOR.y + 10); // 4-adjacent to the owned tile
    const buttons = h.showModal.mock.calls[0][1] as Btn[];
    const occupy = buttons.find((b) => b.label === t('world.actOccupy'))!;
    expect(occupy.disabled).toBeFalsy();
  });

  it('never pre-disables Occupy for a player in a family (sibling-sect territory is invisible client-side → defer to server)', () => {
    const { occupy } = occupyBtnFor(ANCHOR.x, ANCHOR.y + 3, { me: makeMe({ familyId: 'fam-1' }) });
    expect(occupy.disabled).toBeFalsy();
  });

  it('shows the tile\'s resource type + level and a recommended-troops line so the player can size the march', () => {
    const h = buildHarness();
    const tx = ANCHOR.x, ty = ANCHOR.y + 2; // 4-adjacent to the capital footprint (enabled Occupy)
    h.ctx.tileCache.set(`${tx}:${ty}`, { resType: 'metal', level: 3 } as WorldTileView);
    h.input.onTileClick(tx, ty);
    const lines = h.showModal.mock.calls[0][0] as string[];
    expect(lines).toContain(t('world.resLevel').replace('{res}', t('world.metal')).replace('{lv}', '3'));
    // npcGarrison(level) = NPC_GARRISON_PER_LEVEL(120) * level
    expect(lines).toContain(t('world.recommendTroops').replace('{n}', '360'));
  });
});
