// NetClient connect/reconnect state-machine regression tests (S1-6). Uses a fake socket; no real network.
// True end-to-end tests (connecting to a real gameserver, two NetClients, real disconnect/reconnect)
// are covered by a separate integration script.
import { describe, it, expect, vi } from 'vitest';
import { NetClient, type NetState } from '../src/net/NetClient';
import type { IGameSocket, IPlatform, SocketHandlers } from '../src/platform/IPlatform';
import { Envelope } from '../src/net/proto/transport';

class FakeSocket implements IGameSocket {
  sent: Uint8Array[] = [];
  closed = false;
  constructor(readonly h: SocketHandlers) {}
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // test-driven triggers
  open(): void {
    this.h.onOpen();
  }
  closeRemote(code = 1006): void {
    this.h.onClose(code, 'abnormal');
  }
  message(bytes: Uint8Array): void {
    this.h.onMessage(bytes);
  }
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('NetClient connect / reconnect', () => {
  it('connects, opens, and tracks state', async () => {
    const { platform, sockets } = fakePlatform();
    const states: NetState[] = [];
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {}, onStateChange: (s) => states.push(s) },
    });
    client.connect();
    await tick(); // flush tokenProvider microtask → create socket
    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe('connecting');
    sockets[0]!.open();
    expect(client.getState()).toBe('open');
    expect(states).toContain('connecting');
    expect(states).toContain('open');
  });

  it('appends ?token= to url', async () => {
    const sockets: FakeSocket[] = [];
    let seenUrl = '';
    const platform = {
      connectSocket(url: string, h: SocketHandlers): IGameSocket {
        seenUrl = url;
        const s = new FakeSocket(h);
        sockets.push(s);
        return s;
      },
    } as unknown as IPlatform;
    const client = new NetClient(platform, {
      url: 'wss://host/ws',
      tokenProvider: async () => 'abc.def',
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {} },
    });
    client.connect();
    await tick();
    expect(seenUrl).toBe('wss://host/ws?token=abc.def');
  });

  it('auto-reconnects on abnormal close and fires onReconnect', async () => {
    const { platform, sockets } = fakePlatform();
    const onReconnect = vi.fn();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [5],
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {}, onReconnect },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    expect(client.getState()).toBe('open');

    sockets[0]!.closeRemote(); // abnormal disconnect
    expect(client.getState()).toBe('reconnecting');

    await sleep(20); // backoff 5ms + token microtask
    expect(sockets).toHaveLength(2); // new socket established
    sockets[1]!.open();
    expect(client.getState()).toBe('open');
    expect(onReconnect).toHaveBeenCalledTimes(1); // fires only on reconnect open, not on first connect
  });

  it('connect() during a pending reconnect does not spawn a second socket (regression)', async () => {
    // Bug: connect() only short-circuited on 'connecting'/'open', so calling it while 'reconnecting'
    // (e.g. NetSession.connect() re-invoked on every scene entry) raced a second openSocket() under
    // the same `gen` alongside the pending backoff timer's own retry — two live sockets, each free to
    // stomp `this.socket`/state to 'closed' on the other's close and permanently kill reconnection.
    const { platform, sockets } = fakePlatform();
    const onReconnect = vi.fn();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [10],
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {}, onReconnect },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(); // abnormal disconnect → 'reconnecting' + backoff timer scheduled
    expect(client.getState()).toBe('reconnecting');

    client.connect(); // scene-entry-style idempotent re-call while a reconnect is already pending
    await tick();
    expect(sockets).toHaveLength(1); // must not have opened a second socket yet

    await sleep(30); // let the original backoff timer fire
    expect(sockets).toHaveLength(2); // exactly one reconnect attempt, not two
    sockets[1]!.open();
    expect(client.getState()).toBe('open');
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // The single reconnected socket must survive — no orphaned duplicate free to clobber it closed.
    sockets[1]!.closeRemote();
    expect(client.getState()).toBe('reconnecting');
  });

  it('does not reconnect after intentional disconnect (ignores stale callbacks)', async () => {
    const { platform, sockets } = fakePlatform();
    const onReconnect = vi.fn();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [5],
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {}, onReconnect },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    client.disconnect();
    expect(client.getState()).toBe('closed');
    expect(sockets[0]!.closed).toBe(true);

    // A stale onClose from the old socket must not trigger reconnect (generation is superseded)
    sockets[0]!.closeRemote();
    await sleep(20);
    expect(sockets).toHaveLength(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('decodes incoming server Envelope and forwards ServerMsg', async () => {
    const { platform, sockets } = fakePlatform();
    const msgs: unknown[] = [];
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      pingIntervalMs: 0,
      handlers: { onServerMsg: (m) => msgs.push(m) },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    const bytes = Envelope.encode(
      Envelope.fromPartial({ server: { roomError: { code: 'ROOM_FULL', message: 'full' } } }),
    ).finish();
    sockets[0]!.message(bytes);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { roomError?: { code: string } }).roomError?.code).toBe('ROOM_FULL');
  });

  it('4409 (replaced) is always fatal — no reconnect attempt', async () => {
    const { platform, sockets } = fakePlatform();
    const onReconnect = vi.fn();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [5],
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {}, onReconnect },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(4409);
    // 'disconnected' (2026-08-03 rename), not 'closed' — this is a permanent server-side rejection,
    // distinct from an intentional/graceful disconnect() call; see NetState's doc comment.
    expect(client.getState()).toBe('disconnected');
    await sleep(20);
    expect(sockets).toHaveLength(1); // no reconnect attempt spawned
  });

  it('without extraFatalCloseCodes, 4401 is treated as a transient drop and keeps retrying (gateway connection: tokenProvider can mint a fresh JWT on retry)', async () => {
    const { platform, sockets } = fakePlatform();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [5],
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {} },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(4401);
    expect(client.getState()).toBe('reconnecting');
    await sleep(20);
    expect(sockets).toHaveLength(2); // retried
  });

  it('extraFatalCloseCodes opts a code into the same "give up" behavior as 4409 (login-reconnect-prompt: resumed match ticket for a room that no longer exists)', async () => {
    const { platform, sockets } = fakePlatform();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      backoffMs: [5],
      pingIntervalMs: 0,
      extraFatalCloseCodes: [4401, 4403],
      handlers: { onServerMsg: () => {} },
    });
    client.connect();
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(4401);
    // 'disconnected' (2026-08-03 rename) — see the 4409 test above.
    expect(client.getState()).toBe('disconnected');
    await sleep(20);
    expect(sockets).toHaveLength(1); // no reconnect attempt spawned
  });

  it('drops sends while not open', async () => {
    const { platform, sockets } = fakePlatform();
    const client = new NetClient(platform, {
      url: 'ws://x/ws',
      tokenProvider: async () => 'tok',
      pingIntervalMs: 0,
      handlers: { onServerMsg: () => {} },
    });
    client.connect();
    await tick();
    client.joinRoom('ABC234'); // not yet open
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.open();
    client.joinRoom('ABC234'); // can send after open
    expect(sockets[0]!.sent).toHaveLength(1);
  });
});
