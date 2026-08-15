import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleHttpRequest } from '../src/httpHealth';

function fakeRes() {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

describe('handleHttpRequest', () => {
  it('GET /health -> 200 json {ok:true, service:"gameserver"}', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'GET', url: '/health' } as IncomingMessage, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({ ok: true, service: 'gameserver' });
  });

  it('POST /health -> 426 (method must be GET)', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'POST', url: '/health' } as IncomingMessage, res);
    expect(res.writeHead).toHaveBeenCalledWith(426, { 'content-type': 'text/plain' });
  });

  it('GET / (any other path) -> 426 Upgrade Required', () => {
    const res = fakeRes();
    handleHttpRequest({ method: 'GET', url: '/' } as IncomingMessage, res);
    expect(res.writeHead).toHaveBeenCalledWith(426, { 'content-type': 'text/plain' });
    expect(res.end).toHaveBeenCalledWith('Upgrade Required');
  });
});
