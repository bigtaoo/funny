// WorldApiCore.req picks the rate gate's lane by HTTP method (2026-09-26).
//
// Why it matters: one SLG dispatch fans out into ~10 requests, and with a single FIFO the fifth team's
// order waited 2-3s behind the list refreshes the first four had caused. Every worldsvc mutation is a
// player's own order, so it goes in the interactive lane; reads go in the background lane. The lane
// behaviour itself is covered in rate-gate.test.ts — this file pins the wiring.
import { describe, it, expect, vi, afterEach } from 'vitest';

const lanes: string[] = [];
vi.mock('../src/net/rateGate', () => ({
  globalRequestGate: {
    acquire: vi.fn(async (lane?: string) => { lanes.push(lane ?? 'background'); }),
    tryAcquire: () => true,
  },
}));

import { WorldApiCore } from '../src/net/WorldApiClient/core';
import { setNetTransport, fetchTransport } from '../src/net/transport';

const noopStorage = {
  getItem: (_k: string): string | null => null,
  setItem: (_k: string, _v: string): void => {},
  removeItem: (_k: string): void => {},
};

afterEach(() => {
  lanes.length = 0;
  setNetTransport(fetchTransport);
});

describe('WorldApiCore rate-gate lane', () => {
  it('reads go in the background lane, mutations in the interactive lane', async () => {
    setNetTransport({
      request: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }), text: async () => '' }),
    });
    const core = new WorldApiCore(noopStorage);
    await core.req('GET', '/world/orders?worldId=w1');
    await core.req('POST', '/world/march', { worldId: 'w1' });
    await core.req('POST', '/world/march/m1/recall', { worldId: 'w1' });
    expect(lanes).toEqual(['background', 'interactive', 'interactive']);
  });
});
