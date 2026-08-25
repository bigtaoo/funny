// World domain: map/tile/march/occupation/stationed reads, join/enter, mid-season shard transfer,
// tile actions (abandon/relocate/watchtower/structure), and march commands.
import { sampleServerNow } from '../serverClock';
import type { WorldApiCore } from './core';
import type {
  WorldMapView,
  WorldMapSparseView,
  WorldTileView,
  MarchView,
  OccupationView,
  StationedView,
  PlayerWorldView,
  EnterWorldView,
  ShardTransferTargetView,
  WorldCityNodeView,
  MarchKind,
} from './types';

/** World-map/march/tile domain (see ../WorldApiClient.ts assembly + ./core.ts for the shared transport). */
export class WorldService {
  constructor(private readonly core: WorldApiCore) {}

  async getMe(worldId: string): Promise<PlayerWorldView> {
    const data = await this.core.req<PlayerWorldView & { serverNow?: number }>(
      'GET',
      `/world/me?worldId=${encodeURIComponent(worldId)}`
    );
    // P1-1 clock-offset sample — getMe is the highest-frequency SLG round-trip.
    if (typeof data.serverNow === 'number') sampleServerNow(data.serverNow);
    return data;
  }

  async getMap(worldId: string, cx: number, cy: number, r: number): Promise<WorldMapView> {
    return this.core.req(
      'GET',
      `/world/map?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`
    );
  }

  /** Sparse occupied layer (zoom 2/3): returns only occupied tiles; no profile RPC, no visibility computation. */
  async getMapSparse(
    worldId: string,
    cx: number,
    cy: number,
    r: number,
    lod: 'thin' | 'mid'
  ): Promise<WorldMapSparseView> {
    return this.core.req(
      'GET',
      `/world/map/sparse?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}&lod=${lod}`
    );
  }

  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.core.req('GET', `/world/tile/${x}:${y}:${encodeURIComponent(worldId)}`);
  }

  async getMarches(worldId: string): Promise<MarchView[]> {
    return this.core.req('GET', `/world/march?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Own active occupation-holds (2026-07-15 team management: status + cancel affordance). */
  async getOccupations(worldId: string): Promise<OccupationView[]> {
    return this.core.req('GET', `/world/occupations?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Own teams stationed on tiles (2026-07-23 field-stationing: idle-sprite rendering + recall affordance). */
  async getStationed(worldId: string): Promise<StationedView[]> {
    return this.core.req('GET', `/world/stationed?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Full list of owned tiles (territory + captured stronghold; excludes the 3×3 capital footprint). Backs the Territory Overview panel (SLG_DESIGN_LOG.md §26). */
  async getTerritories(worldId: string): Promise<WorldTileView[]> {
    return this.core.req('GET', `/world/territories?worldId=${encodeURIComponent(worldId)}`);
  }

  /**
   * Wild-city siege state (ADR-074 P1): the ~64 city nodes with live durability / owning sect / protection
   * window. Same payload `enterWorld` already embeds — this exists so the city info panel can refresh while
   * open, since durability regenerates continuously and other sects are hitting the same walls. Not pushed:
   * a durability hit lands dozens of times an hour per city, so a push per hit to a sect of up to ~900
   * members would be a faucet; capture announces itself on the sect channel instead.
   */
  async getCities(worldId: string): Promise<WorldCityNodeView[]> {
    return this.core.req('GET', `/world/cities?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Enter the world: the system automatically places the player's city (§3.4; prefers near family → outer-ring newcomer zone); spawn point is server-determined, player does not pass coordinates. */
  async joinWorld(worldId: string): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/join', { worldId });
  }

  /**
   * Aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27): merges getMe+joinWorld+getMap(or
   * getMapSparse)+getMarches+getOccupations+getStationed+getSeason+getNations+getWorldChannel into one
   * round-trip, replacing the 9-request waterfall WorldMapNet.loadData() used to fire on every
   * world-map entry. `r` is the viewport radius (independent of map center — the server derives cx/cy
   * itself from the resolved mainBaseTile); `zoom` picks `map` (1) vs `mapSparse` (2/3).
   */
  async enterWorld(worldId: string, r: number, zoom: 1 | 2 | 3): Promise<EnterWorldView> {
    const data = await this.core.req<
      EnterWorldView & { me: PlayerWorldView & { serverNow?: number } }
    >('POST', '/world/enter', {
      worldId,
      r,
      zoom,
    });
    if (typeof data.me.serverNow === 'number') sampleServerNow(data.me.serverNow);
    return data;
  }

  /** Mid-season shard transfer (G6/§27): candidate destination shards for the player's current shard. */
  async getTransferTargets(worldId: string): Promise<ShardTransferTargetView[]> {
    return this.core.req(
      'GET',
      `/world/season/transfer/targets?worldId=${encodeURIComponent(worldId)}`
    );
  }

  /** Mid-season shard transfer (G6/§27): forfeits all shard-scoped state in fromWorldId, re-joins toWorldId fresh. */
  async transferShard(fromWorldId: string, toWorldId: string): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/season/transfer', { fromWorldId, toWorldId });
  }

  /** Return the current active SLG season number from worldsvc (§20.8). No auth required. */
  async getActiveSeason(timeoutMs = 10_000): Promise<{ season: number }> {
    return this.core.req('GET', '/world/active-season', undefined, timeoutMs);
  }

  /**
   * Resolve which shard this account should enter for the given season (G6/§20): resolve only, no city placement; returns the real worldId before entering the map (stickiness > family > solo random; overflow opens a new shard).
   */
  async resolveSeason(season: number): Promise<{ worldId: string }> {
    return this.core.req('POST', '/world/season/resolve', { season });
  }

  /**
   * Season join (G6/§20): server resolves the shard for this account (sect > family > solo random; overflow opens a new shard) then **automatically places the city** (§3.4).
   * The returned PlayerWorldView contains the resolved `worldId`; client uses it to enter the map. Player does not pass coordinates.
   */
  async joinSeason(season: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/season/join', { season });
  }

  /** Abandon an owned tile. Returns the updated player world state (P1-3: was mis-declared as bare
   *  {ok:true} — the server always returned the full PlayerWorldView, so the caller can adopt it
   *  directly instead of following up with a separate GET /world/me). */
  async abandonTile(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/abandon', { worldId, x, y });
  }

  /** Actively relocate the player's base (costs RELOCATE_COST coins to move to (x,y)). Returns the updated player world state after relocation. */
  async relocateBase(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.core.req('POST', '/world/relocate', { worldId, x, y });
  }

  /** Build a watchtower (spend WATCHTOWER_COST resources on owned territory at (x,y) to create a large-radius persistent vision source; §18 G5 V2).
   *  Returns the built tile plus `me` (P1-3: resource cost isn't visible on the tile itself; the caller
   *  adopts `me` directly instead of a separate GET /world/me). */
  async buildWatchtower(
    worldId: string,
    x: number,
    y: number
  ): Promise<WorldTileView & { me: PlayerWorldView }> {
    return this.core.req('POST', '/world/watchtower', { worldId, x, y });
  }

  /** ADR-051 (P5): build a player structure (arrowTower / blocker) on own or same-family territory at (x,y).
   *  Returns the built tile plus `me` (P1-3, same reasoning as buildWatchtower above). */
  async buildStructure(
    worldId: string,
    x: number,
    y: number,
    kind: 'arrowTower' | 'blocker'
  ): Promise<WorldTileView & { me: PlayerWorldView }> {
    return this.core.req('POST', '/world/structure', { worldId, x, y, kind });
  }

  /** ADR-051 (P5): demolish one's own structure at (x,y). */
  async demolishStructure(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.core.req('POST', '/world/structure/demolish', { worldId, x, y });
  }

  /** Returns the created march plus `me` (P1-3: committed troops/resources aren't visible on the march
   *  itself; the caller adopts `me` directly and locally appends the march to its cached list, instead
   *  of following up with GET /world/march + GET /world/me). */
  async startMarch(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
    /** ADR-051 (P3a/P4): 'garrison' parks the arriving team as a 驻扎 garrison (defends its 3×3 footprint, stays busy);
     * omitted / 'idle' keeps it 停留 idle (free to re-command). Only honored server-side for kind='move'. */
    stationMode?: 'idle' | 'garrison'
  ): Promise<MarchView & { me: PlayerWorldView }> {
    return this.core.req('POST', '/world/march', {
      worldId,
      fromX,
      fromY,
      toX,
      toY,
      kind,
      troops,
      ...(teamId ? { teamId } : {}),
      ...(stationMode === 'garrison' ? { stationMode } : {}),
    });
  }

  async recallMarch(marchId: string, worldId: string): Promise<{ ok: true }> {
    return this.core.req('POST', `/world/march/${encodeURIComponent(marchId)}/recall`, { worldId });
  }

  /** Pay coins to instantly complete an in-transit 'return' march (2026-08-01, SLG_DESIGN_LOG §46). Cost is server-computed from remaining travel time — no coin amount is sent. */
  async instantReturnMarch(marchId: string, worldId: string): Promise<PlayerWorldView> {
    return this.core.req('POST', `/world/march/${encodeURIComponent(marchId)}/instant-return`, {
      worldId,
    });
  }

  /** Force a team stuck in an occupation-hold back to idle immediately (garrison forfeited, no refund). */
  async cancelOccupation(teamId: string, worldId: string): Promise<{ ok: true }> {
    return this.core.req('POST', `/world/team/${encodeURIComponent(teamId)}/cancel-occupation`, {
      worldId,
    });
  }

  /** Recall a stationed team home (2026-07-23): dispatches a return leg tile→base; the slot frees when it arrives. */
  async recallStationed(teamId: string, worldId: string): Promise<MarchView> {
    return this.core.req('POST', `/world/team/${encodeURIComponent(teamId)}/recall-stationed`, {
      worldId,
    });
  }
}
