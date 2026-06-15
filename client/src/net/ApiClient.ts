// metaserver REST 客户端（S0-5）。覆盖 S0 用到的端点：auth/device · auth/wx · GET/PUT save。
// 契约 = contracts/openapi.yml（统一响应包络 ApiResp<T>，乐观锁 If-Match）。
// 经济/盲盒（S2）随 EconomyClient 再加；此处只做云存档需要的部分。
//
// 传输用全局 fetch（Web / CrazyGames 原生支持）。微信小游戏无 fetch（用 wx.request）——
// 其云同步随微信联机合规一并排期；当前 SaveManager 在无 baseUrl / fetch 时退化为纯本地（离线优先）。

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch, Rarity } from '../game/meta/SaveData';
import { netLog } from './log';

const log = netLog('api');

// ── Economy DTOs (S2; mirror contracts/openapi.yml shop/gacha schemas) ──────────

export interface ShopItem {
  id: string;
  cost: number;
  kind: string;
  grants?: string;
}

export interface GachaEntry {
  itemId: string;
  weight: number;
  rarity: Rarity;
}

export interface GachaPool {
  id: string;
  costSingle: number;
  costTen?: number;
  pityThreshold?: number;
  dupePolicy?: string;
  entries: GachaEntry[];
}

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
  duplicate: boolean;
  converted?: { kind: string; amount: number };
}

type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface AuthResult {
  token: string;
  accountId: string;
  isNew: boolean;
  /** 仅 device、无可恢复凭证 → true。联机/商店/充值要求 false（SA-1）。 */
  isAnonymous: boolean;
  /** 注册时填的展示名（可选）；客户端用于个人资料显示。 */
  displayName?: string;
  /** 9 位数字公开 id（玩家交流/投诉用；accountId 仅服务器内部标识）。 */
  publicId?: string;
  /**
   * gateway 公开控制面 WS 地址（房间/匹配），由服务器下发。客户端只硬编码 meta 地址，
   * gateway 地址走这里、game 地址走 match_found——都实时获取，不静态配置。未配置则缺省。
   */
  gatewayUrl?: string;
}

/** PUT /save 结果：成功回推规范化存档，或 409 冲突带当前云端值。 */
export type PushResult =
  | { kind: 'ok'; save: SaveData }
  | { kind: 'conflict'; save: SaveData };

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private token: string | null = null;

  /** @param baseUrl 形如 https://host/api（无尾斜杠）。 */
  constructor(private readonly baseUrl: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  // ── auth（S0-4 / S0-7）──────────────────────────────────
  /** 用平台匿名凭据换 token + accountId；成功后自动持有 token。 */
  async auth(cred: AuthCredential): Promise<AuthResult> {
    const path = cred.kind === 'wx' ? '/auth/wx' : '/auth/device';
    const body = cred.kind === 'wx' ? { code: cred.code } : { deviceId: cred.deviceId };
    const data = await this.post<AuthResult>(path, body);
    this.token = data.token;
    return data;
  }

  // ── 密码账号（SA-1）─────────────────────────────────────
  /** 密码注册（新账号）；成功后自动持有 token。 */
  async register(loginId: string, password: string, displayName?: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/register', {
      loginId,
      password,
      ...(displayName ? { displayName } : {}),
    });
    this.token = data.token;
    return data;
  }

  /** 密码登录；成功后自动持有 token。 */
  async login(loginId: string, password: string): Promise<AuthResult> {
    const data = await this.post<AuthResult>('/auth/login', { loginId, password });
    this.token = data.token;
    return data;
  }

  /** 改密（需已登录，token 已持有）。 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.post<{ ok: true }>('/auth/password/change', { oldPassword, newPassword });
  }

  // ── save（S0-7）─────────────────────────────────────────
  /** 拉取当前账号云端存档（顺带回带账号展示名 + 公开 id + gateway 地址，供个人资料 / 联机）。 */
  async getSave(): Promise<{ save: SaveData; displayName?: string; publicId?: string; gatewayUrl?: string }> {
    const data = await this.request<{
      save: SaveData;
      displayName?: string;
      publicId?: string;
      gatewayUrl?: string;
    }>('GET', '/save');
    return {
      save: data.save,
      displayName: data.displayName,
      publicId: data.publicId,
      gatewayUrl: data.gatewayUrl,
    };
  }

  /** 改展示名（消耗金币）。回推权威存档 + 新展示名；余额不足 → ApiError('INSUFFICIENT_FUNDS')。 */
  async rename(displayName: string): Promise<{ save: SaveData; displayName: string }> {
    return this.post<{ save: SaveData; displayName: string }>('/profile/rename', { displayName });
  }

  /**
   * 推送客户端同步段，带乐观锁 If-Match: rev。
   * 200 → ok + 规范化存档；409 → conflict + 当前云端值（不抛错，交调用方 pull-merge）。
   */
  async putSave(rev: number, patch: SyncPatch): Promise<PushResult> {
    const res = await this.fetchRaw('PUT', '/save', { save: patch }, { 'If-Match': String(rev) });
    const json = (await res.json()) as ApiResp<{ save: SaveData }> & { save?: SaveData };
    if (res.status === 409) {
      // 409 包络：{ ok:false, error, save: 当前云端值 }
      if (json.save) return { kind: 'conflict', save: json.save };
      throw new ApiError('REV_CONFLICT', 'rev conflict without server save');
    }
    if (!json.ok) {
      throw new ApiError(json.error.code, json.error.message);
    }
    return { kind: 'ok', save: json.data.save };
  }

  // ── 经济：商店 / 盲盒 / 广告 / 充值（S2，需登录 token）────────────
  // 所有花币动作返回服务器回推的权威 SaveData（钱包/库存以服务器为准）。
  // 余额不足 → ApiError('INSUFFICIENT_FUNDS')（402）；票据无效 → ApiError('INVALID_RECEIPT')（400）。

  /** 商品列表（catalog 单一来源在服务端 @nw/shared）。 */
  async getShopItems(): Promise<ShopItem[]> {
    const data = await this.request<{ items: ShopItem[] }>('GET', '/shop/items');
    return data.items;
  }

  /** 直购：扣币 → 发货 → 回推权威存档。 */
  async shopBuy(itemId: string): Promise<{ save: SaveData; granted: string }> {
    return this.post<{ save: SaveData; granted: string }>('/shop/buy', { itemId });
  }

  /** 盲盒池列表（含展开 entries 供展示）。 */
  async getGachaPools(): Promise<GachaPool[]> {
    const data = await this.request<{ pools: GachaPool[] }>('GET', '/gacha/pools');
    return data.pools;
  }

  /** 抽卡（单抽 / 十连，原子，逐抽落库）。 */
  async gachaDraw(
    poolId: string,
    count: 1 | 10,
  ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
    return this.post<{ save: SaveData; results: GachaResultEntry[] }>('/gacha/draw', {
      poolId,
      count,
    });
  }

  /** 广告奖励（每日 cap；超限 → ApiError('DAILY_CAP_REACHED')，429）。 */
  async adsReward(adToken: string): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/ads/reward', { adToken });
  }

  /** 充值验单（票据幂等）。当前服务端 dev 桩：platform/receipt 任意非空即按档发币。 */
  async iapVerify(
    platform: string,
    receipt: string,
  ): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/iap/verify', { platform, receipt });
  }

  // ── 内部 ────────────────────────────────────────────────
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchRaw(method, path, body);
    const json = (await res.json()) as ApiResp<T>;
    if (!json.ok) {
      log.error(`${method} ${path} -> ${res.status} ${json.error.code}`, json.error.message);
      throw new ApiError(json.error.code, json.error.message);
    }
    log.info(`${method} ${path} -> ${res.status} ok`);
    return json.data;
  }

  private async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    log.debug(`${method} ${path}`);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // 网络层失败（服务器没起 / CORS / DNS）：fetch reject 在 console 里很笼统，这里点名 URL。
      log.error(`${method} ${path} network failure`, { url: `${this.baseUrl}${path}`, err: String(e) });
      throw e;
    }
  }
}
