// 单条 WS 连接封装：绑 accountId、编码发送、心跳存活检测。
// 一个 account 同一时刻只允许一条活跃连接（重连时旧连接被顶替）。
import type { WebSocket } from 'ws';
import { encodeServer, type ServerMsg } from './proto/transport';

export class Connection {
  /** 当前所属房间 id（null = 在大厅）。 */
  roomId: string | null = null;
  /** 心跳：上一次 pong/ping 后置 true，巡检置 false，再次巡检仍 false 则判死。 */
  alive = true;

  constructor(
    readonly accountId: string,
    readonly ws: WebSocket,
  ) {}

  send(msg: ServerMsg): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(encodeServer(msg));
    } catch {
      // 写失败由 close 事件统一收口
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }
}
