// Connection wrapper unit tests (previously 0% coverage): send()/close() against a fake `ws`.
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { Connection } from '../src/Connection';

function fakeWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe('Connection', () => {
  it('constructor binds ticket identity (roomId/side/accountId/ws) and defaults alive=true', () => {
    const ws = fakeWs();
    const conn = new Connection('R1', 1, 'acc-1', ws);
    expect(conn.roomId).toBe('R1');
    expect(conn.side).toBe(1);
    expect(conn.accountId).toBe('acc-1');
    expect(conn.ws).toBe(ws);
    expect(conn.alive).toBe(true);
  });

  it('send() encodes and writes to the socket when OPEN', () => {
    const ws = fakeWs();
    const conn = new Connection('R1', 0, 'a', ws);
    conn.send({ case: 'pong' });
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send.mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
  });

  it('send() is a no-op when the socket is not OPEN', () => {
    const ws = fakeWs(3 /* CLOSED */);
    const conn = new Connection('R1', 0, 'a', ws);
    conn.send({ case: 'pong' });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('send() swallows a write failure instead of throwing', () => {
    const ws = fakeWs();
    ws.send.mockImplementation(() => {
      throw new Error('write after end');
    });
    const conn = new Connection('R1', 0, 'a', ws);
    expect(() => conn.send({ case: 'pong' })).not.toThrow();
  });

  it('close() forwards code/reason to the socket', () => {
    const ws = fakeWs();
    const conn = new Connection('R1', 0, 'a', ws);
    conn.close(4401, 'invalid ticket');
    expect(ws.close).toHaveBeenCalledWith(4401, 'invalid ticket');
  });

  it('close() swallows a failure instead of throwing (socket already gone)', () => {
    const ws = fakeWs();
    ws.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const conn = new Connection('R1', 0, 'a', ws);
    expect(() => conn.close(1000, 'bye')).not.toThrow();
  });
});
