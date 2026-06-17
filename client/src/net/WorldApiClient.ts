// WorldApiClient — SLG REST client for worldsvc (S8).
// Separate from ApiClient because worldsvc runs on a different base URL
// (getWorldBaseUrl()) and is NOT included in openapi.yml (metaserver contract).
//
// Auth: reads the JWT stored by SaveManager under key nw_token.
// All responses are wrapped in { ok: true, data: T } | { ok: false, code, message }.
//
// DTO types are generated from server/contracts/openapi-world.yml via npm run rest:gen
// → src/net/openapi-world.ts. Do NOT hand-edit these type aliases.

import { getWorldBaseUrl } from './config';
import type { IStorage } from '../platform/IPlatform';
import type { components } from './openapi-world';

// ── Generated DTO type aliases (single source of truth = openapi-world.yml) ──

export type WorldTileView = components['schemas']['WorldTileView'];
export type WorldMapView = components['schemas']['WorldMapView'];
export type PlayerWorldView = components['schemas']['PlayerWorldView'];
export type MarchView = components['schemas']['MarchView'];
export type FamilyMemberView = components['schemas']['FamilyMemberView'];
export type FamilyView = components['schemas']['FamilyView'];
export type FamilyMessageView = components['schemas']['FamilyMessageView'];
export type AuctionView = components['schemas']['AuctionView'];

// Derived enum types for method parameters
type MarchKind = Exclude<MarchView['kind'], 'return'>;
type FamilyRole = FamilyMemberView['role'];

const TOKEN_KEY = 'nw_token';

// ── Error ────────────────────────────────────────────────────────────────────

export class WorldApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorldApiError';
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

export class WorldApiClient {
  constructor(private readonly storage: IStorage) {}

  get available(): boolean {
    return getWorldBaseUrl() !== '' || this.storage.getItem('nw_world_base') !== null;
  }

  private token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const base = getWorldBaseUrl();
    const url = base + path;
    const token = this.token();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const json = await res.json() as { ok: boolean; data?: T; code?: string; message?: string };
    if (!json.ok) {
      throw new WorldApiError(json.code ?? 'UNKNOWN', json.message ?? 'world api error');
    }
    return json.data as T;
  }

  // ── World ──────────────────────────────────────────────────────────────────

  async getMe(worldId: string): Promise<PlayerWorldView> {
    return this.req('GET', `/world/me?worldId=${encodeURIComponent(worldId)}`);
  }

  async getMap(worldId: string, cx: number, cy: number, r: number): Promise<WorldMapView> {
    return this.req('GET', `/world/map?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}`);
  }

  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('GET', `/world/tile/${x}:${y}:${encodeURIComponent(worldId)}`);
  }

  async getMarches(worldId: string): Promise<MarchView[]> {
    return this.req('GET', `/world/march?worldId=${encodeURIComponent(worldId)}`);
  }

  async joinWorld(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/join', { worldId, x, y });
  }

  async occupyTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/occupy', { worldId, x, y });
  }

  async abandonTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/abandon', { worldId, x, y });
  }

  async startMarch(
    worldId: string,
    fromX: number, fromY: number,
    toX: number, toY: number,
    kind: MarchKind,
    troops: number,
  ): Promise<MarchView> {
    return this.req('POST', '/world/march', { worldId, fromX, fromY, toX, toY, kind, troops });
  }

  async recallMarch(marchId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/world/march/${encodeURIComponent(marchId)}/recall`, { worldId });
  }

  // ── Family ─────────────────────────────────────────────────────────────────

  async listFamilies(worldId: string): Promise<FamilyView[]> {
    return this.req('GET', `/family/list?worldId=${encodeURIComponent(worldId)}`);
  }

  async getFamily(familyId: string): Promise<FamilyView> {
    return this.req('GET', `/family/${encodeURIComponent(familyId)}`);
  }

  async createFamily(worldId: string, name: string, tag: string): Promise<FamilyView> {
    return this.req('POST', '/family/create', { worldId, name, tag });
  }

  async joinFamily(worldId: string, familyId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/join', { worldId, familyId });
  }

  async leaveFamily(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/leave', { worldId });
  }

  async kickMember(worldId: string, targetId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/kick', { worldId, targetId });
  }

  async setRole(worldId: string, targetId: string, role: FamilyRole): Promise<{ ok: true }> {
    return this.req('POST', '/family/role', { worldId, targetId, role });
  }

  async dissolveFamily(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/family/dissolve', { worldId });
  }

  async sendFamilyMessage(worldId: string, body: string, senderName?: string): Promise<{ id: string }> {
    return this.req('POST', '/family/message', { worldId, body, ...(senderName ? { senderName } : {}) });
  }

  async getFamilyChannel(
    worldId: string,
    familyId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<FamilyMessageView[]> {
    const params = new URLSearchParams({ worldId, familyId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/family/channel?${params}`);
  }

  // ── Auction ────────────────────────────────────────────────────────────────

  async listAuctions(
    worldId: string,
    opts?: { itemType?: string; limit?: number },
  ): Promise<AuctionView[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.itemType) params.set('itemType', opts.itemType);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/auction/list?${params}`);
  }

  async getMyListings(worldId: string): Promise<AuctionView[]> {
    return this.req('GET', `/auction/mine?worldId=${encodeURIComponent(worldId)}`);
  }

  async createAuction(
    worldId: string,
    itemType: 'material',
    item: Record<string, unknown>,
    qty: number,
    price: number,
    durationSec: number,
    designatedBuyerId?: string,
  ): Promise<AuctionView> {
    return this.req('POST', '/auction/create', {
      worldId, itemType, item, qty, price, durationSec,
      ...(designatedBuyerId ? { designatedBuyerId } : {}),
    });
  }

  async buyAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/buy`, { worldId });
  }

  async cancelAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/cancel`, { worldId });
  }
}
