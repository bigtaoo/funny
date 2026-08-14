import { describe, it, expect, afterEach, vi } from 'vitest';
import { WorldClient, type WorldTileSparseView } from '../src/worldClient';

const client = new WorldClient('http://unused');

const BASE = 'http://world:18084';
const TOKEN = 'player-jwt';

function install(body: unknown): { url: string; method: string | undefined; auth: string | undefined; body: unknown }[] {
  const calls: { url: string; method: string | undefined; auth: string | undefined; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method, auth: headers.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}

// The HTTP-backed methods (previously 0% — the pre-existing tests above only cover the two pure helpers).
describe('WorldClient HTTP methods', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('getActiveSeason GETs /world/active-season with no auth (public, pre-login)', async () => {
    const calls = install({ ok: true, data: { season: 3 } });
    expect(await new WorldClient(BASE).getActiveSeason()).toEqual({ season: 3 });
    expect(calls).toEqual([{ url: `${BASE}/world/active-season`, method: 'GET', auth: 'Bearer ', body: undefined }]);
  });

  it('joinSeason POSTs /world/season/join with the season number', async () => {
    const calls = install({ ok: true, data: { joined: true, worldId: 's3-0' } });
    const view = await new WorldClient(BASE).joinSeason(TOKEN, 3);
    expect(view).toEqual({ joined: true, worldId: 's3-0' });
    expect(calls).toEqual([{ url: `${BASE}/world/season/join`, method: 'POST', auth: `Bearer ${TOKEN}`, body: { season: 3 } }]);
  });

  it('getWorldMe GETs /world/me?worldId=', async () => {
    const calls = install({ ok: true, data: { joined: true, troops: 50 } });
    await new WorldClient(BASE).getWorldMe(TOKEN, 's3-0');
    expect(calls[0]!.url).toBe(`${BASE}/world/me?worldId=s3-0`);
  });

  it('upgradeBuilding POSTs /world/build/upgrade with worldId + key', async () => {
    const calls = install({ ok: true });
    await new WorldClient(BASE).upgradeBuilding(TOKEN, 's3-0', 'desk');
    expect(calls).toEqual([{ url: `${BASE}/world/build/upgrade`, method: 'POST', auth: `Bearer ${TOKEN}`, body: { worldId: 's3-0', key: 'desk' } }]);
  });

  it('getWorldMapSparse GETs /world/map/sparse with worldId/cx/cy/r', async () => {
    const calls = install({ ok: true, data: { tiles: [] } });
    await new WorldClient(BASE).getWorldMapSparse(TOKEN, 's3-0', 5, 6, 3);
    expect(calls[0]!.url).toBe(`${BASE}/world/map/sparse?worldId=s3-0&cx=5&cy=6&r=3`);
  });

  it('startMarchAttack POSTs /world/march with from/to coords + troops + kind:attack', async () => {
    const calls = install({ ok: true });
    await new WorldClient(BASE).startMarchAttack(TOKEN, 's3-0', { x: 1, y: 2 }, { x: 3, y: 4 }, 10);
    expect(calls).toEqual([{
      url: `${BASE}/world/march`, method: 'POST', auth: `Bearer ${TOKEN}`,
      body: { worldId: 's3-0', fromX: 1, fromY: 2, toX: 3, toY: 4, kind: 'attack', troops: 10 },
    }]);
  });

  it('a failed call (ok:false) throws the server-provided error message', async () => {
    install({ ok: false, error: 'season not open' });
    await expect(new WorldClient(BASE).joinSeason(TOKEN, 3)).rejects.toThrow('season not open');
  });

  it('a failed call with no error message falls back to a generic description', async () => {
    install({ ok: false });
    await expect(new WorldClient(BASE).upgradeBuilding(TOKEN, 's3-0', 'desk')).rejects.toThrow(/world call failed: POST \/world\/build\/upgrade/);
  });
});

describe('WorldClient.baseCoords', () => {
  it('parses {worldId}:{x}:{y} tileIds, including a worldId containing no digits', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 's3-0:12:34' })).toEqual({ x: 12, y: 34 });
  });

  it('returns null when there is no base yet', () => {
    expect(client.baseCoords({ joined: true })).toBeNull();
  });

  it('returns null for a malformed tileId', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 'not-a-tile-id' })).toBeNull();
  });
});

describe('WorldClient.pickAttackTarget', () => {
  const tile = (over: Partial<WorldTileSparseView>): WorldTileSparseView => ({
    x: 0,
    y: 0,
    type: 'territory',
    ...over,
  });

  it('picks the first occupied, non-mine attackable tile', () => {
    const tiles = [tile({ mine: true, x: 1, y: 1 }), tile({ mine: false, x: 2, y: 2 })];
    expect(client.pickAttackTarget(tiles)).toEqual({ x: 2, y: 2 });
  });

  it('ignores resource/neutral/obstacle tiles even when not mine', () => {
    const tiles = [
      tile({ type: 'resource', mine: false, x: 5, y: 5 }),
      tile({ type: 'neutral', mine: false, x: 6, y: 6 }),
      tile({ type: 'obstacle', mine: false, x: 7, y: 7 }),
    ];
    expect(client.pickAttackTarget(tiles)).toBeNull();
  });

  it('returns null when no candidates exist', () => {
    expect(client.pickAttackTarget([])).toBeNull();
  });
});
