// NetClient <-> rate gate wiring (ADR-058). Mocks ../src/net/rateGate entirely (separate module
// registry from net-client.test.ts, so this mock never leaks into the connect/reconnect suite) so
// the exact contract can be asserted deterministically, independent of the real token bucket's
// timing — that's covered on its own in rate-gate.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGameSocket, IPlatform, SocketHandlers } from '../src/platform/IPlatform';

vi.mock('../src/net/rateGate', () => ({
  globalRequestGate: { tryAcquire: vi.fn(), acquire: vi.fn() },
}));

import { NetClient } from '../src/net/NetClient';
import { globalRequestGate } from '../src/net/rateGate';

class FakeSocket implements IGameSocket {
  sent: Uint8Array[] = [];
  closed = false;
  constructor(readonly h: SocketHandlers) {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  open(): void { this.h.onOpen(); }
}

function fakePlatform(): { platform: IPlatform; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const platform = {
    connectSocket(_url: string, h: SocketHandlers): IGameSocket {
      const s = new FakeSocket(h);
      sockets.push(s);
      return s;
    },
  } as unknown as IPlatform;
  return { platform, sockets };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Connects and opens a client, ready to send. */
async function openClient(): Promise<{ client: NetClient; sockets: FakeSocket[] }> {
  const { platform, sockets } = fakePlatform();
  const client = new NetClient(platform, {
    url: 'ws://x/ws',
    tokenProvider: async () => 'tok',
    pingIntervalMs: 0,
    handlers: { onServerMsg: () => {} },
  });
  client.connect();
  await tick();
  sockets[0]!.open();
  return { client, sockets };
}

beforeEach(() => {
  vi.mocked(globalRequestGate.tryAcquire).mockReset().mockReturnValue(true);
  vi.mocked(globalRequestGate.acquire).mockReset().mockResolvedValue(undefined);
});

describe('NetClient — rate-limited-exempt messages (latency-sensitive)', () => {
  it('ping never touches the rate gate', async () => {
    const { client, sockets } = await openClient();
    client.ping();
    expect(globalRequestGate.tryAcquire).not.toHaveBeenCalled();
    expect(globalRequestGate.acquire).not.toHaveBeenCalled();
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it('submitCmd never touches the rate gate', async () => {
    const { client, sockets } = await openClient();
    client.submitCmd(new Uint8Array([1, 2, 3]));
    expect(globalRequestGate.tryAcquire).not.toHaveBeenCalled();
    expect(globalRequestGate.acquire).not.toHaveBeenCalled();
    expect(sockets[0]!.sent).toHaveLength(1);
  });
});

describe('NetClient — rate-limited messages (lobby/room actions)', () => {
  it('sends synchronously (same tick) when tryAcquire grants a token', async () => {
    const { client, sockets } = await openClient();
    client.joinRoom('ABC234');
    expect(globalRequestGate.tryAcquire).toHaveBeenCalledTimes(1);
    expect(globalRequestGate.acquire).not.toHaveBeenCalled();
    expect(sockets[0]!.sent).toHaveLength(1); // no microtask hop needed under budget
  });

  it('waits on acquire() when the budget is exhausted, then sends once it resolves', async () => {
    vi.mocked(globalRequestGate.tryAcquire).mockReturnValue(false);
    let resolveAcquire!: () => void;
    vi.mocked(globalRequestGate.acquire).mockReturnValue(new Promise((r) => { resolveAcquire = r; }));

    const { client, sockets } = await openClient();
    client.joinRoom('ABC234');
    expect(sockets[0]!.sent).toHaveLength(0); // queued, not yet sent

    resolveAcquire();
    await tick();
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it('a message queued on the gate is dropped (not sent) if the socket closes before its turn', async () => {
    vi.mocked(globalRequestGate.tryAcquire).mockReturnValue(false);
    let resolveAcquire!: () => void;
    vi.mocked(globalRequestGate.acquire).mockReturnValue(new Promise((r) => { resolveAcquire = r; }));

    const { client, sockets } = await openClient();
    client.joinRoom('ABC234'); // queued on the gate, socket currently open
    client.disconnect(); // socket closes while the send is still queued

    resolveAcquire(); // gate finally grants the slot, after the fact
    await tick();
    // doSend()'s `state !== 'open'` guard catches the now-stale send — never reaches the closed socket.
    expect(sockets[0]!.sent).toHaveLength(0);
  });

  it('preserves send order across a mix of gated messages resolving in sequence', async () => {
    vi.mocked(globalRequestGate.tryAcquire).mockReturnValue(false);
    const resolvers: Array<() => void> = [];
    vi.mocked(globalRequestGate.acquire).mockImplementation(
      () => new Promise((r) => { resolvers.push(r); }),
    );

    const { client, sockets } = await openClient();
    client.joinRoom('AAA111');
    client.setReady(true);
    expect(sockets[0]!.sent).toHaveLength(0);

    resolvers[0]!(); // grant the first queued caller's turn
    await tick();
    expect(sockets[0]!.sent).toHaveLength(1);

    resolvers[1]!();
    await tick();
    expect(sockets[0]!.sent).toHaveLength(2);
  });
});
