// `refreshTeams` — the team panel's only data source, and its two non-obvious rules (2026-08-30).
//
// The panel has to tell "I haven't fetched your teams yet" apart from "you genuinely have no
// formations": the first says 加载中, the second says 尚无队伍，先去编辑布阵. That distinction rests
// entirely on `ctx.teamsLoaded`, and it has to behave in a specific way that no type can enforce:
//   • it must NOT latch on a failed fetch  — else a player who opened the map offline is told they
//     have no teams, and the advice ("go edit a formation") is wrong.
//   • it must NEVER un-latch once set     — a later offline blip must keep showing the last known
//     roster, not silently claim the player disbanded everything.
//
// The third rule is about first paint: `loadData` deliberately fires this WITHOUT awaiting it. The
// whole point of `/world/enter` (P1-5, comm-audit-2026-07-27) is one round-trip before the map is
// on screen; an `await` here would quietly put a second request back in front of it.
//
// Same shape as worldMapNetActions.ui.ts: a real WorldMapNet over a hand-rolled plain-object ctx
// (nothing here touches PIXI), dressed as .ui.ts to sit with the rest of the WorldMap suite.

import { describe, it, expect, vi } from 'vitest';
import { initI18n } from '../../src/i18n';
import { WorldMapNet } from '../../src/scenes/worldmap/WorldMapNet';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView, TeamTemplate } from '../../src/net/WorldApiClient';

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
const team = (id: string): TeamTemplate =>
  ({ id, name: '', army: [{ cardInstanceId: `card-${id}` }] } as TeamTemplate);

function buildHarness(getTeams: () => Promise<TeamTemplate[]>) {
  const renderHud = vi.fn();
  const getTeamsSpy = vi.fn(getTeams);
  const getMe = vi.fn(async () => ({ joined: true, cardState: {} } as unknown as PlayerWorldView));
  const enterWorld = vi.fn(async () => { throw new Error('offline'); });
  const ctx = {
    destroyed: false,
    zoom: 1 as const,
    teams: [] as TeamTemplate[],
    teamsLoaded: false,
    tileCache: new Map(),
    me: null,
    view: { renderMap: vi.fn(), centerAt: vi.fn(), viewportCenter: () => ({ cx: 0, cy: 0, r: 10 }) },
    panels: { renderHud, showToast: vi.fn() },
    cb: { worldId: WORLD_ID, worldApi: { getTeams: getTeamsSpy, getMe, enterWorld } },
  } as unknown as WorldMapContext;
  return { ctx, net: new WorldMapNet(ctx), getTeams: getTeamsSpy, renderHud };
}

describe('refreshTeams', () => {
  it('stores the roster, latches teamsLoaded, and repaints the HUD', () => {
    const { ctx, net, renderHud } = buildHarness(async () => [team('t1'), team('t2')]);
    return net.refreshTeams().then(() => {
      expect(ctx.teams.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(ctx.teamsLoaded).toBe(true);
      expect(renderHud).toHaveBeenCalled();
    });
  });

  it('an empty roster still latches — "you have no teams" is an answer, not a missing one', () => {
    const { ctx, net } = buildHarness(async () => []);
    return net.refreshTeams().then(() => {
      expect(ctx.teams).toEqual([]);
      expect(ctx.teamsLoaded).toBe(true);
    });
  });

  it('a FIRST fetch that fails leaves teamsLoaded false, so the panel says loading, not "no teams"', () => {
    const { ctx, net } = buildHarness(async () => { throw new Error('offline'); });
    return net.refreshTeams().then(() => {
      expect(ctx.teams).toEqual([]);
      expect(ctx.teamsLoaded).toBe(false);
    });
  });

  it('a LATER failure keeps both the roster and the latch — an offline blip must not empty the panel', async () => {
    let fail = false;
    const { ctx, net } = buildHarness(async () => {
      if (fail) throw new Error('offline');
      return [team('t1')];
    });
    await net.refreshTeams();
    fail = true;
    await net.refreshTeams();

    expect(ctx.teams.map((t) => t.id)).toEqual(['t1']);
    expect(ctx.teamsLoaded).toBe(true);
  });

  it('a destroyed scene never fetches (shared loader lifecycle contract)', async () => {
    const { ctx, net, getTeams } = buildHarness(async () => [team('t1')]);
    (ctx as unknown as { destroyed: boolean }).destroyed = true;
    await net.refreshTeams();
    expect(getTeams).not.toHaveBeenCalled();
  });
});

describe('refreshTeams call sites', () => {
  it('loadData kicks it off but does NOT await it — first paint must not wait on a second request', async () => {
    // A never-settling getTeams: if loadData ever `await`s this, the test times out instead of
    // failing an assertion, which is exactly the regression signal we want (`/world/enter` is a
    // one-round-trip path by design).
    const { net, getTeams } = buildHarness(() => new Promise<TeamTemplate[]>(() => {}));
    await net.loadData();
    expect(getTeams).toHaveBeenCalledWith(WORLD_ID);
  });

  it('refreshMe picks up a re-crewed roster — the overlays that trigger it are the ones that edit teams', async () => {
    const { ctx, net } = buildHarness(async () => [team('t1'), team('t2'), team('t3')]);
    await net.refreshMe();
    // refreshMe fires refreshTeams without awaiting it, same as loadData; drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.teams).toHaveLength(3);
  });
});
