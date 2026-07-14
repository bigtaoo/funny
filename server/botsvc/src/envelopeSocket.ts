// Thin Node `ws` wrapper shared by gatewayClient/gameServerClient: connect, send one ClientMsg per
// frame (Envelope-wrapped), decode inbound frames back to ServerMsg. Deliberately has no reconnect
// logic (unlike client/src/net/NetClient.ts) — a bot's battle session treats any drop as match
// failure and falls back to lobby_idle next scheduler tick; retrying mid-match would desync lockstep.
import WebSocket from 'ws';
import { decodeServerMsg, encodeEnvelope } from './protoCodec';
import type { ClientMsg, ServerMsg } from './generated/transport';

export interface EnvelopeSocketHandlers {
  onServerMsg(msg: ServerMsg): void;
  onClose(code: number): void;
  onError(err: Error): void;
}

export class EnvelopeSocket {
  private constructor(private readonly ws: WebSocket) {}

  static connect(url: string, handlers: EnvelopeSocketHandlers, timeoutMs = 10_000): Promise<EnvelopeSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`connect timeout: ${url}`));
      }, timeoutMs);

      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new EnvelopeSocket(ws));
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('message', (data: Buffer) => {
        const msg = decodeServerMsg(new Uint8Array(data));
        if (msg) handlers.onServerMsg(msg);
      });
      ws.on('close', (code: number) => handlers.onClose(code));
      ws.on('error', (err: Error) => handlers.onError(err));
    });
  }

  send(client: ClientMsg): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeEnvelope(client));
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}
