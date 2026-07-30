// NetSession prematch_lost regression (KNOWN GAP, audit-followup-fixes-0730 review, M5 — not yet fixed):
// a queue-context prematch_lost push (matchsvc restart-safety) arriving AFTER match_found has already
// connected the data plane should not re-trigger ranked matchmaking — the player is already in a match.
// routeControl's self-heal (`if (context === 'queue' && this.lastRankedDeck) this.createRanked(...)`)
// doesn't check `this.game` before re-enqueuing, so a stale/late prematch_lost delivered after the real
// pairing succeeded would silently re-submit the player to the ranked queue over the control-plane WS
// while they're actively playing.
import { describe, it, expect, vi } from 'vitest';
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

function sendGateway(sockets: FakeSocket[], server: object): void {
  const bytes = Envelope.encode(Envelope.fromPartial({ server })).finish();
  sockets[0]!.message(bytes);
}

describe('NetSession prematch_lost while already in a match (KNOWN GAP M5)', () => {
  it.fails('a queue-context prematch_lost arriving after match_found does not re-trigger ranked matchmaking', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));

    session.connect();
    await tick();
    sockets[0]!.open();

    session.createRanked(['card1']); // remembers lastRankedDeck, enters the ranked queue
    sendGateway(sockets, { matchFound: { gameUrl: 'ws://game/x', ticket: 'tik-1' } }); // paired — data plane connects
    await tick();

    const createRankedSpy = vi.spyOn(session, 'createRanked');
    sendGateway(sockets, { preMatchLost: { context: 'queue' } }); // a stale restart-safety push arrives late

    // Should be a no-op: the player is already in a match (session.game is connected). Today it isn't —
    // createRanked() fires again, silently re-submitting ranked matchmaking over the control-plane WS
    // while the player is actively playing the match they were already matched into.
    expect(createRankedSpy).not.toHaveBeenCalled();
  });
});
