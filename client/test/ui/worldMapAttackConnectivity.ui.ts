// Regression coverage for the ADR-039 "连地" (territory-connectivity) ATTACK pre-check in
// WorldMapNet.showTeamPicker (client/src/scenes/worldmap/net/march.ts + logic/attackConnectivity.ts).
//
// 2026-08-29 user report: attacking an enemy base or a neutral (wild) city that doesn't border the
// player's own territory got the wrong "尚无队伍，先去编辑布阵" toast whenever every owned team happened
// to be busy elsewhere (5 teams all out) — showTeamPicker's usable-teams-empty fallback fires regardless
// of WHY there are no usable teams, so the real (and in that scenario the only) blocker —
// TERRITORY_NOT_CONNECTED — never surfaced, because the request never reaches startMarch (no usable team
// to dispatch). Fix: check connectivity BEFORE opening the picker at all, so the actual reason
// (world.err.notConnected) shows up immediately, independent of team availability.
//
// Same SOLO-only scope guard as the existing occupy pre-check (worldMapOccupyConnectivity.ui.ts): a
// family member's sibling-sect territory is invisible client-side, so the check defers to true (and thus
// to the server) rather than risk a false "not connected" for someone who actually IS connected via a
// sibling family's land.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView, WorldCityNodeView } from '../../src/net/WorldApiClient';

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

function buildHarness(opts: {
  me?: Partial<PlayerWorldView>;
  tiles?: [string, WorldTileView][];
  cityNodes?: WorldCityNodeView[] | null;
  teams?: { id: string; name: string; army: { cardInstanceId?: string }[] }[];
  cardState?: Record<string, { currentTroops: number }>;
} = {}) {
  const showModal = vi.fn();
  const showToast = vi.fn();
  const closeModal = vi.fn();
  const renderHud = vi.fn();
  const getTeams = vi.fn().mockResolvedValue(opts.teams ?? []); // empty by default — the picker's own "no teams" path must never fire once connectivity blocks first
  const startMarch = vi.fn().mockResolvedValue({ toTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}` });

  const ctx = {
    mapW: 500,
    mapH: 500,
    tileCache: new Map<string, WorldTileView>(opts.tiles ?? []),
    cityNodes: opts.cityNodes ?? null,
    marches: [],
    occupations: [],
    stationed: [],
    me: {
      joined: true,
      mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`,
      cardState: opts.cardState ?? { c1: { currentTroops: 500 } },
      ...opts.me,
    } as PlayerWorldView,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
    view: { renderMap: vi.fn() },
    cb: { worldId: WORLD_ID, worldApi: { getTeams, startMarch, getMarches: vi.fn().mockResolvedValue([]), getMe: vi.fn() } },
    panels: { showModal, showToast, closeModal, showDeployDialog: vi.fn(), renderHud },
  } as unknown as WorldMapContext;

  const net = new WorldMapNet(ctx);
  return { ctx, net, showModal, showToast, getTeams, startMarch };
}

describe('WorldMapNet.showTeamPicker — attack connectivity pre-check (ADR-039, 2026-08-29)', () => {
  it('blocks with world.err.notConnected — not the generic "no teams" toast — for a disconnected enemy tile, even with zero usable teams', async () => {
    const { net, showToast, showModal, getTeams } = buildHarness({
      tiles: [[`${ANCHOR.x + 50}:${ANCHOR.y + 50}`, { type: 'territory', occupied: true } as WorldTileView]],
    });
    await net.showTeamPicker(ANCHOR.x + 50, ANCHOR.y + 50, 'attack');
    expect(showToast).toHaveBeenCalledWith(t('world.err.notConnected'), expect.anything());
    expect(showModal).not.toHaveBeenCalled(); // never even opens the (misleading) picker
    expect(getTeams).not.toHaveBeenCalled(); // short-circuits before the network round trip too
  });

  it('opens the picker normally for an enemy tile 4-adjacent to the own capital footprint', async () => {
    const { net, showToast, showModal, getTeams } = buildHarness({
      tiles: [[`${ANCHOR.x}:${ANCHOR.y + 2}`, { type: 'territory', occupied: true } as WorldTileView]],
      teams: [{ id: 't1', name: 'Alpha', army: [{ cardInstanceId: 'c1' }] }],
    });
    await net.showTeamPicker(ANCHOR.x, ANCHOR.y + 2, 'attack');
    expect(showToast).not.toHaveBeenCalled();
    expect(getTeams).toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it('never blocks a family member — sibling-sect territory is invisible client-side, so it defers to the server', async () => {
    const { net, showToast, showModal, getTeams } = buildHarness({
      me: { familyId: 'fam-1' },
      tiles: [[`${ANCHOR.x + 50}:${ANCHOR.y + 50}`, { type: 'territory', occupied: true } as WorldTileView]],
    });
    await net.showTeamPicker(ANCHOR.x + 50, ANCHOR.y + 50, 'attack');
    expect(showToast).not.toHaveBeenCalledWith(t('world.err.notConnected'), expect.anything());
    expect(getTeams).toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledTimes(1); // falls through to the normal (here: "no teams") picker flow
  });

  it('resolves an enemy BASE target\'s whole 3×3 footprint (not just the tapped cell) before checking connectivity', async () => {
    // Enemy base far from mine, footprint anchored at (100,100); the tapped cell is a ring cell (100,99),
    // adjacent to nothing of mine — must resolve to the same disconnected verdict as tapping the anchor.
    const tiles: [string, WorldTileView][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push([`${100 + dx}:${100 + dy}`, { type: 'base', occupied: true } as WorldTileView]);
    const { net, showToast } = buildHarness({ tiles });
    await net.showTeamPicker(100, 99, 'attack');
    expect(showToast).toHaveBeenCalledWith(t('world.err.notConnected'), expect.anything());
  });

  it('resolves a neutral (wild) city\'s whole plot via cityNodes before checking connectivity', async () => {
    const tiles: [string, WorldTileView][] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) tiles.push([`${200 + dx}:${200 + dy}`, { type: 'familyKeep' } as WorldTileView]);
    const { net, showToast } = buildHarness({
      tiles,
      cityNodes: [{ id: 'garrison-1', kind: 'garrison', x: 200, y: 200, level: 3, footprint: 5 } as WorldCityNodeView],
    });
    // Tap a plot-edge cell far from the anchor — still resolves to the whole 5×5 plot, still disconnected.
    await net.showTeamPicker(202, 198, 'attack');
    expect(showToast).toHaveBeenCalledWith(t('world.err.notConnected'), expect.anything());
  });

  it('does not gate occupy/move — only attack requires this pre-check', async () => {
    const { net, showToast, getTeams } = buildHarness({
      tiles: [[`${ANCHOR.x + 50}:${ANCHOR.y + 50}`, { type: 'neutral' } as WorldTileView]],
    });
    await net.showTeamPicker(ANCHOR.x + 50, ANCHOR.y + 50, 'occupy');
    expect(showToast).not.toHaveBeenCalledWith(t('world.err.notConnected'), expect.anything());
    expect(getTeams).toHaveBeenCalled();
  });
});
