// gateway → matchsvc 内部 HTTP 客户端（S1-M5，matchsvc 拆为独立进程后）。
// 玩家控制命令解码后经此转发给 matchsvc；matchsvc 反向经 /gw/push 推事件回来（internalHttp.ts）。
// 全部 fire-and-forget——matchsvc 处理结果以异步 push 回到玩家，不在 HTTP 响应里返回房间态。
// 内部鉴权：X-Internal-Key（共用 NW_INTERNAL_KEY）。
//
// 这里的 PushMsg / PlayerView 是 matchsvc 同名类型的 JSON 镜像（跨进程的线契约是 JSON，
// 两侧各持结构相同的本地类型，与 REST/JSON 内部通信约定一致，见 META_DESIGN §6.7）。

import { createLogger, internalHeaders } from '@nw/shared';

const log = createLogger('gateway:matchsvc');

export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** 9 位数字公开 id（玩家交流/投诉用；缺省空串）。 */
  publicId: string;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  // 匹配超时降级打 AI（feature flag match_bot_fallback）：客户端开本地 AI 局，无 ticket/gameUrl。
  | { kind: 'match_bot'; seed: number; opponentName: string; elo: number; difficulty: string }
  | { kind: 'room_error'; code: string; message: string }
  // —— 社交实时推送（S6，meta 经 /gw/push 调用，与 matchsvc 共用此通道）——
  | { kind: 'friend_presence'; publicId: string; online: boolean }
  | { kind: 'friend_request'; requestId: string; fromPublicId: string; fromName: string; message: string }
  | { kind: 'friend_update'; publicId: string; added: boolean }
  | { kind: 'chat_message'; convId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  | { kind: 'mail_new'; mailId: string; hasAttachment: boolean }
  // —— SLG 大世界实时推送（S8-2，worldsvc 经 /gw/push 调用，与 matchsvc/meta 共用此通道）——
  | {
      kind: 'march_update';
      marchId: string;
      marchKind: string;
      fromTile: string;
      toTile: string;
      arriveAt: number;
      status: string;
    }
  | {
      kind: 'tile_update';
      tileId: string;
      type: string;
      level: number;
      ownerId: string;
      familyId: string;
      protectedUntil: number;
    }
  | {
      kind: 'under_attack';
      tile: string;
      attackerName: string;
      attackerPublicId: string;
      arriveAt: number;
      troopsHint: number;
    }
  | {
      kind: 'siege_result';
      siegeId: string;
      tile: string;
      outcome: string;
      lootSummary: string;
      replayRef: string;
    }
  // 家族频道消息（S8-4，worldsvc 经 /gw/push 定向直推；≤30 人 O(n) 可接受）。
  | { kind: 'family_msg'; familyId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  // 宗门频道消息（S8-4b，worldsvc 经 Redis pub/sub 扇出 → gateway 据在线成员下发；≤900 人）。
  | { kind: 'sect_msg'; sectId: string; fromPublicId: string; fromName: string; body: string; ts: number }
  // 国家/世界公频（B7，worldsvc 经 Redis pub/sub 扇出 → gateway 据同 world 在线玩家下发）。
  | { kind: 'nation_msg'; worldId: string; fromPublicId: string; fromName: string; body: string; ts: number };

export class MatchsvcClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://matchsvc:8091（内部直连）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  private post(path: string, body: Record<string, unknown>): void {
    if (!this.baseUrl) {
      log.warn('matchsvc not configured: command dropped', { path });
      return;
    }
    void fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gateway', this.internalKey) },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) log.warn('matchsvc returned non-OK', { path, status: res.status });
      })
      .catch((e) => {
        // 命令丢失：玩家可重试（建房/加入/开局均幂等于「再点一次」），但联调期必须看见。
        log.error('matchsvc POST failed', { path, url: this.baseUrl, err: (e as Error).message });
      });
  }

  roomCreate(accountId: string, name: string, publicId: string, equippedTitle = ''): void {
    this.post('/mm/room/create', { accountId, name, publicId, equippedTitle });
  }
  roomJoin(accountId: string, name: string, publicId: string, code: string, equippedTitle = ''): void {
    this.post('/mm/room/join', { accountId, name, publicId, code, equippedTitle });
  }
  roomReady(accountId: string, ready: boolean): void {
    this.post('/mm/room/ready', { accountId, ready });
  }
  roomStart(accountId: string): void {
    this.post('/mm/room/start', { accountId });
  }
  roomLeave(accountId: string): void {
    this.post('/mm/room/leave', { accountId });
  }
  enqueue(accountId: string, name: string, publicId: string, elo: number, equippedTitle = ''): void {
    this.post('/mm/queue/enqueue', { accountId, name, publicId, elo, equippedTitle });
  }
  connected(accountId: string): void {
    this.post('/mm/conn/connected', { accountId });
  }
  disconnected(accountId: string): void {
    this.post('/mm/conn/disconnected', { accountId });
  }
}
