// NetSession prematch_lost regression (FIXED, matchsvc M5, audit-followup-fixes-0730 review; closed
// 2026-07-30): a queue-context prematch_lost push (matchsvc restart-safety) arriving AFTER match_found
// has already connected the data plane must not re-trigger ranked matchmaking — the player is already in
// a match. routeControl's self-heal branch now checks `this.game` before re-enqueuing, so a stale/late
// prematch_lost delivered after the real pairing succeeded is a no-op instead of silently re-submitting
// the player to the ranked queue over the control-plane WS while they're actively playing.
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

describe('NetSession prematch_lost while already in a match (matchsvc M5)', () => {
  it('a queue-context prematch_lost arriving after match_found does not re-trigger ranked matchmaking', async () => {
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

    // No-op: the player is already in a match (session.game is connected), so createRanked() must not
    // fire again — that would silently re-submit ranked matchmaking over the control-plane WS while the
    // player is actively playing the match they were already matched into.
    expect(createRankedSpy).not.toHaveBeenCalled();
  });
});

// Boundary coverage added 2026-07-30 (audit-followup-fixes-0730 follow-up): the M5 fix only special-cases
// context==='queue' && this.game — every other branch of routeControl's preMatchLost handling must behave
// exactly as before.
describe('NetSession prematch_lost — other branches unaffected by the this.game guard (matchsvc M5)', () => {
  it('a queue-context prematch_lost arriving BEFORE match_found still re-triggers ranked matchmaking (self-heal preserved)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));

    session.connect();
    await tick();
    sockets[0]!.open();

    session.createRanked(['card1']); // remembers lastRankedDeck, enters the ranked queue — no match_found yet
    const createRankedSpy = vi.spyOn(session, 'createRanked');
    sendGateway(sockets, { preMatchLost: { context: 'queue' } });

    // this.game is still null (no match_found arrived) — the pre-existing self-heal must still fire.
    expect(createRankedSpy).toHaveBeenCalledWith(['card1']);
  });

  it('a queue-context prematch_lost with no remembered deck falls back to onRoomError (defensive fallback preserved)', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const onRoomError = vi.fn();
    session.handlers.onRoomError = onRoomError;

    session.connect();
    await tick();
    sockets[0]!.open();
    // No createRanked() this session — lastRankedDeck is still null.
    sendGateway(sockets, { preMatchLost: { context: 'queue' } });

    expect(onRoomError).toHaveBeenCalledWith(expect.objectContaining({ code: 'PREMATCH_LOST' }));
  });

  it('a room-context prematch_lost still bounces back to the room picker via onRoomError', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const onRoomError = vi.fn();
    session.handlers.onRoomError = onRoomError;

    session.connect();
    await tick();
    sockets[0]!.open();
    sendGateway(sockets, { preMatchLost: { context: 'room' } });

    expect(onRoomError).toHaveBeenCalledWith(expect.objectContaining({ code: 'PREMATCH_LOST' }));
  });

  it('a duel-context prematch_lost still clears the pending invite banner via onDuelCancelled', async () => {
    const { platform, sockets } = fakePlatform();
    const session = new NetSession(platform, 'ws://x/gw', fakeApi, async () => ({ kind: 'device', deviceId: 'dev-1' }));
    const onDuelCancelled = vi.fn();
    session.handlers.onDuelCancelled = onDuelCancelled;

    session.connect();
    await tick();
    sockets[0]!.open();
    sendGateway(sockets, { preMatchLost: { context: 'duel' } });

    expect(onDuelCancelled).toHaveBeenCalledWith({ inviteId: '', reason: 'lost' });
  });
});
