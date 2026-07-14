import { describe, it, expect, vi, afterEach } from 'vitest';
import { CapacityClient, shedTarget } from '../src/capacityClient';

const base = { targetOnline: 100, shedStartAt: 2500, shedFullAt: 2800 };

describe('CapacityClient.onlineCount', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends x-internal-key — gateway /internal/stats 401s without it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ online: 7 }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new CapacityClient('http://gateway.internal', 'the-key');
    const online = await client.onlineCount();

    expect(online).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gateway.internal/internal/stats',
      expect.objectContaining({ headers: { 'x-internal-key': 'the-key' } }),
    );
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
