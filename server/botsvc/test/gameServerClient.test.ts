import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { GameServerClient } from '../src/gameServerClient';
import { Envelope, MatchMode } from '../src/generated/transport';
import { PlayerCommands } from '../src/generated/game';

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

const matchStartMsg = {
  roomId: 'room-1',
  mode: MatchMode.RANKED,
  seed: 42,
  startFrame: 0,
  localSide: 1,
  opponentName: 'opp',
  opponentPublicId: '123456789',
  opponentTitle: '',
  topDeck: ['card_a'],
  bottomDeck: ['card_b'],
};

describe('GameServerClient', () => {
  it('connects with ?ticket=, receives match_start then frame_batch, and can submit/report', async () => {
    const listening = await listen();
    wss = listening.wss;
    const received: Buffer[] = [];
    wss.on('connection', (ws, req) => {
      expect(req.url).toContain('ticket=tkt-1');
      ws.send(Envelope.encode(Envelope.fromPartial({ server: { matchStart: matchStartMsg } })).finish());
      ws.on('message', (data: Buffer) => received.push(Buffer.from(data)));
      setTimeout(() => {
        ws.send(
          Envelope.encode(
            Envelope.fromPartial({
              server: { frameBatch: { toFrame: 3, frames: [{ frame: 3, cmds: [{ side: 0, commands: new Uint8Array() }] }] } },
            }),
          ).finish(),
        );
      }, 10);
    });

    const onMatchStart = vi.fn();
    const onFrameBatch = vi.fn();
    const client = new GameServerClient();
    await client.connect(listening.url, 'tkt-1', {
      onMatchStart,
      onFrameBatch,
      onDisconnect: () => undefined,
    });
    expect(onMatchStart).toHaveBeenCalledWith(matchStartMsg);

    await new Promise((r) => setTimeout(r, 50));
    expect(onFrameBatch).toHaveBeenCalledTimes(1);
    expect(onFrameBatch.mock.calls[0]![0].toFrame).toBe(3);

    const cmdBytes = PlayerCommands.encode(PlayerCommands.fromPartial({ commands: [{ upgradeBase: {} }] })).finish();
    client.submitCmd(cmdBytes);
    client.reportResult('deadbeef', 1, '');
    await new Promise((r) => setTimeout(r, 20));

    const decoded = received.map((b) => Envelope.decode(new Uint8Array(b)));
    expect(decoded.some((e) => e.client?.cmdSubmit)).toBe(true);
    expect(decoded.some((e) => e.client?.matchResult?.stateHash === 'deadbeef')).toBe(true);

    client.close();
  });

  it('calls onDisconnect when the server closes mid-match', async () => {
    const listening = await listen();
    wss = listening.wss;
    wss.on('connection', (ws) => {
      ws.send(Envelope.encode(Envelope.fromPartial({ server: { matchStart: matchStartMsg } })).finish());
      setTimeout(() => ws.close(4000), 10);
    });

    const onDisconnect = vi.fn();
    const client = new GameServerClient();
    await client.connect(listening.url, 'tkt-1', {
      onMatchStart: () => undefined,
      onFrameBatch: () => undefined,
      onDisconnect,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(onDisconnect).toHaveBeenCalledWith(4000);
  });
});
