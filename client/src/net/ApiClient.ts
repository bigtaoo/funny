// metaserver REST 客户端（S0-5）。覆盖 S0 用到的端点：auth/device · auth/wx · GET/PUT save。
// 契约 = contracts/openapi.yml（统一响应包络 ApiResp<T>，乐观锁 If-Match）。
// 经济/盲盒（S2）随 EconomyClient 再加；此处只做云存档需要的部分。
//
// 传输用全局 fetch（Web / CrazyGames 原生支持）。微信小游戏无 fetch（用 wx.request）——
// 其云同步随微信联机合规一并排期；当前 SaveManager 在无 baseUrl / fetch 时退化为纯本地（离线优先）。

import type { AuthCredential } from '../platform/IPlatform';
import type { SaveData, SyncPatch } from '../game/meta/SaveData';
import type { components, operations } from './openapi';
import { netLog } from './log';

const log = netLog('api');

// ── Wire DTOs：从 openapi.yml codegen（contracts 单一来源，`npm run rest:gen`）取，
//    契约漂移在 tsc 时暴露。SaveData/SyncPatch/Rarity 仍用客户端自有 meta 镜像（域类型，
//    刻意手维护）；纯线协议 DTO（shop/gacha/auth/history）这里 alias 生成 schema。
type Schemas = components['schemas'];

export type ShopItem = Schemas['ShopItem'];
export type GachaPool = Schemas['GachaPool'];
export type GachaEntry = GachaPool['entries'][number];
export type GachaResultEntry = Schemas['GachaResult'];
/** 对战历史一条（从当前账号视角）。 */
export type MatchHistoryEntry = Schemas['MatchHistoryEntry'];
export type AuthResult = Schemas['AuthResult'];
// —— 社交（S6-1 好友 / S6-2 私聊 / S6-3 邮件）——
export type ProfileView = Schemas['ProfileView'];
export type FriendView = Schemas['FriendView'];
export type FriendRequestView = Schemas['FriendRequestView'];
export type ConversationView = Schemas['ConversationView'];
export type ChatMessageView = Schemas['ChatMessageView'];
export type MailView = Schemas['MailView'];
export type MailAttachmentView = Schemas['MailAttachmentView'];
/** 离线红点聚合（申请 / 未读会话 / 未读邮件 + total），登录后拉一次。 */
export type SocialBadges = Schemas['SocialBadges'];
/** 服务端持久化录像（opaque 帧，base64）；客户端用 net/serverReplay 解码回放。 */
export type ServerReplay = Schemas['MatchReplay'];
// —— 成就系统（S9-5）——
/** 成就定义（硬编码 @nw/shared，服务端下发；客户端据此 + stats 本地算阶）。 */
export type Achievement = Schemas['Achievement'];
/** GET /achievements 回包：定义表 + 我的 stats + 已领进度。 */
export type AchievementsView =
  operations['getAchievements']['responses']['200']['content']['application/json']['data'];

type ApiResp<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

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

  // ── PvE 服务器权威（PVE_INTEGRITY_PLAN §8，需登录 token）─────────────
  // progress/stars/materials/pveUpgrades 是服务器权威段；通关/升级走这两个端点，
  // 回推完整权威 SaveData（客户端 adopt 镜像）。仅在线可调。

  /**
   * PvE 通关结算：服务器校验解锁 → 每日上限内发材料 → 写 progress/stars → 回推。
   * L1 抽检（§8.6 第 3 步）：被抽中时回 `needsReplay + verifyId`（材料暂扣），调用方补传录像走
   * {@link pveVerify} 复算入账。`pveUpgrades` 是客户端开局蓝图快照（L0 异常判定，与服务器权威对比）。
   */
  async pveClear(
    levelId: string,
    stars: number,
    pveUpgrades?: Record<string, number>,
  ): Promise<{
    save: SaveData;
    granted: Record<string, number>;
    capped: boolean;
    needsReplay?: boolean;
    verifyId?: string;
  }> {
    return this.post<{
      save: SaveData;
      granted: Record<string, number>;
      capped: boolean;
      needsReplay?: boolean;
      verifyId?: string;
    }>('/pve/clear', { levelId, stars, ...(pveUpgrades ? { pveUpgrades } : {}) });
  }

  /** L1 录像抽检复算：补传被抽中通关的录像帧 → 第三方无头复算 → 复算星数 ≥ 声称才发材料。 */
  async pveVerify(
    verifyId: string,
    endFrame: number,
    frames: { frame: number; cmds: { side: number; commands: string }[] }[],
  ): Promise<{ save: SaveData; granted: Record<string, number>; capped: boolean; verified: boolean }> {
    return this.post<{
      save: SaveData;
      granted: Record<string, number>;
      capped: boolean;
      verified: boolean;
    }>('/pve/verify', { verifyId, endFrame, frames });
  }

  /**
   * @deprecated S3-2 per-stat 升级。S12 起单位养成走集卡合成（{@link pveMerge}）。
   * PvE 升级：服务器校验材料 → 扣材料 + pveUpgrades+1 → 回推。材料不足 → ApiError('INSUFFICIENT_FUNDS')（402）。
   */
  async pveUpgrade(upgradeId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/pve/upgrade', { upgradeId });
  }

  /**
   * 单位养成合成（S12）：服务器校验库存 → 消耗 5 张 N 级卡 → +1 张 N+1 → 重算 unitLevels → 回推。
   * 卡片不足 → ApiError('INSUFFICIENT_FUNDS')（402）；非法兵种/等级 → ApiError('BAD_REQUEST')（400）。
   */
  async pveMerge(unitId: string, level: number): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>('/pve/merge', { unitId, level });
  }

  /** 最近对战历史（ranked / friendly，按时间倒序；需登录 token）。 */
  async getMatchHistory(limit = 20): Promise<MatchHistoryEntry[]> {
    const data = await this.request<{ matches: MatchHistoryEntry[] }>(
      'GET',
      `/match/history?limit=${limit}`,
    );
    return data.matches;
  }

  /** 取某局服务端录像（仅本人参与；opaque 帧，交 net/serverReplay 解码回放）。404 → ApiError。 */
  async getMatchReplay(roomId: string): Promise<ServerReplay> {
    const data = await this.request<{ replay: ServerReplay }>(
      'GET',
      `/match/${encodeURIComponent(roomId)}/replay`,
    );
    return data.replay;
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

  // ── 成就（S9-5，需登录 token）────────────────────────────
  /** 成就定义表 + 我的 stats + 已领进度；客户端本地算阶（ACHIEVEMENT_DESIGN §6）。 */
  async getAchievements(): Promise<AchievementsView> {
    return this.request<AchievementsView>('GET', '/achievements');
  }

  /** 领取某成就某阶金币：服务器二次校验 stat≥阈值 + 幂等发币 → 回推权威存档 + 本次发放数。 */
  async claimAchievement(achId: string, tier: number): Promise<{ save: SaveData; granted: number }> {
    return this.post<{ save: SaveData; granted: number }>('/achievements/claim', { achId, tier });
  }

  // ── 社交：好友（S6-1，需登录 token）。发送/拉取走 REST，实时事件经 gateway push（NetSession）。──
  /** 好友列表（含在线态）。 */
  async getFriends(): Promise<FriendView[]> {
    const data = await this.request<{ friends: FriendView[] }>('GET', '/friends');
    return data.friends;
  }

  /** 待处理好友申请（收到 + 发出）。 */
  async getFriendRequests(): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    return this.request<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }>(
      'GET',
      '/friends/requests',
    );
  }

  /** 离线红点聚合（SOC8）：登录后一次性拉总未读红点，之后凭 social push 增量更新。 */
  async getSocialBadges(): Promise<SocialBadges> {
    return this.request<SocialBadges>('GET', '/social/badges');
  }

  /** 按 9 位公开 id 搜索玩家。未找到 → ApiError('NOT_FOUND')（404）。 */
  async searchFriend(publicId: string): Promise<ProfileView> {
    const data = await this.post<{ profile: ProfileView }>('/friends/search', { publicId });
    return data.profile;
  }

  /**
   * 发好友申请。已是好友 → ApiError('ALREADY_FRIEND')；超上限 → 'FRIEND_CAP_REACHED'；
   * 被拉黑 → 'BLOCKED'；目标不存在 → 'NOT_FOUND'。
   */
  async requestFriend(publicId: string, message?: string): Promise<string> {
    const data = await this.post<{ requestId: string }>('/friends/request', {
      publicId,
      ...(message ? { message } : {}),
    });
    return data.requestId;
  }

  /** 同意 / 拒绝好友申请（accept=true → 建双向边）。 */
  async respondFriend(requestId: string, accept: boolean): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/respond', { requestId, accept });
  }

  /** 删好友（双向）。 */
  async removeFriend(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/${encodeURIComponent(publicId)}`);
  }

  /** 拉黑（删好友 + 屏蔽申请/私聊）。 */
  async blockUser(publicId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/friends/block', { publicId });
  }

  /** 取消拉黑。 */
  async unblockUser(publicId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/friends/block/${encodeURIComponent(publicId)}`);
  }

  // ── 社交：私聊（S6-2，需登录 token）。发送走 REST，收消息经 gateway push（NetSession）。──
  /** 会话列表（含各自未读数 + 末条摘要）。 */
  async getConversations(): Promise<ConversationView[]> {
    const data = await this.request<{ conversations: ConversationView[] }>('GET', '/chat/conversations');
    return data.conversations;
  }

  /** 拉会话历史（按时间倒序分页）。`before`=游标（epoch ms，取更早的）。 */
  async getMessages(convId: string, before?: number, limit = 30): Promise<ChatMessageView[]> {
    const qs = `?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`;
    const data = await this.request<{ messages: ChatMessageView[] }>(
      'GET',
      `/chat/${encodeURIComponent(convId)}/messages${qs}`,
    );
    return data.messages;
  }

  /** 发私聊。非好友 → ApiError('NOT_FRIEND')；被拉黑 → 'BLOCKED'；限流 → 'RATE_LIMITED'（429）。 */
  async sendChat(toPublicId: string, body: string): Promise<{ messageId: string; ts: number }> {
    return this.post<{ messageId: string; ts: number }>('/chat/send', { toPublicId, body });
  }

  /** 标记会话已读（清未读计数）。 */
  async readChat(convId: string): Promise<void> {
    await this.post<{ ok: boolean }>('/chat/read', { convId });
  }

  // ── 社交：邮件（S6-3，需登录 token）。领取经 commercial + inventory，回推权威存档。──
  /** 收件箱（邮件列表 + 未读数）。 */
  async getMail(): Promise<{ mail: MailView[]; unread: number }> {
    return this.request<{ mail: MailView[]; unread: number }>('GET', '/mail');
  }

  /** 标记邮件已读。 */
  async readMail(mailId: string): Promise<void> {
    await this.post<{ ok: boolean }>(`/mail/${encodeURIComponent(mailId)}/read`, {});
  }

  /** 领取附件（发金币/物品，幂等）→ 回推权威存档。已领 → ApiError('ALREADY_CLAIMED')；无附件 → 'NO_ATTACHMENT'。 */
  async claimMail(mailId: string): Promise<{ save: SaveData }> {
    return this.post<{ save: SaveData }>(`/mail/${encodeURIComponent(mailId)}/claim`, {});
  }

  /** 删除邮件。 */
  async deleteMail(mailId: string): Promise<void> {
    await this.request<{ ok: boolean }>('DELETE', `/mail/${encodeURIComponent(mailId)}`);
  }

  /** 玩家间发邮件（门控为好友，无附件）。非好友 → ApiError('NOT_FRIEND')。 */
  async sendMail(toPublicId: string, subject: string, body: string): Promise<string> {
    const data = await this.post<{ mailId: string }>('/mail/send', { toPublicId, subject, body });
    return data.mailId;
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
