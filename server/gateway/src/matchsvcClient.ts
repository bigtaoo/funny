// gateway → matchsvc 内部 HTTP 客户端（S1-M5，matchsvc 拆为独立进程后）。
// 玩家控制命令解码后经此转发给 matchsvc；matchsvc 反向经 /gw/push 推事件回来（internalHttp.ts）。
// 全部 fire-and-forget——matchsvc 处理结果以异步 push 回到玩家，不在 HTTP 响应里返回房间态。
// 内部鉴权：X-Internal-Key（共用 NW_INTERNAL_KEY）。
//
// 这里的 PushMsg / PlayerView 是 matchsvc 同名类型的 JSON 镜像（跨进程的线契约是 JSON，
// 两侧各持结构相同的本地类型，与 REST/JSON 内部通信约定一致，见 META_DESIGN §6.7）。

export interface PlayerView {
  side: number;
  name: string;
  ready: boolean;
  connected: boolean;
}
export type PushMsg =
  | { kind: 'room_state'; code: string; players: PlayerView[]; phase: number }
  | { kind: 'match_found'; gameUrl: string; ticket: string }
  | { kind: 'room_error'; code: string; message: string };

export class MatchsvcClient {
  constructor(
    private readonly baseUrl: string | null, // 形如 http://matchsvc:8091（内部直连）
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  private post(path: string, body: Record<string, unknown>): void {
    if (!this.baseUrl) return;
    void fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
      body: JSON.stringify(body),
    }).catch(() => {
      /* 命令丢失：玩家可重试（建房/加入/开局均幂等于「再点一次」） */
    });
  }

  roomCreate(accountId: string, name: string): void {
    this.post('/mm/room/create', { accountId, name });
  }
  roomJoin(accountId: string, name: string, code: string): void {
    this.post('/mm/room/join', { accountId, name, code });
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
  enqueue(accountId: string, name: string, elo: number): void {
    this.post('/mm/queue/enqueue', { accountId, name, elo });
  }
  connected(accountId: string): void {
    this.post('/mm/conn/connected', { accountId });
  }
  disconnected(accountId: string): void {
    this.post('/mm/conn/disconnected', { accountId });
  }
}
