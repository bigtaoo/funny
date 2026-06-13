// 浏览器二进制 WS（Web / CrazyGames 共用，S1-6）。微信另有 WechatGameSocket。
// 仅做「一次连接」的薄封装；重连/协议在 NetClient。
import type { IGameSocket, SocketHandlers } from '../platform/IPlatform';

export class BrowserGameSocket implements IGameSocket {
  private ws: WebSocket;

  constructor(url: string, handlers: SocketHandlers) {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(ev.data));
      // 文本帧（非协议）忽略
    };
    ws.onclose = (ev: CloseEvent) => handlers.onClose(ev.code, ev.reason);
    ws.onerror = (ev: Event) => handlers.onError(ev);
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    // 主动关闭：摘掉回调，避免触发 NetClient 的重连
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
