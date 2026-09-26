// SLG city/world actions (BOTSVC_DESIGN §3.2 slg_action): public /world/* REST, same auth as any
// real client (the bot's own player JWT). No auction/social endpoints here — B8 keeps bots out of
// the auction house and chat entirely. Sect found/join (BOTSVC_DESIGN §3.3) lives here too because
// sects are worldsvc-owned, not socialsvc.
import { envelopeError } from './apiError';

export type BuildingKey =
  | 'desk'
  | 'inkPot'
  | 'paperTray'
  | 'graphiteMill'
  | 'metalForge'
  | 'stickerShop'
  | 'cabinet'
  | 'drillYard'
  | 'wall'
  | 'academy';

/**
 * The `/world/me` projection, narrowed to the fields a bot actually reads (openapi-world.yml
 * PlayerWorldView). `resources`/`buildings`/`buildQueue` are typed because the upgrade decision is
 * made from them client-side — see BotSession.affordableBuilding().
 *
 * `resources` is the SETTLED balance at the moment of the read: worldsvc accrues `yieldRate` over
 * `lastTickAt` on every read and only persists it when something is spent. So a snapshot of this
 * field only ever under-states a later balance, never over-states it.
 */
export interface PlayerWorldView {
  joined: boolean;
  worldId?: string;
  troops?: number;
  mainBaseTile?: string;
  resources?: Partial<Record<string, number>>;
  buildings?: Partial<Record<string, number>>;
  buildQueue?: { key: BuildingKey; toLevel: number; startAt: number; completeAt: number }[];
  [key: string]: unknown;
}

/** `/sect/list` row, narrowed to what the join/found decision reads. */
export interface SectView {
  sectId: string;
  name: string;
  tag: string;
  leaderFamilyId: string;
  memberFamilyCount: number;
}

export type TileType =
  | 'neutral'
  | 'resource'
  | 'territory'
  | 'familyKeep'
  | 'center'
  | 'base'
  | 'obstacle'
  | 'bridge'
  | 'plankway'
  | 'stronghold';

/**
 * One `/world/map` cell (openapi-world.yml WorldTileView), narrowed to what the expansion planner reads
 * (expansion.ts). The full view, not `/world/map/sparse`: the sparse layer lists occupied tiles only,
 * so it cannot say which neutral neighbour is a paper tile or what level it is.
 */
export interface WorldTileView {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: string;
  occupied?: boolean;
  mine?: boolean;
  /** Same family. */
  ally?: boolean;
  /** Same sect, other family — counts toward ADR-039 connectivity. */
  sectmate?: boolean;
  /** Allied sect — does NOT count toward connectivity. */
  allySect?: boolean;
  protectedUntil?: number;
  /** Mid occupation-hold (ADR-037): someone already won this tile's battle and is waiting out the hold. */
  contestedUntil?: number;
}

/** `POST /world/march` answer (MarchView), narrowed to the arrival time the bot paces its next march on. */
export interface MarchStarted {
  arriveAt?: number;
}

/** `{worldId}:{x}:{y}` (worldsvc's own tileId format, see server/worldsvc/src/coreKernel.ts). Split from the right since worldId itself never contains ':'. */
function parseTileCoords(tileId: string): { x: number; y: number } | null {
  const parts = tileId.split(':');
  if (parts.length < 3) return null;
  const y = Number(parts[parts.length - 1]);
  const x = Number(parts[parts.length - 2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export class WorldClient {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: unknown };
    if (!parsed.ok) throw envelopeError(parsed.error, `world call failed: ${method} ${path}`);
    return parsed.data as T;
  }

  getActiveSeason(): Promise<{ season: number }> {
    return this.call<{ season: number }>('GET', '/world/active-season', '');
  }

  /** Resolves shard + auto-places the base in one call (server picks the spot, §3.4). */
  joinSeason(token: string, season: number): Promise<PlayerWorldView> {
    return this.call<PlayerWorldView>('POST', '/world/season/join', token, { season });
  }

  getWorldMe(token: string, worldId: string): Promise<PlayerWorldView> {
    return this.call<PlayerWorldView>('GET', `/world/me?worldId=${encodeURIComponent(worldId)}`, token);
  }

  /** Returns the post-upgrade `/world/me` (worldsvc answers this route with getMe), so the caller can
   *  refresh its resource snapshot without a second round trip. */
  upgradeBuilding(token: string, worldId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.call<PlayerWorldView>('POST', '/world/build/upgrade', token, { worldId, key });
  }

  /** Full map view (every cell, with terrain/level/resource type) in the Chebyshev window of radius `r` around (cx, cy). */
  getWorldMap(token: string, worldId: string, cx: number, cy: number, r: number): Promise<{ tiles: WorldTileView[] }> {
    const q = `worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`;
    return this.call<{ tiles: WorldTileView[] }>('GET', `/world/map?${q}`, token);
  }

  /** A flat-pool march (no team): the troops leave `playerWorld.troops` at departure. */
  startMarch(
    token: string,
    worldId: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    kind: 'occupy' | 'attack',
    troops: number,
  ): Promise<MarchStarted> {
    return this.call<MarchStarted>('POST', '/world/march', token, {
      worldId,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      kind,
      troops,
    });
  }

  /** Every sect in the world (worldsvc caps the list at 50, sorted by member-family count). */
  listSects(token: string, worldId: string): Promise<SectView[]> {
    return this.call<SectView[]>('GET', `/sect/list?worldId=${encodeURIComponent(worldId)}`, token);
  }

  /** Family-leader only; worldsvc charges SECT_CREATE_COST coins through commercial. */
  createSect(token: string, worldId: string, name: string, tag: string): Promise<SectView> {
    return this.call<SectView>('POST', '/sect/create', token, { worldId, name, tag });
  }

  /** Family-leader only; instant (no approval step for sects). */
  joinSect(token: string, worldId: string, sectId: string): Promise<void> {
    return this.call<void>('POST', '/sect/join', token, { worldId, sectId });
  }

  /** Own base coordinates parsed from `mainBaseTile`; null until the bot has a placed base. */
  baseCoords(view: PlayerWorldView): { x: number; y: number } | null {
    return view.mainBaseTile ? parseTileCoords(view.mainBaseTile) : null;
  }
}
