// WorldApiClient — SLG REST client for worldsvc (S8).
// Separate from ApiClient because worldsvc runs on a different base URL
// (getWorldBaseUrl()) and is NOT included in openapi.yml (metaserver contract).
//
// Auth: reads the JWT stored by SaveManager under key nw_token.
// All responses are wrapped in { ok: true, data: T } | { ok: false, code, message }.
//
// DTO types are generated from server/contracts/openapi-world.yml via npm run rest:gen
// → src/net/openapi-world.ts. Do NOT hand-edit these type aliases.

import { getWorldBaseUrl, getSocialBaseUrl } from './config';
import type { IStorage } from '../platform/IPlatform';
import type { components } from './openapi-world';

// ── Generated DTO type aliases (single source of truth = openapi-world.yml) ──

export type WorldTileView = components['schemas']['WorldTileView'];
export type WorldMapView = components['schemas']['WorldMapView'];

/** Sparse occupied tile (zoom 2/3 bird's-eye layer; contains only occupied tiles). */
export interface WorldTileSparseView {
  x: number;
  y: number;
  type: string;
  mine?: boolean;
  ally?: boolean;
  allySect?: boolean;
}

export interface WorldMapSparseView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  lod: 'thin' | 'mid';
  tiles: WorldTileSparseView[];
}
export type PlayerWorldView = components['schemas']['PlayerWorldView'];
export type MarchView = components['schemas']['MarchView'];
export type FamilyMemberView = components['schemas']['FamilyMemberView'];
export type FamilyView = components['schemas']['FamilyView'];
export type FamilyMessageView = components['schemas']['FamilyMessageView'];
export type AuctionView = components['schemas']['AuctionView'];
export type NationView = components['schemas']['NationView'];
export type SeasonView = components['schemas']['SeasonView'];
export type SlgShopItemView = components['schemas']['SlgShopItemView'];
export type SiegeReplayView = components['schemas']['SiegeReplayView'];
export type DefenseConfig = components['schemas']['DefenseConfig'];
export type TeamTemplate = components['schemas']['TeamTemplate'];
export type ArmyEntry = components['schemas']['ArmyEntry'];
export type SectView = components['schemas']['SectView'];
export type SectDetailView = components['schemas']['SectDetailView'];
export type SectMemberFamilyView = components['schemas']['SectMemberFamilyView'];
export type SectMessageView = components['schemas']['SectMessageView'];
export type SectVoteResult = components['schemas']['SectVoteResult'];
export type BuildingKey = components['schemas']['BuildingKey'];
export type CardSLGState = components['schemas']['CardSLGState'];

export interface WorldChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: number;
}

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
    // '' (Docker/prod same-origin proxy) and 'http://...' (dev explicit URL) are both valid
    // — worldsvc is reachable in any standard build. The old `!== ''` guard was wrong.
    return true;
  }

  /**
   * Ping worldsvc /health. Returns false ONLY on a definitive non-200 response
   * from a reachable server (e.g. 503 = up-but-unhealthy).
   *
   * A thrown fetch (timeout / CORS rejection / connection refused) is treated as
   * INCONCLUSIVE → returns true (no offline badge). Rationale: in dev the /health
   * route often lacks the CORS headers the real /world|/auction routes
   * carry, so the probe gets rejected even though the actual feature is fully
   * reachable — that false negative wrongly greyed the SLG World entry. Better to let
   * the user click through and hit real error handling than to mislabel a working
   * service as offline.
   */
  async checkHealth(): Promise<boolean> {
    const base = getWorldBaseUrl();
    // Empty base = same-origin nginx proxy (Docker/production). worldsvc is guaranteed
    // up by the Docker healthcheck; no external ping needed or possible (nginx only
    // routes /world* /auction* (family moved to socialsvc /social/family/*), not
    // /health). Return true immediately.
    if (!base) return true;
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(id);
      return res.ok;
    } catch {
      // Inconclusive — do not claim offline (see method doc).
      return true;
    }
  }

  private token(): string | null {
    return this.storage.getItem(TOKEN_KEY);
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
    baseOverride?: string,
  ): Promise<T> {
    const base = baseOverride ?? getWorldBaseUrl();
    const url = base + path;
    const token = this.token();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      // AbortError → convert to TypeError so callers see a consistent network failure.
      throw new TypeError(`world api ${method} ${path} failed: ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }

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

  /** Sparse occupied layer (zoom 2/3): returns only occupied tiles; no profile RPC, no visibility computation. */
  async getMapSparse(worldId: string, cx: number, cy: number, r: number, lod: 'thin' | 'mid'): Promise<WorldMapSparseView> {
    return this.req('GET', `/world/map/sparse?worldId=${encodeURIComponent(worldId)}&cx=${cx}&cy=${cy}&r=${r}&lod=${lod}`);
  }

  async getTile(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('GET', `/world/tile/${x}:${y}:${encodeURIComponent(worldId)}`);
  }

  async getMarches(worldId: string): Promise<MarchView[]> {
    return this.req('GET', `/world/march?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Enter the world: the system automatically places the player's city (§3.4; prefers near family → outer-ring newcomer zone); spawn point is server-determined, player does not pass coordinates. */
  async joinWorld(worldId: string): Promise<PlayerWorldView> {
    return this.req('POST', '/world/join', { worldId });
  }

  /** Return the current active SLG season number from worldsvc (§20.8). No auth required. */
  async getActiveSeason(): Promise<{ season: number }> {
    return this.req('GET', '/world/active-season');
  }

  /**
   * Resolve which shard this account should enter for the given season (G6/§20): resolve only, no city placement; returns the real worldId before entering the map (stickiness > family > solo random; overflow opens a new shard).
   */
  async resolveSeason(season: number): Promise<{ worldId: string }> {
    return this.req('POST', '/world/season/resolve', { season });
  }

  /**
   * Season join (G6/§20): server resolves the shard for this account (sect > family > solo random; overflow opens a new shard) then **automatically places the city** (§3.4).
   * The returned PlayerWorldView contains the resolved `worldId`; client uses it to enter the map. Player does not pass coordinates.
   */
  async joinSeason(season: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/season/join', { season });
  }

  async occupyTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/occupy', { worldId, x, y });
  }

  async abandonTile(worldId: string, x: number, y: number): Promise<{ ok: true }> {
    return this.req('POST', '/world/abandon', { worldId, x, y });
  }

  /** Actively relocate the player's base (costs RELOCATE_COST coins to move to (x,y)). Returns the updated player world state after relocation. */
  async relocateBase(worldId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/relocate', { worldId, x, y });
  }

  /** Build a watchtower (spend WATCHTOWER_COST resources on owned territory at (x,y) to create a large-radius persistent vision source; §18 G5 V2). Returns the tile view after construction. */
  async buildWatchtower(worldId: string, x: number, y: number): Promise<WorldTileView> {
    return this.req('POST', '/world/watchtower', { worldId, x, y });
  }

  async startMarch(
    worldId: string,
    fromX: number, fromY: number,
    toX: number, toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
  ): Promise<MarchView> {
    return this.req('POST', '/world/march', {
      worldId, fromX, fromY, toX, toY, kind, troops,
      ...(teamId ? { teamId } : {}),
    });
  }

  async recallMarch(marchId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/world/march/${encodeURIComponent(marchId)}/recall`, { worldId });
  }

  // ── Troops (training queue S8-2) ──────────────────────────────────────────────────

  /** Queue troop training (consumes ink + time). Returns the updated player state. */
  async trainTroops(worldId: string, qty: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/troops/train', { worldId, qty });
  }

  /** Speed up training with coins (deducted via the commercial service). */
  async speedupTraining(worldId: string, coins: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/troops/speedup', { worldId, coins });
  }

  // ── Defense (config embedded, S8-4) ────────────────────────────────────────

  /** Read the current defense config (pre-filled by the C3 editor). tileKey='base' for the main city or '{x}:{y}' for a territory tile; returns null if not set. */
  async getDefense(worldId: string, tileKey: string): Promise<DefenseConfig | null> {
    return this.req('GET', `/world/defense?worldId=${encodeURIComponent(worldId)}&tileKey=${encodeURIComponent(tileKey)}`);
  }

  /** Set or update the defense config. tileKey='base' for the main city or '{x}:{y}' for a territory tile. */
  async setDefense(worldId: string, tileKey: string, defenseConfig: DefenseConfig): Promise<{ ok: true }> {
    return this.req('PUT', '/world/defense', { worldId, tileKey, defenseConfig });
  }

  // ── Teams (attack formation templates, G3-2c) ─────────────────────────────────────────────

  /** Read the attack formation template list (pre-fills the team editor / march team selector). */
  async getTeams(worldId: string): Promise<TeamTemplate[]> {
    return this.req('GET', `/world/teams?worldId=${encodeURIComponent(worldId)}`);
  }

  /** Overwrite attack formation templates (pass the full set at once, max 5 teams). */
  async setTeams(worldId: string, teams: TeamTemplate[]): Promise<{ ok: true }> {
    return this.req('PUT', '/world/teams', { worldId, teams });
  }

  // ── Siege replay (spectator replay, G3-2c) ──────────────────────────────────────────

  /**
   * Fetch the replay level for a key siege (seed + LevelDefinition reconstructed from both armies). Readable by both attacker and defender.
   * Client uses the returned seed to headlessly re-run in siege mode with an empty ReplayInputSource → exact byte-for-byte reproduction.
   */
  async getSiegeReplay(worldId: string, siegeId: string): Promise<SiegeReplayView> {
    return this.req('GET', `/world/siege/${encodeURIComponent(siegeId)}/replay?worldId=${encodeURIComponent(worldId)}`);
  }

  // ── Nations (nation system S8-6.5) ───────────────────────────────────────────────

  async getNations(worldId: string): Promise<NationView[]> {
    return this.req('GET', `/world/nations?worldId=${encodeURIComponent(worldId)}`);
  }

  async setNationName(worldId: string, capitalIdx: number, name: string): Promise<{ ok: true }> {
    return this.req('POST', `/world/nations/${capitalIdx}/name`, { worldId, name });
  }

  // ── Season (S8-7) ──────────────────────────────────────────────────────

  async getSeason(worldId: string): Promise<SeasonView> {
    return this.req('GET', `/world/season?worldId=${encodeURIComponent(worldId)}`);
  }

  // ── SLG Shop (monetization S8-8) ────────────────────────────────────────────────────

  async getShopItems(): Promise<SlgShopItemView[]> {
    return this.req('GET', '/world/shop/items');
  }

  async buyShopItem(worldId: string, itemId: string): Promise<{ ok: true }> {
    return this.req('POST', '/world/shop/buy', { worldId, itemId });
  }

  // ── Family ─────────────────────────────────────────────────────────────────

  async listFamilies(): Promise<FamilyView[]> {
    const social = getSocialBaseUrl();
    try {
      const fam = await this.req<FamilyView>('GET', '/social/family/mine', undefined, 10_000, social);
      return fam ? [fam] : [];
    } catch (e) {
      if (e instanceof WorldApiError && e.code === 'NOT_FOUND') return [];
      throw e;
    }
  }

  async getFamily(familyId: string): Promise<FamilyView> {
    return this.req('GET', `/social/family/${encodeURIComponent(familyId)}`, undefined, 10_000, getSocialBaseUrl());
  }

  async createFamily(name: string, tag: string): Promise<FamilyView> {
    return this.req('POST', '/social/family', { name, tag }, 10_000, getSocialBaseUrl());
  }

  async joinFamily(familyId: string): Promise<{ ok: true }> {
    return this.req('POST', `/social/family/${encodeURIComponent(familyId)}/join`, {}, 10_000, getSocialBaseUrl());
  }

  async leaveFamily(): Promise<{ ok: true }> {
    return this.req('POST', '/social/family/leave', {}, 10_000, getSocialBaseUrl());
  }

  async kickMember(targetId: string): Promise<{ ok: true }> {
    return this.req('POST', '/social/family/kick', { targetId }, 10_000, getSocialBaseUrl());
  }

  async setRole(targetId: string, role: FamilyRole): Promise<{ ok: true }> {
    return this.req('POST', '/social/family/role', { targetId, role }, 10_000, getSocialBaseUrl());
  }

  async dissolveFamily(): Promise<{ ok: true }> {
    return this.req('POST', '/social/family/disband', {}, 10_000, getSocialBaseUrl());
  }

  async sendFamilyMessage(familyId: string, body: string, senderName?: string): Promise<{ id: string }> {
    return this.req('POST', `/social/family/${encodeURIComponent(familyId)}/messages`, { body, ...(senderName ? { senderName } : {}) }, 10_000, getSocialBaseUrl());
  }

  async getFamilyChannel(
    familyId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<FamilyMessageView[]> {
    const params = new URLSearchParams();
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params}` : '';
    return this.req('GET', `/social/family/${encodeURIComponent(familyId)}/messages${qs}`, undefined, 10_000, getSocialBaseUrl());
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

  /**
   * Create a listing. fixed mode: pass price (buy-now unit price); auction mode: pass saleMode='auction' + startPrice (opening unit price)
   * + optional buyoutPrice (buy-now floor unit price).
   */
  async createAuction(
    worldId: string,
    itemType: 'material' | 'equipment',
    item: Record<string, unknown>,
    qty: number,
    durationSec: number,
    opts?: {
      saleMode?: 'fixed' | 'auction';
      price?: number;
      startPrice?: number;
      buyoutPrice?: number;
      designatedBuyerId?: string;
    },
  ): Promise<AuctionView> {
    return this.req('POST', '/auction/create', {
      worldId, itemType, item, qty, durationSec,
      saleMode: opts?.saleMode ?? 'fixed',
      ...(opts?.price != null ? { price: opts.price } : {}),
      ...(opts?.startPrice != null ? { startPrice: opts.startPrice } : {}),
      ...(opts?.buyoutPrice != null ? { buyoutPrice: opts.buyoutPrice } : {}),
      ...(opts?.designatedBuyerId ? { designatedBuyerId: opts.designatedBuyerId } : {}),
    });
  }

  async buyAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/buy`, { worldId });
  }

  /** Place a bid (saleMode='auction'). amount = bid unit price; reaching or exceeding buyoutPrice closes the auction immediately. */
  async placeBid(auctionId: string, worldId: string, amount: number): Promise<AuctionView> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/bid`, { worldId, amount });
  }

  async cancelAuction(auctionId: string, worldId: string): Promise<{ ok: true }> {
    return this.req('POST', `/auction/${encodeURIComponent(auctionId)}/cancel`, { worldId });
  }

  // ── Sect (S8-4b) ────────────────────────────────────────────────────────

  async listSects(worldId: string): Promise<SectView[]> {
    return this.req('GET', `/sect/list?worldId=${encodeURIComponent(worldId)}`);
  }

  async getSect(sectId: string): Promise<SectDetailView> {
    return this.req('GET', `/sect/${encodeURIComponent(sectId)}`);
  }

  async createSect(worldId: string, name: string, tag: string): Promise<SectDetailView> {
    return this.req('POST', '/sect/create', { worldId, name, tag });
  }

  async joinSect(worldId: string, sectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/join', { worldId, sectId });
  }

  async leaveSect(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/leave', { worldId });
  }

  async dissolveSect(worldId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/dissolve', { worldId });
  }

  async allySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/ally', { worldId, targetSectId });
  }

  async unallySect(worldId: string, targetSectId: string): Promise<{ ok: true }> {
    return this.req('POST', '/sect/unally', { worldId, targetSectId });
  }

  async voteRemoveSectLeader(worldId: string, nomineeFamilyId: string): Promise<SectVoteResult> {
    return this.req('POST', '/sect/vote-remove-leader', { worldId, nomineeFamilyId });
  }

  async sendSectMessage(worldId: string, body: string, senderName?: string): Promise<SectMessageView> {
    return this.req('POST', '/sect/message', { worldId, body, ...(senderName ? { senderName } : {}) });
  }

  async getSectChannel(
    worldId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<SectMessageView[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/sect/channel?${params}`);
  }

  // ── World channel (nation/public chat, S6-4, 50 coins per message) ──────────────────────────────

  async getWorldChannel(
    worldId: string,
    opts?: { before?: number; limit?: number },
  ): Promise<WorldChatMessage[]> {
    const params = new URLSearchParams({ worldId });
    if (opts?.before) params.set('before', String(opts.before));
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/nation/channel?${params}`);
  }

  async sendWorldChannelMessage(
    worldId: string,
    body: string,
    senderName: string,
  ): Promise<WorldChatMessage> {
    return this.req('POST', '/nation/message', { worldId, body, senderName });
  }

  // ── City buildings (SLG_CITY_DESIGN P1) ──────────────────────────────────

  async upgradeBuilding(worldId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.req('POST', '/world/build/upgrade', { worldId, key });
  }

  async speedupBuild(worldId: string, key: BuildingKey, coins: number): Promise<PlayerWorldView> {
    return this.req('POST', '/world/build/speedup', { worldId, key, coins });
  }

  // ── CC-4: troop distribution and card recovery ────────────────────────────

  /**
   * Distribute troops from the base troop stock to card slots (CC-4, CHARACTER_CARDS_DESIGN §6.5).
   * allocations: cardInstanceId → troops to add. Server validates stock + troopCap per card.
   */
  async distributeTroops(
    worldId: string,
    allocations: Record<string, number>,
  ): Promise<{ ok: true }> {
    return this.req('POST', '/world/troops/distribute', { worldId, allocations });
  }

  /**
   * Spend coins to immediately recover an injured card (CC-4, CHARACTER_CARDS_DESIGN §7.2).
   * Clears injuredUntil for the card; unlocks the team if no remaining injuries.
   * Insufficient coins → WorldApiError('INSUFFICIENT_FUNDS').
   */
  async recoverCard(worldId: string, cardInstanceId: string): Promise<{ ok: true }> {
    return this.req('POST', '/world/troops/recover', { worldId, cardInstanceId });
  }
}
