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
  SiegeHoldView,
  StationedView,
  PlayerWorldView,
} from '../../net/WorldApiClient';

export interface DataHost {
  readonly cb: CitySceneCallbacks;
  readonly destroyed: boolean;
  readonly me: PlayerWorldView | null;
  teams: TeamTemplate[];
  marches: MarchView[];
  occupations: OccupationView[];
  siegeHolds: SiegeHoldView[];
  stationed: StationedView[];
  teamsLoaded: boolean;
  ordersLoaded: boolean;
  setMe(me: PlayerWorldView): void;
  render(): void;
  /** Coalesced repaint (CitySceneCore.requestRender) — refreshOnQueueDue's only paint path. */
  requestRender(): void;
}

/** refreshOnQueueDue's re-entrancy guard, kept on the host so the poll can't stack requests. */
export interface QueuePollHost extends DataHost {
  queueRefreshPending: boolean;
}

/**
 * Build/train queue completion has no push and no other refresh path — worldsvc's 2s scheduler
 * settles the queue server-side but never notifies gateway, so without this the countdown text only
 * updates on the next render() (scroll/action-driven) and the finished entry never disappears until
 * the player leaves and re-enters CityScene (P0-9, comm-audit-2026-07-27 finding B10). Once a queue
 * entry's completeAt has passed, re-fetch `me` — if the server hasn't processed it yet (scheduler
 * lag), the entry is still there and this simply retries next tick.
 *
 * Called from CitySceneCore.update's once-per-second tick.
 */
export function refreshOnQueueDue(host: QueuePollHost): void {
  if (host.queueRefreshPending || host.destroyed || !host.me) return;
  const now = Date.now();
  const due =
    (host.me.buildQueue ?? []).some((q) => q.completeAt <= now) ||
    (host.me.trainingQueue ?? []).some((q) => q.completeAt <= now);
  if (!due) return;
  host.queueRefreshPending = true;
  host.cb.worldApi
    .getMe(host.cb.worldId)
    .then((me) => {
      if (!host.destroyed) {
        host.setMe(me);
        host.requestRender();
      }
    })
    .catch(() => {
      /* offline: retry next tick */
    })
    .finally(() => {
      host.queueRefreshPending = false;
    });
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

  // marches + occupations + siege holds (围攻驻留) + field-stationed teams all feed teamOrder(), so they
  // arrive together in one GET /world/orders and `ordersLoaded` flips once it settles — see the field's
  // doc comment for why the status line waits on that. A team with only a stationed or siege-hold doc
  // would otherwise read 驻军在家 while standing out on the map.
  void host.cb.worldApi
    .getOrders(host.cb.worldId)
    .then((orders) => {
      host.marches = orders.marches;
      host.occupations = orders.occupations;
      host.siegeHolds = orders.siegeHolds;
      host.stationed = orders.stationed;
    })
    .catch(() => {
      /* offline — treated as no active orders */
    })
    .finally(() => {
      host.ordersLoaded = true;
      paint();
    });
}
