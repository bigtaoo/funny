// Binary WebSocket for browsers (shared by Web / CrazyGames, S1-6). WeChat uses WechatGameSocket instead.
// Thin wrapper for a single connection; reconnection and protocol handling live in NetClient.
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
      // Text frames (non-protocol) are ignored
    };
    ws.onclose = (ev: CloseEvent) => handlers.onClose(ev.code, ev.reason);
    ws.onerror = (ev: Event) => handlers.onError(ev);
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    // Intentional close: detach callbacks to avoid triggering NetClient's reconnection logic
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
