// 单条数据面 WS 连接封装（S1-M2）：绑 ticket 身份（roomId / side / accountId）、
// 编码发送、心跳存活检测。gameserver 瘦成纯帧中继——身份完全来自 matchsvc 签的
// ticket，gameserver 不查任何库（M16）。
import type { WebSocket } from 'ws';
import { encodeServer, type ServerMsg } from './proto/transport';

export class Connection {
  /** 心跳：上一次 pong/ping 后置 true，巡检置 false，再次巡检仍 false 则判死。 */
  alive = true;

  constructor(
    /** ticket.roomId —— 本连接所属对局。 */
    readonly roomId: string,
    /** ticket.side —— 本方阵营（0/1）。 */
    readonly side: 0 | 1,
    /** ticket.accountId —— 仅作局末上报 meta 的标识透传，gameserver 不读库。 */
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
