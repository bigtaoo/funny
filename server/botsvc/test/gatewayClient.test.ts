import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { GatewayClient } from '../src/gatewayClient';
import { Envelope, MatchMode } from '../src/generated/transport';

function listen(): Promise<{ wss: WebSocketServer; url: string }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address() as { port: number };
      resolve({ wss, url: `ws://127.0.0.1:${port}` });
    });
  });
}

let wss: WebSocketServer | undefined;

afterEach(() => {
  wss?.close();
  wss = undefined;
});

describe('GatewayClient.enqueueRanked', () => {
  it('sends room_create{mode:RANKED, deck} and resolves on match_found', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws, req) => {
      expect(req.url).toContain('token=test-jwt');
      ws.on('message', (data: Buffer) => {
        const env = Envelope.decode(new Uint8Array(data));
        expect(env.client?.roomCreate).toEqual({ mode: MatchMode.RANKED, deck: ['card_a', 'card_b'] });
        ws.send(
          Envelope.encode(
            Envelope.fromPartial({ server: { matchFound: { gameUrl: 'ws://game.example/ws', ticket: 'tkt-1' } } }),
          ).finish(),
        );
      });
    });

    const client = new GatewayClient();
    const found = await client.enqueueRanked(listening.url, 'test-jwt', ['card_a', 'card_b']);
    expect(found).toEqual({ gameUrl: 'ws://game.example/ws', ticket: 'tkt-1' });
  });

  it('rejects on room_error', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(
          Envelope.encode(
            Envelope.fromPartial({ server: { roomError: { code: 'ELO_UNAVAILABLE', message: 'meta down' } } }),
          ).finish(),
        );
      });
    });

    const client = new GatewayClient();
    await expect(client.enqueueRanked(listening.url, 'test-jwt', [])).rejects.toThrow(/ELO_UNAVAILABLE/);
  });

  it('rejects if the socket closes before match_found', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => {
      ws.on('message', () => ws.close());
    });

    const client = new GatewayClient();
    await expect(client.enqueueRanked(listening.url, 'test-jwt', [])).rejects.toThrow(/closed/);
  });

  it('rejects with a specific message on match_bot (queue-wait exceeded matchsvc\'s bot-fallback threshold)', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(
          Envelope.encode(
            Envelope.fromPartial({ server: { matchBot: { seed: 1, opponentName: 'AI', elo: 1000, difficulty: '5' } } }),
          ).finish(),
        );
      });
    });

    const client = new GatewayClient();
    await expect(client.enqueueRanked(listening.url, 'test-jwt', [])).rejects.toThrow(/bot-fallback/);
  });

  it('rejects on timeout when no server response ever arrives, and closes the socket', async () => {
    const listening = await listen();
    wss = listening.wss;
    let serverSideClosed = false;
    wss.on('connection', (ws) => {
      ws.on('message', () => {}); // never responds
      ws.on('close', () => { serverSideClosed = true; });
    });

    const client = new GatewayClient();
    await expect(client.enqueueRanked(listening.url, 'test-jwt', [], 30)).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSideClosed).toBe(true);
  });

  it('rejects immediately if the underlying connect itself fails (nothing listening)', async () => {
    const client = new GatewayClient();
    await expect(client.enqueueRanked('ws://127.0.0.1:1', 'test-jwt', [])).rejects.toThrow();
  });

  it('close() before any connection resolves is a no-op (no throw)', () => {
    const client = new GatewayClient();
    expect(() => client.close()).not.toThrow();
  });
});
