import { describe, it, expect, vi, afterEach } from 'vitest';
import { CapacityClient, shedTarget } from '../src/capacityClient';

const base = { targetOnline: 100, shedStartAt: 2500, shedFullAt: 2800 };

describe('CapacityClient.onlineCount', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends x-internal-key — gateway /internal/stats 401s without it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ online: 7 }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new CapacityClient('http://gateway.internal', 'the-key');
    const online = await client.onlineCount();

    expect(online).toBe(7);
    // fetchInternalJson adds the caller-identity header + a per-attempt timeout signal.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway.internal/internal/stats',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-internal-key': 'the-key', 'x-internal-caller': 'botsvc' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('throws on failure so the scheduler falls back to shedding-disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'down' }),
      body: { cancel: async () => undefined },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new CapacityClient('http://gateway.internal', 'the-key');
    await expect(client.onlineCount()).rejects.toThrow('gateway /internal/stats failed: 503');
  });
});

describe('shedTarget', () => {
  it('holds full target below the shed-start threshold', () => {
    expect(shedTarget({ ...base, currentOnline: 2000 })).toBe(100);
    expect(shedTarget({ ...base, currentOnline: 2500 })).toBe(100);
  });

  it('ramps linearly between shedStartAt and shedFullAt', () => {
    expect(shedTarget({ ...base, currentOnline: 2650 })).toBe(50);
  });

  it('sheds to zero at and beyond shedFullAt — bots never block real players', () => {
    expect(shedTarget({ ...base, currentOnline: 2800 })).toBe(0);
    expect(shedTarget({ ...base, currentOnline: 3000 })).toBe(0);
  });
});

describe('CapacityClient.onlineCount — degraded responses', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports the transport failure when there is no HTTP status at all (status 0)', async () => {
    // fetchInternalJson turns a network error / timeout into {ok:false, status:0, error}. Printing a
    // bare "failed: 0" would read like an HTTP code the gateway never sent, so the message has to fall
    // through to the transport description instead — this is the line ops sees when the internal port
    // is simply unroutable (an external load-gen fleet), which is a different fix than a 5xx.
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;
    await expect(new CapacityClient('http://gateway.internal', 'k').onlineCount()).rejects.toThrow(
      'gateway /internal/stats failed: connect ECONNREFUSED',
    );
  });

  it('throws on a 200 whose body did not parse as JSON (ok but no body)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <');
      },
      body: { cancel: async () => undefined },
    }) as unknown as typeof fetch;
    await expect(new CapacityClient('http://gateway.internal', 'k').onlineCount()).rejects.toThrow(
      /gateway \/internal\/stats failed/,
    );
  });
});
