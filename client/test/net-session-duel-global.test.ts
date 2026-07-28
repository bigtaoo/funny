// NetSession.globalHandlers regression test (P0-8, comm-audit-2026-07-27 finding B9).
//
// Duel invites ("切磋") can arrive while the recipient is on any scene, not just FriendsScene —
// but every scene wholesale-replaces `session.handlers` on entry, silently dropping anything bound
// only there. `globalHandlers.onDuelInvited` must fire regardless of what `handlers` currently
// holds (including nothing at all, and including a full scene-switch reassignment mid-session).
import { describe, it, expect } from 'vitest';
import { NetSession } from '../src/net/NetSession';
import type { IPlatform } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import type { IGameSocket, SocketHandlers } from '../src/platform/IPlatform';
import { Envelope } from '../src/net/proto/transport';

class FakeSocket implements IGameSocket {
  closed = false;
  constructor(readonly h: SocketHandlers) {}
  send(): void { /* not exercised */ }
  close(): void { this.closed = true; }
  open(): void { this.h.onOpen(); }
  message(bytes: Uint8Array): void { this.h.onMessage(bytes); }
}

function fakePlatform(): { platform: IPlatform; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const platform = {
    connectSocket(_url: string, h: SocketHandlers): IGameSocket {
      const s = new FakeSocket(h);
      sockets.push(s);
      return s;
    },
    getAuthCredential: async () => ({ kind: 'device' as const, deviceId: 'dev-1' }),
  } as unknown as IPlatform;
  return { platform, sockets };
}

const fakeApi = { getToken: () => 'tok', auth: async () => ({ token: 'tok' }) } as unknown as ApiClient;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function sendDuelInvited(sockets: FakeSocket[], inviteId: string, fromName: string): void {
  const bytes = Envelope.encode(
    Envelope.fromPartial({ server: { duelInvited: { inviteId, fromPublicId: '100000001', fromName } } }),
  ).finish();
  sockets[0]!.message(bytes);
}

describe('NetSession.globalHandlers (duel invite visibility)', () => {
  it('fires even when handlers has no onDuelInvited bound (e.g. player not on FriendsScene)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    session.handlers = { onMatchStart: () => {} }; // mimics a scene bound to something else, no duel handler
    const seen: string[] = [];
    session.globalHandlers.onDuelInvited = (d) => seen.push(d.fromName);

    session.connect();
    await tick();
    sockets[0]!.open();
    sendDuelInvited(sockets, 'inv-1', 'Alice');

    expect(seen).toEqual(['Alice']);
  });

  it('fires alongside a scene-bound handler when both are set', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const sceneSeen: string[] = [];
    const globalSeen: string[] = [];
    session.handlers = { onDuelInvited: (d) => sceneSeen.push(d.fromName) };
    session.globalHandlers.onDuelInvited = (d) => globalSeen.push(d.fromName);

    session.connect();
    await tick();
    sockets[0]!.open();
    sendDuelInvited(sockets, 'inv-2', 'Bob');

    expect(sceneSeen).toEqual(['Bob']);
    expect(globalSeen).toEqual(['Bob']);
  });

  it('survives a mid-session handlers reassignment (scene switch)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const globalSeen: string[] = [];
    session.globalHandlers.onDuelInvited = (d) => globalSeen.push(d.fromName);

    session.connect();
    await tick();
    sockets[0]!.open();

    // Simulate navigating through several scenes, each wholesale-replacing `handlers`.
    session.handlers = { onFriendPresence: () => {} };
    session.handlers = { onMarchUpdate: () => {} };
    session.handlers = {};

    sendDuelInvited(sockets, 'inv-3', 'Carol');
    expect(globalSeen).toEqual(['Carol']);
  });
});
