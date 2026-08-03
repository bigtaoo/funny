// Regression coverage for NetSession's dangling `game` reference after a fatal close
// (client/src/net/NetSession.ts connectGame).
//
// 2026-08-03 fix: `this.game` was never nulled on a terminal/fatal close (e.g. a 4409 eviction —
// another device took over the same ticket mid-match) — so it kept pointing at the dead NetClient
// indefinitely. Two consequences before the fix:
//   1. `reportResult()`/`resume()` after that point routed to the dead NetClient's `doSend`, which
//      just logs a warning and silently drops the send — no error surfaced to the caller.
//   2. If the server ever resent `match_found` for that same (now-dead) ticket, `connectGame`'s
//      `this.game && this.ticket === ticket` guard returned immediately without attempting to
//      reconnect at all.
// Now the game connection's own onStateChange nulls `this.game` on any terminal close (identity-
// guarded against a newer connectGame() call already having replaced it), so both paths recover.
import { describe, it, expect } from 'vitest';
import { NetSession } from '../src/net/NetSession';
import type { IPlatform, IGameSocket, SocketHandlers } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';

class FakeSocket implements IGameSocket {
  closed = false;
  sent: Uint8Array[] = [];
  constructor(readonly h: SocketHandlers) {}
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  open(): void { this.h.onOpen(); }
  closeRemote(code = 1006): void { this.h.onClose(code, 'abnormal'); }
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

type SessionInternals = {
  game: unknown;
  connectGame(url: string, ticket: string, onFailed?: () => void): void;
};

describe('NetSession — game connection reference after a fatal close (2026-08-03 fix)', () => {
  it('this.game is nulled once the connection closes with a fatal code (4409 eviction)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.connectGame('ws://x/game', 'ticket-1');
    await tick();
    sockets[0]!.open();
    expect(s.game).not.toBeNull();

    sockets[0]!.closeRemote(4409); // fatal — another device took over
    expect(s.game).toBeNull(); // regression: used to stay pointing at the dead NetClient forever
  });

  it('this.game stays intact after a non-fatal close (transient drop, still reconnecting)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.connectGame('ws://x/game', 'ticket-2');
    await tick();
    sockets[0]!.open();

    sockets[0]!.closeRemote(1006); // ordinary/transient drop — not one of the fatal codes
    expect(s.game).not.toBeNull(); // still the same (reconnecting) NetClient, not nulled
  });

  it('regression: reportResult() after a fatal close no longer targets a dangling dead connection', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.connectGame('ws://x/game', 'ticket-3');
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(4409);

    expect(s.game).toBeNull();
    // Must not throw — NetSession.reportResult optionally-chains through `this.game`.
    expect(() => session.reportResult('hash', 0)).not.toThrow();
  });

  it('regression: a resent match_found for the SAME ticket after a fatal close reconnects instead of being ignored', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.connectGame('ws://x/game', 'ticket-4');
    await tick();
    sockets[0]!.open();
    sockets[0]!.closeRemote(4409);
    expect(s.game).toBeNull();

    // Before the fix, `this.game && this.ticket === ticket` would short-circuit false→skip only
    // because this.game was truthy (dangling) — once nulled, a resend for the SAME ticket must now
    // actually attempt a fresh connection (a second socket gets created).
    s.connectGame('ws://x/game', 'ticket-4');
    await tick();
    expect(sockets.length).toBe(2);
    expect(s.game).not.toBeNull();
  });
});
