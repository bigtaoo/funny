// NetClient 连接/重连状态机回归（S1-6）。用假 socket，无网络。
// 真·端到端（连真 gameserver、双 NetClient、真断线重连）走临时集成脚本验证。
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
  // 测试触发
  open(): void {
    this.h.onOpen();
  }
  closeRemote(): void {
    this.h.onClose(1006, 'abnormal');
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
    await tick(); // flush tokenProvider 微任务 → 创建 socket
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

    sockets[0]!.closeRemote(); // 异常掉线
    expect(client.getState()).toBe('reconnecting');

    await sleep(20); // 退避 5ms + token 微任务
    expect(sockets).toHaveLength(2); // 新 socket 已建
    sockets[1]!.open();
    expect(client.getState()).toBe('open');
    expect(onReconnect).toHaveBeenCalledTimes(1); // 仅重连 open 触发，首次不触发
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

    // 旧 socket 的滞后 onClose 不应触发重连（代次已作废）
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
    client.joinRoom('ABC234'); // 未 open
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.open();
    client.joinRoom('ABC234'); // open 后可发
    expect(sockets[0]!.sent).toHaveLength(1);
  });
});
