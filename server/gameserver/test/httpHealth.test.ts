import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleHttpRequest } from '../src/httpHealth';

function fakeRes() {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

/**
 * Both responses declare `content-length` and write a Buffer rather than letting node fall back to
 * chunked framing (WORLDSVC_CONCURRENCY_AUDIT §8; `scripts/checkEdgeCompression.mjs` enforces it across
 * every hand-rolled node:http writer). gameserver's own /health is not proxied, so the byte saving is
 * beside the point here — the rule has no exceptions precisely so nobody has to maintain a list of which
 * writers are edge-facing, which is the list the original sweep got wrong.
 *
 * Asserting the declared length against the body it accompanies, rather than just its presence, is the
 * part worth having: a wrong length truncates the response, and a length computed from `String.length`
 * would be wrong for any non-ASCII body.
 */
function expectDeclaredLength(res: ReturnType<typeof fakeRes>, contentType: string): Buffer {
  const [, headers] = res.writeHead.mock.calls[0]! as [number, Record<string, string>];
  expect(headers['content-type']).toBe(contentType);
  const body = res.end.mock.calls[0]![0] as Buffer;
  expect(Buffer.isBuffer(body)).toBe(true);
  expect(headers['content-length']).toBe(String(body.byteLength));
  return body;
}

describe('handleHttpRequest', () => {
  it('GET /health -> 200 json {ok:true, service:"gameserver"}', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'GET', url: '/health' } as IncomingMessage, res);
    expect(res.writeHead.mock.calls[0]![0]).toBe(200);
    const body = expectDeclaredLength(res, 'application/json');
    expect(JSON.parse(body.toString('utf8'))).toEqual({ ok: true, service: 'gameserver' });
  });

  it('POST /health -> 426 (method must be GET)', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'POST', url: '/health' } as IncomingMessage, res);
    expect(res.writeHead.mock.calls[0]![0]).toBe(426);
    expectDeclaredLength(res, 'text/plain');
  });

  it('GET / (any other path) -> 426 Upgrade Required', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'GET', url: '/' } as IncomingMessage, res);
    expect(res.writeHead.mock.calls[0]![0]).toBe(426);
    const body = expectDeclaredLength(res, 'text/plain');
    expect(body.toString('utf8')).toBe('Upgrade Required');
  });
});
