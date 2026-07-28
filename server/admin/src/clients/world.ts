import { fetchInternalJson, type MapTemplateSummary, type MapTemplateTile } from '@nw/shared';

// ── SLG season operations (worldsvc /admin/world/*, G7/§17.7) ────────
/** Operational summary for one world region (used in list views). */
export interface SlgWorldSummary {
  worldId: string;
  season: number;
  shard: number;
  status: string;
  population: number;
  capacity: number;
  openAt: number;
  resetAt?: number;
  engineVersion?: number;
}

export interface WorldClient {
  readonly available: boolean;
  listWorlds(): Promise<SlgWorldSummary[]>;
  openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void>;
  settleWorld(worldId: string): Promise<unknown>;
  resetWorld(worldId: string): Promise<unknown>;
  closeWorld(worldId: string): Promise<void>;
  /** G6 shard merge (§27): move every remaining player out of worldId (source) into targetWorldId, then close worldId. */
  mergeWorld(worldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }>;

  // ── Map templates (§24 Layer A, admin map editor) ──
  listMapTemplates(): Promise<MapTemplateSummary[]>;
  generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary>;
  getMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]>;
  saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }>;
  activateMapTemplate(templateId: string): Promise<void>;
  deleteMapTemplate(templateId: string): Promise<void>;
}

/** admin → worldsvc internal HTTP (X-Internal-Key). worldsvc endpoints are in the internal branch of httpApi.ts. */
export class HttpWorldClient implements WorldClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  /** Season lifecycle ops (open/settle/reset/close/merge) are synchronous long operations on the
   *  worldsvc side (full-map settlement / player moves); a 10s client deadline would cut them off
   *  mid-flight, so they get a long one. Server-side storm control is a separate batch (comm-audit E). */
  private static readonly SEASON_OP_TIMEOUT_MS = 120000;

  async listWorlds(): Promise<SlgWorldSummary[]> {
    if (!this.baseUrl) return [];
    const r = await fetchInternalJson<{ ok?: boolean; data?: SlgWorldSummary[] }>(`${this.baseUrl}/admin/world/list`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'worldsvc /admin/world/list',
    });
    if (!r.ok) throw new Error(`listWorlds failed: ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.data ?? [];
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: Record<string, unknown>,
    timeoutMs = 10000,
  ): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    // Throws on failure (as before, where non-2xx / ok:false threw and network errors bubbled) —
    // these are operator-initiated actions and the ops frontend must see the error.
    const r = await fetchInternalJson<{ ok?: boolean; data?: unknown; error?: { message?: string } }>(`${this.baseUrl}${path}`, {
      caller: 'admin',
      key: this.internalKey,
      method,
      ...(payload !== undefined ? { body: payload } : {}),
      timeoutMs,
      label: `worldsvc ${method} ${path}`,
    });
    if (!r.ok || r.body?.ok === false) {
      throw new Error(r.body?.error?.message ?? `${path} failed: ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    }
    return r.body?.data;
  }

  private post(path: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request('POST', path, payload, timeoutMs);
  }

  async openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.post('/admin/world/open', { worldId, season, shard, capacity }, HttpWorldClient.SEASON_OP_TIMEOUT_MS);
  }
  async settleWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/settle', { worldId }, HttpWorldClient.SEASON_OP_TIMEOUT_MS);
  }
  async resetWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/reset', { worldId }, HttpWorldClient.SEASON_OP_TIMEOUT_MS);
  }
  async closeWorld(worldId: string): Promise<void> {
    await this.post('/admin/world/close', { worldId }, HttpWorldClient.SEASON_OP_TIMEOUT_MS);
  }
  async mergeWorld(worldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }> {
    return (await this.post('/admin/world/merge', { worldId, targetWorldId }, HttpWorldClient.SEASON_OP_TIMEOUT_MS)) as {
      moved: number;
      failed: string[];
    };
  }

  private get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  private putOrDelete(method: 'PUT' | 'DELETE', path: string, payload?: Record<string, unknown>): Promise<unknown> {
    return this.request(method, path, payload);
  }

  // ── Map templates (§24 Layer A, admin map editor) ──
  async listMapTemplates(): Promise<MapTemplateSummary[]> {
    if (!this.baseUrl) return [];
    return (await this.get('/admin/world/map-templates')) as MapTemplateSummary[];
  }
  async generateMapTemplate(templateId: string, width: number, height: number): Promise<MapTemplateSummary> {
    return (await this.post('/admin/world/map-templates/generate', { templateId, width, height })) as MapTemplateSummary;
  }
  async getMapTemplateTiles(templateId: string, x: number, y: number, w: number, h: number): Promise<MapTemplateTile[]> {
    if (!this.baseUrl) return [];
    const qs = new URLSearchParams({ x: String(x), y: String(y), w: String(w), h: String(h) });
    return (await this.get(`/admin/world/map-templates/${encodeURIComponent(templateId)}/tiles?${qs}`)) as MapTemplateTile[];
  }
  async saveMapTemplateTiles(templateId: string, tiles: MapTemplateTile[]): Promise<{ updated: number }> {
    return (await this.putOrDelete('PUT', `/admin/world/map-templates/${encodeURIComponent(templateId)}/tiles`, { tiles })) as { updated: number };
  }
  async activateMapTemplate(templateId: string): Promise<void> {
    await this.post(`/admin/world/map-templates/${encodeURIComponent(templateId)}/activate`, {});
  }
  async deleteMapTemplate(templateId: string): Promise<void> {
    await this.putOrDelete('DELETE', `/admin/world/map-templates/${encodeURIComponent(templateId)}`);
  }
}
