// metaserver REST 客户端（S0-5）。覆盖 S0 用到的端点：auth/device · auth/wx · GET/PUT save。
// 契约 = contracts/openapi.yml（统一响应包络 ApiResp<T>，乐观锁 If-Match）。
// 经济/盲盒（S2）随 EconomyClient 再加；此处只做云存档需要的部分。
//
// 传输用全局 fetch（Web / CrazyGames 原生支持）。微信小游戏无 fetch（用 wx.request）——
// 其云同步随微信联机合规一并排期；当前 SaveManager 在无 baseUrl / fetch 时退化为纯本地（离线优先）。

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch } from '../game/meta/SaveData';

type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface AuthResult {
  token: string;
  accountId: string;
  isNew: boolean;
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

  // ── save（S0-7）─────────────────────────────────────────
  /** 拉取当前账号云端存档。 */
  async getSave(): Promise<SaveData> {
    const data = await this.request<{ save: SaveData }>('GET', '/save');
    return data.save;
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

  // ── 内部 ────────────────────────────────────────────────
  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchRaw(method, path, body);
    const json = (await res.json()) as ApiResp<T>;
    if (!json.ok) {
      throw new ApiError(json.error.code, json.error.message);
    }
    return json.data;
  }

  private fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
