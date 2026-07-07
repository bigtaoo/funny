import { internalHeaders, type MapTemplateSummary, type MapTemplateTile } from '@nw/shared';

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

  async listWorlds(): Promise<SlgWorldSummary[]> {
    if (!this.baseUrl) return [];
    const res = await fetch(`${this.baseUrl}/admin/world/list`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new Error(`listWorlds failed: HTTP ${res.status}`);
    const body = (await res.json()) as { ok?: boolean; data?: SlgWorldSummary[] };
    return body.data ?? [];
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
  }

  async openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.post('/admin/world/open', { worldId, season, shard, capacity });
  }
  async settleWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/settle', { worldId });
  }
  async resetWorld(worldId: string): Promise<unknown> {
    return this.post('/admin/world/reset', { worldId });
  }
  async closeWorld(worldId: string): Promise<void> {
    await this.post('/admin/world/close', { worldId });
  }

  private async get(path: string): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, { headers: internalHeaders('admin', this.internalKey) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
  }

  private async putOrDelete(method: 'PUT' | 'DELETE', path: string, payload?: Record<string, unknown>): Promise<unknown> {
    if (!this.baseUrl) throw new Error('worldsvc not configured');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: { message?: string } };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error?.message ?? `${path} failed: HTTP ${res.status}`);
    }
    return body.data;
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
