// SLG city/world actions (BOTSVC_DESIGN §3.2 slg_action): public /world/* REST, same auth as any
// real client (the bot's own player JWT). No auction/social endpoints here — B8 keeps bots out of
// the auction house and chat entirely.
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

export interface PlayerWorldView {
  joined: boolean;
  worldId?: string;
  troops?: number;
  mainBaseTile?: string;
  [key: string]: unknown;
}

export type SparseTileType =
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

export interface WorldTileSparseView {
  x: number;
  y: number;
  type: SparseTileType;
  mine?: boolean;
  ally?: boolean;
  allySect?: boolean;
}

/** Occupied structures worth marching on; resource/neutral/obstacle tiles are never attack targets. */
const ATTACKABLE_TYPES: ReadonlySet<SparseTileType> = new Set(['territory', 'base', 'stronghold']);

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
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? `world call failed: ${method} ${path}`);
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

  upgradeBuilding(token: string, worldId: string, key: BuildingKey): Promise<void> {
    return this.call<void>('POST', '/world/build/upgrade', token, { worldId, key });
  }

  getWorldMapSparse(
    token: string,
    worldId: string,
    cx: number,
    cy: number,
    r: number,
  ): Promise<{ tiles: WorldTileSparseView[] }> {
    const q = `worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`;
    return this.call<{ tiles: WorldTileSparseView[] }>('GET', `/world/map/sparse?${q}`, token);
  }

  startMarchAttack(
    token: string,
    worldId: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    troops: number,
  ): Promise<void> {
    return this.call<void>('POST', '/world/march', token, {
      worldId,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      kind: 'attack',
      troops,
    });
  }

  /** Own base coordinates parsed from `mainBaseTile`; null until the bot has a placed base. */
  baseCoords(view: PlayerWorldView): { x: number; y: number } | null {
    return view.mainBaseTile ? parseTileCoords(view.mainBaseTile) : null;
  }

  /** Nearest attackable (occupied, non-mine) tile in the given sparse viewport, or null if none. */
  pickAttackTarget(tiles: WorldTileSparseView[]): { x: number; y: number } | null {
    const candidates = tiles.filter((t) => !t.mine && ATTACKABLE_TYPES.has(t.type));
    return candidates.length > 0 ? { x: candidates[0]!.x, y: candidates[0]!.y } : null;
  }
}
