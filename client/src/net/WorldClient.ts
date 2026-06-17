// worldsvc REST 客户端（S8）。
// 使用内联 DTO 类型（不走 openapi-typescript codegen）。
// 所有请求经 Authorization: Bearer <token>；baseUrl 由 getWorldBaseUrl() 提供。
import { getWorldBaseUrl } from './config';

export interface ProceduralTileView {
  x: number;
  y: number;
  type: string;
  level: number;
  resourceType?: string;
}

export interface TileView extends ProceduralTileView {
  occupied?: boolean;
  mine?: boolean;
  ownerId?: string;
  garrison?: number;
  protected?: boolean;
  yieldRate?: Record<string, number>;
}

export interface MapView {
  worldId: string;
  tiles: TileView[];
  cx: number;
  cy: number;
  r: number;
}

export interface PlayerWorldView {
  worldId: string;
  mainBaseTile: string;
  troops: number;
  troopCap: number;
  territoryCount: number;
  resources: Record<string, number>;
  yieldRate: Record<string, number>;
  protected?: boolean;
  protectionEndsAt?: number;
}

export interface MarchView {
  marchId: string;
  kind: string;
  fromTile: string;
  toTile: string;
  troops: number;
  departAt: number;
  arriveAt: number;
  status: string;
}

export class WorldApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorldApiError';
  }
}

async function worldFetch<T>(
  path: string,
  token: string,
  opts?: RequestInit,
): Promise<T> {
  const base = getWorldBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(opts?.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  if (!body.ok || !res.ok) {
    throw new WorldApiError(body.error?.code ?? 'UNKNOWN', body.error?.message ?? 'worldsvc error');
  }
  return body.data as T;
}

export class WorldClient {
  constructor(private readonly token: string) {}

  getMap(worldId: string, cx: number, cy: number, r = 12): Promise<MapView> {
    return worldFetch<MapView>(
      `/world/map?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`,
      this.token,
    );
  }

  getMe(worldId: string): Promise<PlayerWorldView> {
    return worldFetch<PlayerWorldView>(`/world/me?worldId=${encodeURIComponent(worldId)}`, this.token);
  }

  getTile(worldId: string, x: number, y: number): Promise<TileView> {
    return worldFetch<TileView>(`/world/tile/${encodeURIComponent(`${worldId}:${x}:${y}`)}`, this.token);
  }

  joinWorld(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return worldFetch<PlayerWorldView>('/world/join', this.token, {
      method: 'POST',
      body: JSON.stringify({ worldId, x, y }),
    });
  }

  occupyTile(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return worldFetch<PlayerWorldView>('/world/occupy', this.token, {
      method: 'POST',
      body: JSON.stringify({ worldId, x, y }),
    });
  }

  abandonTile(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return worldFetch<PlayerWorldView>('/world/abandon', this.token, {
      method: 'POST',
      body: JSON.stringify({ worldId, x, y }),
    });
  }

  getMarches(worldId: string): Promise<MarchView[]> {
    return worldFetch<MarchView[]>(`/world/march?worldId=${encodeURIComponent(worldId)}`, this.token);
  }

  startMarch(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: 'occupy' | 'reinforce' | 'attack' | 'sweep',
    troops: number,
  ): Promise<MarchView> {
    return worldFetch<MarchView>('/world/march', this.token, {
      method: 'POST',
      body: JSON.stringify({ worldId, fromX, fromY, toX, toY, kind, troops }),
    });
  }

  recallMarch(worldId: string, marchId: string): Promise<MarchView> {
    return worldFetch<MarchView>(`/world/march/${encodeURIComponent(marchId)}/recall`, this.token, {
      method: 'POST',
      body: JSON.stringify({ worldId }),
    });
  }
}
