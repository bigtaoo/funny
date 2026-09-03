// EnvelopeSocket unit tests (envelopeSocket.ts). Until now this wrapper was only ever exercised
// through GatewayClient/GameServerClient's own suites, which drive it exclusively along the happy
// path — connect, receive, send while the socket is open. The three paths that only matter when
// something has already gone wrong were untested:
//
//   • connect() timing out on a peer that accepts the TCP connection but never completes the WS
//     handshake (a wedged gateway/gameserver, not a refused port) — the socket has to be
//     terminate()d, not just abandoned, or the half-open connection leaks for the process's lifetime;
//   • send() after the socket is gone — the caller is a lockstep loop that keeps submitting commands
//     for a few ticks after a drop, and ws throws on send() to a closed socket. That throw would
//     surface inside a WS 'message' handler and kill the whole fleet's process (see the file-header
//     note in battleSession.ts), so the readyState check is load-bearing, not decorative;
//   • close() being called twice — BotSession.logout() and playRankedMatch's own finish() both close,
//     and the second one must be a no-op.
//
// Real `ws` servers throughout (same shape as gameServerClient.test.ts) — a mocked socket would be
// asserting our own idea of readyState rather than the library's.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server as NetServer } from 'net';
import { WebSocketServer } from 'ws';
import { EnvelopeSocket, type EnvelopeSocketHandlers } from '../src/envelopeSocket';
import { Envelope } from '../src/generated/transport';

function listen(): Promise<{ wss: WebSocketServer; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address() as { port: number };
      resolve({ wss, url: `ws://127.0.0.1:${port}` });
    });
  });
}

/** A plain TCP listener that accepts and then says nothing — the WS handshake never completes. */
function listenSilently(): Promise<{ server: NetServer; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(() => {
      /* hold the connection open, never respond */
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `ws://127.0.0.1:${port}` });
    });
  });
}

function handlers(over: Partial<EnvelopeSocketHandlers> = {}): EnvelopeSocketHandlers {
  return { onServerMsg: vi.fn(), onClose: vi.fn(), onError: vi.fn(), ...over };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

let wss: WebSocketServer | undefined;
let netServer: NetServer | undefined;

afterEach(() => {
  wss?.close();
  wss = undefined;
  netServer?.close();
  netServer = undefined;
});

describe('EnvelopeSocket.connect', () => {
  it('resolves once the socket opens and delivers decoded server messages', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => {
      ws.send(Envelope.encode(Envelope.fromPartial({ server: { matchOver: { winnerSide: 0 } } })).finish());
    });

    const onServerMsg = vi.fn();
    const socket = await EnvelopeSocket.connect(listening.url, handlers({ onServerMsg }));
    await settle();

    expect(onServerMsg).toHaveBeenCalledTimes(1);
    expect(onServerMsg.mock.calls[0]![0].matchOver.winnerSide).toBe(0);
    socket.close();
  });

  it('drops a malformed frame instead of handing it to the caller', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => ws.send(Buffer.from([0xff, 0xff, 0xff, 0xff])));

    const onServerMsg = vi.fn();
    const socket = await EnvelopeSocket.connect(listening.url, handlers({ onServerMsg }));
    await settle();

    expect(onServerMsg).not.toHaveBeenCalled();
    socket.close();
  });

  it('terminates the half-open connection and rejects when the handshake never completes', async () => {
    const silent = await listenSilently();
    netServer = silent.server;

    await expect(EnvelopeSocket.connect(silent.url, handlers(), 40)).rejects.toThrow(
      `connect timeout: ${silent.url}`,
    );
  });

  it('rejects when nothing is listening at all', async () => {
    await expect(EnvelopeSocket.connect('ws://127.0.0.1:1', handlers())).rejects.toThrow();
  });

  it('reports a server-initiated close through onClose with its code', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => setTimeout(() => ws.close(4002), 5));

    const onClose = vi.fn();
    await EnvelopeSocket.connect(listening.url, handlers({ onClose }));
    await settle(60);

    expect(onClose).toHaveBeenCalledWith(4002);
  });
});

describe('EnvelopeSocket.send / close after the socket is gone', () => {
  it('drops a send() on a closed socket instead of throwing at the caller', async () => {
    const listening = await listen();
    wss = listening.wss;
    const received: Buffer[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer) => received.push(Buffer.from(data)));
      setTimeout(() => ws.close(4003), 5);
    });

    const onClose = vi.fn();
    const socket = await EnvelopeSocket.connect(listening.url, handlers({ onClose }));
    await settle(60);
    expect(onClose).toHaveBeenCalled(); // the socket really is gone before we send

    expect(() => socket.send({ cmdSubmit: { commands: new Uint8Array([1, 2]) } })).not.toThrow();
    await settle();
    expect(received).toHaveLength(0);
  });

  it('close() on an already-closed socket is a no-op (double-close is a normal teardown path)', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', () => undefined);

    const socket = await EnvelopeSocket.connect(listening.url, handlers());
    socket.close();
    await settle();
    expect(() => socket.close()).not.toThrow();
  });
});
