// matchsvc → gateway 反向推送（S1-M5）。matchsvc 是私有大脑、不持玩家连接，
// 异步事件（room_state / match_found / room_error）经此 HTTP POST 回 gateway 的 /gw/push，
// 由 gateway 据 accountId 找到玩家 socket 下发。单 gateway 实例：一个固定地址即可；
// 多 gateway 横扩时此处需按 account→gateway 实例路由（Redis，留后续，见 META_DESIGN §6.7）。
//
// 内部鉴权：X-Internal-Key（共用 NW_INTERNAL_KEY）。fire-and-forget——玩家离线 / gateway 抖动
// 时丢弃即可（房间态是最新快照，下次变更会重发；match_found 丢失则玩家停在房间，可重试开局）。
import { createLogger, internalHeaders } from '@nw/shared';
import type { PushMsg } from './Matchsvc';

const log = createLogger('matchsvc:gw');

export class GatewayClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://gateway:8090（内部直连，无公网）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  readonly push = (accountId: string, msg: PushMsg, roomId?: string): void => {
    if (!this.baseUrl) {
      log.warn('gateway push not configured: event dropped', { accountId, kind: msg.kind, roomId });
      return;
    }
    void fetch(`${this.baseUrl}/gw/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('matchsvc', this.internalKey) },
      body: JSON.stringify({ accountId, msg, roomId }),
    })
      .then((res) => {
        if (!res.ok) log.warn('gateway push non-OK', { accountId, kind: msg.kind, roomId, status: res.status });
      })
      .catch((e) => {
        // 下次状态变更会重发；离线玩家本就该丢弃。联调期 match_found 丢失会卡「搜索中」，必须看见。
        log.error('gateway push failed', {
          accountId,
          kind: msg.kind,
          roomId,
          url: this.baseUrl,
          err: (e as Error).message,
        });
      });
  };
}
