// Unit tests for the ticket-handshake admission / message routing / heartbeat sweep extracted
// from index.ts (see src/connectionHandler.ts). No real socket: `ws` here is a minimal fake
// (only the members each function actually touches), same technique as RoomManager/Room's tests.
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import { signTicket, type TicketClaims } from '@nw/shared';
import type { WebSocket } from 'ws';
import { resolveConnection, routeMessage, sweepHeartbeat, wireConnection, getConnections } from '../src/connectionHandler';
import { RoomManager } from '../src/RoomManager';
import { Connection } from '../src/Connection';

const KEY = 'test-internal-key';
const env = { internalKey: KEY };

// Same independent-encode technique as transport.test.ts: encode a client oneof body via
// protobufjs (not the module under test) to produce wire bytes for routeMessage's decode path.
const PROTO = path.resolve(__dirname, '../../contracts/transport.proto');
const Envelope = protobuf.parse(fs.readFileSync(PROTO, 'utf8'), { keepCase: true }).root.lookupType('nw.transport.Envelope');
function encodeClient(body: Record<string, unknown>): Buffer {
  return Buffer.from(Envelope.encode(Envelope.fromObject({ client: body })).finish());
}

/** The bits of the fake this test asserts on, split out so the literal below can be annotated —
 *  without an annotation `this` inside its methods widens to `{}` and every `this.x` write fails. */
interface FakeWsProbes {
  closedWith: { code: number; reason: string } | null;
  terminated: boolean;
  pinged: boolean;
}

function fakeWs(): WebSocket & FakeWsProbes {
  const ws: FakeWsProbes & Pick<WebSocket, 'readyState' | 'OPEN'> & {
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    send(): void;
  } = {
    closedWith: null,
    terminated: false,
    pinged: false,
    readyState: 1,
    OPEN: 1,
    close(code?: number, reason?: string) {
      this.closedWith = { code: code ?? 0, reason: reason ?? '' };
    },
    terminate() {
      this.terminated = true;
    },
    ping() {
      this.pinged = true;
    },
    send() {
      /* noop */
    },
  };
  return ws as unknown as WebSocket & FakeWsProbes;
}

function newManager(): RoomManager {
  return new RoomManager({ report: async () => null });
}

const BASE_CLAIMS: TicketClaims = {
  roomId: 'R1',
  seed: 42,
  side: 0,
  mode: 'friendly',
  opponent: 'bob',
  opponentPublicId: '000000002',
  gameUrl: 'ws://game/ws',
  accountId: 'acc-a',
};

function ticketFor(claims: Partial<TicketClaims> = {}, ttlSec = 30): string {
  return signTicket({ ...BASE_CLAIMS, ...claims }, { key: KEY, ttlSec });
}

function urlWithTicket(ticket: string | null): URL {
  const u = new URL('ws://game.local/ws');
  if (ticket !== null) u.searchParams.set('ticket', ticket);
  return u;
}

describe('resolveConnection', () => {
  it('no ticket param -> rejected 4401 invalid ticket, no Connection', () => {
    const manager = newManager();
    const ws = fakeWs();
    const conn = resolveConnection(urlWithTicket(null), ws, env, manager);
    expect(conn).toBeNull();
    expect(ws.closedWith).toEqual({ code: 4401, reason: 'invalid ticket' });
  });

  it('garbage ticket -> rejected 4401 invalid ticket', () => {
    const manager = newManager();
    const ws = fakeWs();
    const conn = resolveConnection(urlWithTicket('not-a-jwt'), ws, env, manager);
    expect(conn).toBeNull();
    expect(ws.closedWith).toEqual({ code: 4401, reason: 'invalid ticket' });
  });

  it('wrong signing key -> rejected 4401 invalid ticket', () => {
    const manager = newManager();
    const ws = fakeWs();
    const badTicket = signTicket(BASE_CLAIMS, { key: 'a-different-key' });
    const conn = resolveConnection(urlWithTicket(badTicket), ws, env, manager);
    expect(conn).toBeNull();
    expect(ws.closedWith).toEqual({ code: 4401, reason: 'invalid ticket' });
  });

  it('expired ticket for a room that no longer exists -> rejected 4401 ticket expired', () => {
    const manager = newManager();
    const ws = fakeWs();
    const expired = ticketFor({}, -1); // ttlSec negative -> already expired
    const conn = resolveConnection(urlWithTicket(expired), ws, env, manager);
    expect(conn).toBeNull();
    expect(ws.closedWith).toEqual({ code: 4401, reason: 'ticket expired' });
  });

  it('expired ticket but the room already exists (reconnect) -> exp is ignored, join proceeds', () => {
    const manager = newManager();
    // Seat side 0 first via a fresh (non-expired) ticket so the room exists.
    const ws0 = fakeWs();
    resolveConnection(urlWithTicket(ticketFor({ side: 0 })), ws0, env, manager);
    expect(manager.roomExists('R1')).toBe(true);

    // Side 0 reconnecting with an expired ticket for the SAME room must still be accepted.
    const ws0b = fakeWs();
    const conn = resolveConnection(urlWithTicket(ticketFor({ side: 0 }, -1)), ws0b, env, manager);
    expect(conn).not.toBeNull();
    expect(ws0b.closedWith).toBeNull();
  });

  it('valid ticket, fresh room -> Connection returned, manager.join called, no close', () => {
    const manager = newManager();
    const ws = fakeWs();
    const conn = resolveConnection(urlWithTicket(ticketFor()), ws, env, manager);
    expect(conn).toBeInstanceOf(Connection);
    expect(conn!.roomId).toBe('R1');
    expect(conn!.side).toBe(0);
    expect(conn!.accountId).toBe('acc-a');
    expect(conn!.alive).toBe(true);
    expect(ws.closedWith).toBeNull();
    expect(manager.roomExists('R1')).toBe(true);
  });

  it('ranked mode ticket is threaded through to manager.join (room ends up RANKED)', () => {
    const manager = newManager();
    resolveConnection(urlWithTicket(ticketFor({ side: 0, mode: 'ranked' })), fakeWs(), env, manager);
    // Second ticket claiming FRIENDLY for the same room must now be rejected (mode mismatch) —
    // this only happens if the first join actually recorded RANKED.
    const ws1 = fakeWs();
    const conn = resolveConnection(urlWithTicket(ticketFor({ side: 1, mode: 'friendly' })), ws1, env, manager);
    expect(conn).toBeNull();
    expect(ws1.closedWith).toEqual({ code: 4403, reason: 'ticket room mismatch' });
  });

  it('ticket room mismatch (seed differs from the existing room) -> rejected 4403', () => {
    const manager = newManager();
    resolveConnection(urlWithTicket(ticketFor({ side: 0, seed: 1 })), fakeWs(), env, manager);
    const ws1 = fakeWs();
    const conn = resolveConnection(urlWithTicket(ticketFor({ side: 1, seed: 2 })), ws1, env, manager);
    expect(conn).toBeNull();
    expect(ws1.closedWith).toEqual({ code: 4403, reason: 'ticket room mismatch' });
  });

  it('missing optional claims (opponentTitle/opponentAvatarId/opponentSkins/opponentPublicId/decks) default safely', () => {
    const manager = newManager();
    const ws = fakeWs();
    const conn = resolveConnection(
      urlWithTicket(
        ticketFor({
          opponentTitle: undefined,
          opponentAvatarId: undefined,
          opponentSkins: undefined,
          opponentPublicId: undefined,
          decks: undefined,
        }),
      ),
      ws,
      env,
      manager,
    );
    expect(conn).not.toBeNull();
  });
});

describe('wireConnection', () => {
  function fakeWsWithHandlers() {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const ws = {
      closedWith: null as { code: number; reason: string } | null,
      readyState: 1,
      OPEN: 1,
      close(code?: number, reason?: string) {
        this.closedWith = { code: code ?? 0, reason: reason ?? '' };
      },
      send() {},
      on(event: string, cb: (...args: unknown[]) => void) {
        handlers[event] = cb;
      },
    };
    return { ws: ws as unknown as WebSocket, handlers, raw: ws };
  }

  it('rejected handshake -> returns null, no message/pong/close/error handlers attached', () => {
    const manager = newManager();
    const { ws, handlers } = fakeWsWithHandlers();
    const conn = wireConnection(ws, urlWithTicket(null), env, manager);
    expect(conn).toBeNull();
    expect(handlers.message).toBeUndefined();
  });

  it('accepted handshake -> wires message/pong/close/error and getConnections recovers it from wss.clients', () => {
    const manager = newManager();
    const handle = vi.spyOn(manager, 'handle');
    const onClose = vi.spyOn(manager, 'onClose');
    const { ws, handlers } = fakeWsWithHandlers();
    const conn = wireConnection(ws, urlWithTicket(ticketFor()), env, manager);
    expect(conn).not.toBeNull();

    expect(getConnections([ws])).toEqual([conn]);

    // message handler routes a binary frame into manager.handle
    handlers.message!(encodeClient({ ping: {} }), true);
    expect(handle).toHaveBeenCalledTimes(1);

    // pong handler marks alive
    conn!.alive = false;
    handlers.pong!();
    expect(conn!.alive).toBe(true);

    // close handler notifies the manager
    handlers.close!();
    expect(onClose).toHaveBeenCalledWith(conn);

    // error handler must not throw
    expect(() => handlers.error!()).not.toThrow();
  });
});

describe('getConnections', () => {
  it('ignores sockets never tagged with a Connection (e.g. still mid-handshake)', () => {
    const untagged = {} as WebSocket;
    expect(getConnections([untagged])).toEqual([]);
  });
});

describe('routeMessage', () => {
  function fakeConn(): Connection {
    return { alive: false, side: 0, roomId: 'R', accountId: 'a', send: vi.fn() } as unknown as Connection;
  }

  it('marks the connection alive even for non-binary frames, but does not route them', () => {
    const manager = newManager();
    const handle = vi.spyOn(manager, 'handle');
    const conn = fakeConn();
    routeMessage(conn, manager, Buffer.from('text'), false);
    expect(conn.alive).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it('binary frame decodes and routes to manager.handle', () => {
    const manager = newManager();
    const handle = vi.spyOn(manager, 'handle');
    const conn = fakeConn();
    const bytes = encodeClient({ ping: {} });
    routeMessage(conn, manager, bytes, true);
    expect(conn.alive).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![1]).toEqual({ case: 'ping' });
  });

  it('malformed binary frame is dropped silently (does not throw, does not route)', () => {
    const manager = newManager();
    const handle = vi.spyOn(manager, 'handle');
    const conn = fakeConn();
    expect(() => routeMessage(conn, manager, Buffer.from([0xff, 0xff, 0xff]), true)).not.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('sweepHeartbeat', () => {
  function fakeAliveConn(alive: boolean) {
    return {
      alive,
      accountId: 'a',
      roomId: 'R',
      side: 0,
      ws: { terminate: vi.fn(), ping: vi.fn() },
    } as unknown as Connection;
  }

  it('alive connection: marked not-alive and pinged (waiting for next sweep to confirm)', () => {
    const conn = fakeAliveConn(true);
    sweepHeartbeat([conn]);
    expect(conn.alive).toBe(false);
    expect((conn.ws as any).ping).toHaveBeenCalledTimes(1);
    expect((conn.ws as any).terminate).not.toHaveBeenCalled();
  });

  it('already not-alive (missed the previous ping) -> terminated, not pinged again', () => {
    const conn = fakeAliveConn(false);
    sweepHeartbeat([conn]);
    expect((conn.ws as any).terminate).toHaveBeenCalledTimes(1);
    expect((conn.ws as any).ping).not.toHaveBeenCalled();
  });

  it('ping() throwing is swallowed (socket already closing under us)', () => {
    const conn = fakeAliveConn(true);
    (conn.ws as any).ping = vi.fn(() => {
      throw new Error('not open');
    });
    expect(() => sweepHeartbeat([conn])).not.toThrow();
  });

  it('sweeps multiple connections independently', () => {
    const a = fakeAliveConn(true);
    const b = fakeAliveConn(false);
    sweepHeartbeat([a, b]);
    expect(a.alive).toBe(false);
    expect((b.ws as any).terminate).toHaveBeenCalledTimes(1);
  });
});
