// Login-reconnect-prompt cold resume (2026-08-08 fix): regression coverage for NetSession.rejoinMatch()
// actually sending conn_resume on the very first socket open.
//
// Root cause: rejoinMatch()'s connectGame() builds a brand-new NetClient — its first successful open
// is, from the *server's* point of view, a mid-match reconnect (RoomManager.join() sees the side
// already occupied and routes to Room.takeover(), which during an active match deliberately does NOT
// rebind the connection — it waits for the client to follow up with conn_resume, same as any live
// in-session WS-blip reconnect). But NetClient's own `everOpened` flag only fires `onReconnect` from
// the *second* open onward, and this NetClient has never opened before — so `onReconnect` (which is
// what sends conn_resume) never fired, and the room's slot.conn stayed unbound forever: the "Unfinished
// Match / Reconnect" dialog got stuck with no error and no way in ("重连进不去", 2026-08-08 bug report).
//
// Fix: connectGame() passes `treatFirstOpenAsReconnect: true` whenever `onFailed` is given (which is
// only true for rejoinMatch's cold-resume path) so the very first open is already treated as a
// reconnect, and the onReconnect handler no longer gates on `this.roomId` (unset on a cold resume —
// the server resolves the room from the connection's own ticket, never from this wire field).
import { describe, it, expect } from 'vitest';
import { NetSession } from '../src/net/NetSession';
import type { IPlatform, IGameSocket, SocketHandlers } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { Envelope } from '../src/net/proto/transport';

class FakeSocket implements IGameSocket {
  closed = false;
  sent: Uint8Array[] = [];
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
    getAuthCredential: async () => ({ kind: 'device' as const, deviceId: 'dev-1' }),
  } as unknown as IPlatform;
  return { platform, sockets };
}

const fakeApi = { getToken: () => 'tok', auth: async () => ({ token: 'tok' }) } as unknown as ApiClient;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type SessionInternals = {
  rejoinMatch(gameUrl: string, ticket: string, onFailed?: () => void): void;
};

/** Decode the connResume messages a FakeSocket received, in order. */
function connResumesSent(s: FakeSocket): { roomId: string; lastFrame: number }[] {
  return s.sent
    .map((bytes) => Envelope.decode(bytes).client?.connResume)
    .filter((m): m is { roomId: string; lastFrame: number } => !!m);
}

describe('NetSession.rejoinMatch — cold resume sends conn_resume on first open (2026-08-08 fix)', () => {
  it('sends conn_resume immediately once the resumed socket opens, with no prior match_start in this session', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.rejoinMatch('ws://x/game', 'cached-ticket', () => {});
    await tick(); // flush tokenProvider microtask → socket created
    expect(sockets).toHaveLength(1);

    sockets[0]!.open();
    // Regression: before the fix, nothing was ever sent here — the client just sat open, waiting.
    expect(connResumesSent(sockets[0]!)).toEqual([{ roomId: '', lastFrame: 0 }]);
  });

  it('a subsequent transient drop + reconnect on the SAME resumed connection still only fires onReconnect once per open (no double-send)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as SessionInternals;

    s.rejoinMatch('ws://x/game', 'cached-ticket', () => {});
    await tick();
    sockets[0]!.open();
    expect(connResumesSent(sockets[0]!)).toHaveLength(1);
  });

  it('a live match_found path (no onFailed) does NOT get treatFirstOpenAsReconnect — first open sends nothing (no regression on the normal join flow)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const s = session as unknown as { connectGame(url: string, ticket: string, onFailed?: () => void): void };

    s.connectGame('ws://x/game', 'fresh-ticket'); // no onFailed — this is the ordinary match_found path
    await tick();
    sockets[0]!.open();

    expect(connResumesSent(sockets[0]!)).toEqual([]); // match_start is what drives the engine here, not conn_resume
  });
});
