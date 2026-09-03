// Wire-level helper unit tests for src/httpApi/helpers.ts — 40% branch coverage before this file, the
// worst in the package (2026-09-03 branch-coverage pass). Every existing e2e request reaches these
// helpers through the real server, which means always a well-formed JSON body, always an ErrorCode
// that has an ERROR_HTTP_STATUS entry, and always a present, numeric `limit` query parameter — so the
// fallbacks these helpers exist FOR had never executed once. The four that matter:
//
//   * `readJson`'s 1 MB cutoff is the public port's OOM guard (P0-9): a settled promise does not stop
//     'data' events, so the `req.destroy()` alongside the reject is the part that actually bounds
//     memory. Asserting the reject alone would pass with the destroy() deleted.
//   * malformed JSON must reject rather than resolve `{}` — the shell turns that rejection into a 500,
//     and a silent `{}` would instead run the handler with every field absent.
//   * `sendErr`'s `?? 400`: an ErrorCode with no status mapping must still produce a client error, not
//     `writeHead(undefined)` (which throws inside the response, killing the socket mid-reply).
//   * `sendSocialErr` is the single translation table from the service layer's SocialError union to
//     wire codes; the client branches on those codes to pick a message ("already friends" vs "blocked"
//     are different UI), so each arm is pinned individually here rather than trusted to a spot check.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ErrorCode, ERROR_HTTP_STATUS } from '@nw/shared';
import { readJson, send, sendErr, sendSocialErr, numQ, type SocialError } from '../src/httpApi/helpers';

/** Minimal ServerResponse stand-in: captures the one writeHead + end pair every helper emits. */
function fakeRes(): { res: ServerResponse; status: () => number; headers: () => Record<string, string>; body: <T>() => T } {
  let status = 0;
  let headers: Record<string, string> = {};
  let payload = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; },
    end(b?: string) { payload = b ?? ''; },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    headers: () => headers,
    body: <T>() => JSON.parse(payload) as T,
  };
}

describe('readJson', () => {
  it('parses a JSON object body', async () => {
    const req = Readable.from(['{"a":1,', '"b":"x"}']) as unknown as IncomingMessage;
    expect(await readJson(req)).toEqual({ a: 1, b: 'x' });
  });

  it('an empty body resolves to {} rather than throwing on JSON.parse("")', async () => {
    const req = new EventEmitter() as unknown as IncomingMessage;
    const p = readJson(req);
    req.emit('end');
    expect(await p).toEqual({});
  });

  it('malformed JSON rejects (the shell maps it to a 500 — it must not resolve to {})', async () => {
    const req = Readable.from(['{"a":']) as unknown as IncomingMessage;
    await expect(readJson(req)).rejects.toThrow(SyntaxError);
  });

  it('a body over 1 MB rejects AND destroys the request (P0-9: the destroy is what bounds memory)', async () => {
    const req = Readable.from(['x'.repeat((1 << 20) + 1)]) as unknown as IncomingMessage;
    const destroy = vi.spyOn(req, 'destroy');
    await expect(readJson(req)).rejects.toThrow('payload too large');
    expect(destroy).toHaveBeenCalled();
  });

  it('a socket error rejects with that error (no hung promise on a dropped connection)', async () => {
    const req = new EventEmitter() as unknown as IncomingMessage;
    const p = readJson(req);
    req.emit('error', new Error('socket hang up'));
    await expect(p).rejects.toThrow('socket hang up');
  });
});

describe('send', () => {
  it('writes the status, the JSON body and the CORS header set every response carries', () => {
    const r = fakeRes();
    send(r.res, 201, { ok: true, data: { id: 'x' } });
    expect(r.status()).toBe(201);
    expect(r.body()).toEqual({ ok: true, data: { id: 'x' } });
    expect(r.headers()['content-type']).toBe('application/json');
    expect(r.headers()['access-control-allow-origin']).toBe('*');
    expect(r.headers()['access-control-allow-headers']).toContain('x-chat-region');
    expect(r.headers()['access-control-allow-methods']).toBe('GET,POST,PUT,OPTIONS');
  });
});

describe('sendErr', () => {
  it('maps a known ErrorCode through ERROR_HTTP_STATUS', () => {
    const r = fakeRes();
    sendErr(r.res, ErrorCode.NOT_FOUND, 'nope');
    expect(r.status()).toBe(404);
    expect(r.body()).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'nope' } });
  });

  it('an ErrorCode with no status entry falls back to 400, never writeHead(undefined)', () => {
    // ALREADY_ACTIVE is a real ErrorCode that ERROR_HTTP_STATUS does not list — asserted here so this
    // test fails loudly (rather than silently stopping to exercise the fallback) if it ever gains one.
    expect(ERROR_HTTP_STATUS[ErrorCode.ALREADY_ACTIVE]).toBeUndefined();
    const r = fakeRes();
    sendErr(r.res, ErrorCode.ALREADY_ACTIVE, 'unmapped');
    expect(r.status()).toBe(400);
    expect(r.body()).toEqual({ ok: false, error: { code: 'ALREADY_ACTIVE', message: 'unmapped' } });
  });
});

describe('sendSocialErr', () => {
  // [SocialError, expected HTTP status, expected wire code] — the client picks its message off the
  // code, so these pairings are the contract, not an implementation detail.
  const cases: [SocialError, number, string][] = [
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['ALREADY_FRIEND', 409, 'ALREADY_FRIEND'],
    ['FRIEND_CAP_REACHED', 409, 'FRIEND_CAP_REACHED'],
    ['NOT_FRIEND', 403, 'NOT_FRIEND'],
    ['BLOCKED', 403, 'BLOCKED'],
    ['MUTED', 403, 'ACCOUNT_MUTED'],
    ['BAD_REQUEST', 400, 'BAD_REQUEST'],
  ];
  for (const [e, status, code] of cases) {
    it(`${e} -> ${status} ${code}`, () => {
      const r = fakeRes();
      sendSocialErr(r.res, e);
      expect(r.status()).toBe(status);
      expect(r.body<{ error: { code: string } }>().error.code).toBe(code);
    });
  }

  it('an unknown error string falls through to BAD_REQUEST (defensive default, unreachable by type)', () => {
    const r = fakeRes();
    sendSocialErr(r.res, 'SOMETHING_NEW' as SocialError);
    expect(r.status()).toBe(400);
    expect(r.body<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });
});

describe('numQ', () => {
  it('an absent parameter yields the default', () => {
    expect(numQ(null, 30)).toBe(30);
  });
  it('a non-numeric parameter yields the default (not NaN, which would break Math.min downstream)', () => {
    expect(numQ('abc', 200)).toBe(200);
  });
  it('an empty string is Number("") === 0, which is finite and therefore kept', () => {
    expect(numQ('', 30)).toBe(0);
  });
  it('Infinity is rejected as non-finite', () => {
    expect(numQ('Infinity', 30)).toBe(30);
  });
  it('a numeric parameter is parsed, fractions included', () => {
    expect(numQ('12', 30)).toBe(12);
    expect(numQ('12.5', 30)).toBe(12.5);
    expect(numQ('-4', 30)).toBe(-4);
  });
});
