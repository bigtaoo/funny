// Two things the CityScene team row leans on that its own big UI file only ever exercises
// indirectly, through rendered text (2026-08-25, added with the field-station status fix — see
// design/game/SLG_CITY_DESIGN.md §8.9):
//
//   1. `helpers.teamOrder()` — the three-source predicate ("is this team away from home?") that
//      mirrors worldsvc's TEAM_BUSY gate. Asserted directly here: a rendered-label test can only
//      show which branch won, not that the ranking and the ownership filters hold across every
//      combination.
//   2. The load fan-out itself — that all five slices are actually requested, and that /world/teams
//      is issued FIRST. That order is not cosmetic: net/rateGate.ts hands out its 5-token bucket
//      strictly FIFO, so when the bucket is drained (world-map entry, a burst of taps) the issue
//      order IS the service order, and the team row is what the player is waiting on here. Nothing
//      pinned it before, so a reordered fan-out (or a dropped slice) was a silent regression.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import { teamOrder } from '../../src/scenes/CityScene/helpers';
import type {
  MarchView,
  OccupationView,
  StationedView,
  PlayerWorldView,
  WorldApiClient,
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

const march = (over: Partial<MarchView> = {}): MarchView =>
  ({ marchId: 'm1', teamId: 't1', arriveAt: 1_000, ...over }) as unknown as MarchView;
const occ = (over: Partial<OccupationView> = {}): OccupationView =>
  ({ teamId: 't1', dueAt: 2_000, ...over }) as unknown as OccupationView;
const station = (over: Partial<StationedView> = {}): StationedView =>
  ({ tile: '3:4', x: 3, y: 4, teamId: 't1', troops: 400, sinceAt: 500, ...over }) as unknown as StationedView;

describe('CityScene teamOrder — the three-source away-from-home predicate (§8.9)', () => {
  it('returns null when the team appears in none of the three lists', () => {
    expect(teamOrder([], [], [], 't1')).toBeNull();
    // …and when every list is non-empty but belongs to OTHER slots — the bug class this predicate
    // is most exposed to, since all five slots share one set of lists.
    expect(teamOrder([march({ teamId: 't2' })], [occ({ teamId: 't3' })], [station({ teamId: 't4' })], 't1')).toBeNull();
  });

  it('ranks march > occupation > station (all three can name the same slot mid-transition)', () => {
    const all = teamOrder([march()], [occ()], [station()], 't1');
    expect(all && 'march' in all).toBe(true);
    // Mid-recall the march doc is written while the station doc is still there: the march must win,
    // otherwise the row reports a team as parked while it is already walking home.
    const recalling = teamOrder([march()], [], [station()], 't1');
    expect(recalling && 'march' in recalling).toBe(true);
    // Capture-in-place: the occupation timer outranks the station it is being held from.
    const holding = teamOrder([], [occ()], [station()], 't1');
    expect(holding && 'occ' in holding).toBe(true);
  });

  it('returns the station itself — mode intact — when it is the only source', () => {
    const idle = teamOrder([], [], [station()], 't1');
    expect(idle).toEqual({ station: station() });
    // 停留 idle reports no mode at all on legacy docs; 驻扎 garrison must survive to the caller,
    // which picks the label off it.
    const garrison = teamOrder([], [], [station({ mode: 'garrison' })], 't1');
    expect(garrison && 'station' in garrison && garrison.station.mode).toBe('garrison');
  });

  it('ignores enemy marches AND enemy stations in vision (mine === false)', () => {
    // ADR-051 P4: /world/stationed also returns enemy stations within vision. Their teamId is
    // blanked server-side, but a blanked value that happens to collide with one of my slot ids
    // must not claim that slot — same reasoning as getMarches' long-standing `mine !== false`.
    expect(teamOrder([march({ mine: false })], [], [], 't1')).toBeNull();
    expect(teamOrder([], [], [station({ mine: false })], 't1')).toBeNull();
    // An explicit mine:true and a legacy doc with no `mine` field at all both count as own.
    expect(teamOrder([], [], [station({ mine: true })], 't1')).not.toBeNull();
    expect(teamOrder([], [], [station()], 't1')).not.toBeNull();
  });

  it('an enemy march does not shadow my own station for the same slot id', () => {
    // The enemy doc is skipped rather than treated as "a march exists for t1", so the station
    // below it still surfaces.
    const r = teamOrder([march({ mine: false })], [], [station()], 't1');
    expect(r && 'station' in r).toBe(true);
  });
});

describe('CityScene load fan-out (five slices, /world/teams first)', () => {
  function recordingApi(): { api: WorldApiClient; calls: string[] } {
    const calls: string[] = [];
    const rec = <T>(name: string, v: T) => () => { calls.push(name); return Promise.resolve(v); };
    const api = {
      getTeams: rec('getTeams', []),
      getMe: rec('getMe', {
        resources: {}, buildings: {}, buildQueue: [], cardState: {}, teamState: {},
      } as unknown as PlayerWorldView),
      getMarches: rec('getMarches', []),
      getOccupations: rec('getOccupations', []),
      getStationed: rec('getStationed', []),
    } as unknown as WorldApiClient;
    return { api, calls };
  }

  it('requests all five slices exactly once, with getTeams issued first', async () => {
    const { api, calls } = recordingApi();
    const cb: CitySceneCallbacks = { onBack: () => {}, worldApi: api, worldId: 'world:1:0', getFlag: () => true };
    const scene = new CityScene(createLayout(800, 1280), new InputManager(), cb);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls[0]).toBe('getTeams');
    expect([...calls].sort()).toEqual(
      ['getMarches', 'getMe', 'getOccupations', 'getStationed', 'getTeams'].sort()
    );
    scene.destroy();
  });
});
