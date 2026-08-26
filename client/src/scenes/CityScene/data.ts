// CitySceneCore's initial data-fetch fan-out, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛"). teams/marches/occupations/teamsLoaded/ordersLoaded are getter/setter pairs
// (not plain properties) because each `.then()` callback reassigns them wholesale — a plain copied
// property would only rebind this throwaway host object, never reaching back to CitySceneCore's
// own field (same reasoning as RoomScene/views.ts's RoomViewHost).
import { loadResAtlas } from '../../render/atlas/resAtlasLoader';
import { loadCityBldAtlas } from '../../render/atlas/cityBldAtlasLoader';
import type { CitySceneCallbacks } from './core';
import type {
  TeamTemplate,
  MarchView,
  OccupationView,
  StationedView,
  PlayerWorldView,
} from '../../net/WorldApiClient';

export interface DataHost {
  readonly cb: CitySceneCallbacks;
  readonly destroyed: boolean;
  teams: TeamTemplate[];
  marches: MarchView[];
  occupations: OccupationView[];
  stationed: StationedView[];
  teamsLoaded: boolean;
  ordersLoaded: boolean;
  setMe(me: PlayerWorldView): void;
  render(): void;
}

/**
 * Fetch the five independent data slices this scene needs. Deliberately NOT a `Promise.all`
 * barrier (2026-08-02): awaiting all four before the first paint made every slice as slow as the
 * slowest one — the team row in particular sat on placeholder content until getMe/getMarches/
 * getOccupations had also answered, long after /world/teams itself had landed. Each slice now
 * paints the moment its own request resolves.
 *
 * Issue order matters: rateGate.ts hands out its 5-token bucket strictly FIFO, so when the bucket
 * is drained (world-map entry, a burst of taps) requests are served in the order they were made.
 * getTeams goes first because the team row is what the player is waiting on here.
 */
export function load(host: DataHost): void {
  // Resource / producer-building glyphs reuse the res_atlas motifs; re-render once decoded.
  void loadResAtlas()
    .then(() => host.render())
    .catch(() => {
      /* color/emoji fallback */
    });
  void loadCityBldAtlas()
    .then(() => host.render())
    .catch(() => {
      /* icons.ts/emoji fallback */
    });

  const paint = (): void => {
    if (!host.destroyed) host.render();
  };

  void host.cb.worldApi
    .getTeams(host.cb.worldId)
    .then((teams) => {
      host.teams = teams;
    })
    .catch(() => {
      /* offline — the row falls through to its real empty state */
    })
    .finally(() => {
      host.teamsLoaded = true;
      paint();
    });

  void host.cb.worldApi
    .getMe(host.cb.worldId)
    .then((me) => {
      host.setMe(me);
      paint();
    })
    .catch(() => {
      /* offline — resource bar / building grid keep their pre-load zeros */
    });

  // marches + occupations + stationed all feed teamOrder(), so `ordersLoaded` only flips once all
  // three have settled — see the field's doc comment for why the status line waits on that.
  let ordersPending = 3;
  const orderSettled = (): void => {
    if (--ordersPending === 0) host.ordersLoaded = true;
    paint();
  };
  void host.cb.worldApi
    .getMarches(host.cb.worldId)
    .then((marches) => {
      host.marches = marches;
    })
    .catch(() => {
      /* offline — treated as no active march */
    })
    .finally(orderSettled);
  void host.cb.worldApi
    .getOccupations(host.cb.worldId)
    .then((occupations) => {
      host.occupations = occupations;
    })
    .catch(() => {
      /* offline — treated as no active hold */
    })
    .finally(orderSettled);
  // Field-stationed teams (2026-07-23): parked on a tile with neither a march nor an occupation
  // doc, so without this slice the row reports 驻军在家 for a squad standing out on the map.
  void host.cb.worldApi
    .getStationed(host.cb.worldId)
    .then((stationed) => {
      host.stationed = stationed;
    })
    .catch(() => {
      /* offline — treated as no field station */
    })
    .finally(orderSettled);
}
