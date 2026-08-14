// Regression test for the memory-exhaustion guard in httpApi.ts's readJson (2026-08-04 full code review):
// the 1MB body-size cap used to only reject the promise without stopping the underlying request stream,
// so 'data' events kept firing and `body` kept growing without bound for as long as the client kept
// sending — a single authenticated player's oversized POST to /auction/create or /auction/:id/bid could
// exhaust the process's memory. Fixed by mirroring worldsvc/src/httpApi.ts's readJson: a `rejected` flag
// plus req.destroy() the moment the cap trips. Unit-tested directly against readJson with a fake
// EventEmitter-based IncomingMessage — a real over-the-wire oversized POST is an alternative, but
// destroy() tears down the socket before a response can be written back, so asserting on connection-level
// behavior over real sockets would be slower and flakier than exercising the exported function directly.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { readJson } from '../src/httpApi';

function fakeRequest(): IncomingMessage & { destroy: ReturnType<typeof vi.fn> } {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy: ReturnType<typeof vi.fn> };
  req.destroy = vi.fn();
  return req;
}

describe('readJson payload-size guard', () => {
  it('destroys the connection (once) instead of continuing to buffer once the 1MB cap is exceeded', async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    const chunk = Buffer.alloc(1 << 19).fill('a'); // 512KB per chunk
    req.emit('data', chunk);
    req.emit('data', chunk);
    req.emit('data', chunk); // cumulative > 1MB — trips the guard on this event
    // Further data after the cap must be ignored, not keep accumulating or re-trigger destroy().
    req.emit('data', chunk);
    req.emit('data', chunk);

    await expect(promise).rejects.toThrow('payload too large');
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });

  it('an "end" arriving after the cap has already tripped does not override the rejection with a resolve', async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    const chunk = Buffer.alloc((1 << 20) + 1024).fill('a'); // over the cap in a single chunk
    req.emit('data', chunk);
    req.emit('end'); // the stream still fires 'end' normally after destroy(); must be a no-op here

    await expect(promise).rejects.toThrow('payload too large');
  });

  it('a well-formed body under the cap resolves normally (no regression on the happy path)', async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    req.emit('data', Buffer.from(JSON.stringify({ hello: 'world' })));
    req.emit('end');

    await expect(promise).resolves.toEqual({ hello: 'world' });
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it('an empty body resolves to {} rather than throwing on JSON.parse', async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    req.emit('end');
    await expect(promise).resolves.toEqual({});
  });

  it('malformed JSON under the cap rejects with the JSON.parse error', async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    req.emit('data', Buffer.from('{not valid json'));
    req.emit('end');
    await expect(promise).rejects.toThrow(/JSON/);
  });

  it("a stream 'error' event rejects the promise", async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    req.emit('error', new Error('socket hang up'));
    await expect(promise).rejects.toThrow('socket hang up');
  });

  it("a stream 'error' event after the size cap already tripped is a no-op (does not override the rejection)", async () => {
    const req = fakeRequest();
    const promise = readJson(req);
    const chunk = Buffer.alloc((1 << 20) + 1024).fill('a');
    req.emit('data', chunk);
    req.emit('error', new Error('irrelevant, arrives after destroy()'));
    await expect(promise).rejects.toThrow('payload too large');
  });
});
