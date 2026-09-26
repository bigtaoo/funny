import { describe, it, expect, afterEach, vi } from 'vitest';
import { WorldClient } from '../src/worldClient';

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

  it('getWorldMap GETs the FULL /world/map (not the sparse layer) with worldId/cx/cy/r', async () => {
    const calls = install({ ok: true, data: { tiles: [{ x: 5, y: 6, type: 'resource', level: 1, resType: 'paper' }] } });
    const view = await new WorldClient(BASE).getWorldMap(TOKEN, 's3-0', 5, 6, 3);
    expect(calls[0]!.url).toBe(`${BASE}/world/map?worldId=s3-0&cx=5&cy=6&r=3`);
    expect(view.tiles[0]!.resType).toBe('paper');
  });

  it('trainTroops POSTs /world/troops/train with worldId + qty and hands back the post-spend view', async () => {
    const calls = install({ ok: true, data: { joined: true, troops: 10 } });
    const after = await new WorldClient(BASE).trainTroops(TOKEN, 's3-0', 250);
    expect(after).toEqual({ joined: true, troops: 10 });
    expect(calls).toEqual([{
      url: `${BASE}/world/troops/train`, method: 'POST', auth: `Bearer ${TOKEN}`,
      body: { worldId: 's3-0', qty: 250 },
    }]);
  });

  it('startMarch POSTs /world/march with from/to coords, the kind and troops — and nothing else', async () => {
    const calls = install({ ok: true, data: { arriveAt: 42 } });
    // `to` may be a whole ExpansionPlan; only its coordinates go on the wire.
    const to = { x: 3, y: 4, kind: 'occupy' as const, troops: 500 };
    const started = await new WorldClient(BASE).startMarch(TOKEN, 's3-0', { x: 1, y: 2 }, to, 'occupy', 500);
    expect(started).toEqual({ arriveAt: 42 });
    expect(calls).toEqual([{
      url: `${BASE}/world/march`, method: 'POST', auth: `Bearer ${TOKEN}`,
      body: { worldId: 's3-0', fromX: 1, fromY: 2, toX: 3, toY: 4, kind: 'occupy', troops: 500 },
    }]);
  });

  it('listSects GETs /sect/list?worldId=', async () => {
    const calls = install({ ok: true, data: [] });
    expect(await new WorldClient(BASE).listSects(TOKEN, 's3-0')).toEqual([]);
    expect(calls[0]!.url).toBe(`${BASE}/sect/list?worldId=s3-0`);
  });

  it('createSect / joinSect POST their bodies', async () => {
    const calls = install({ ok: true, data: {} });
    await new WorldClient(BASE).createSect(TOKEN, 's3-0', 'Ink Pact', 'INKP');
    await new WorldClient(BASE).joinSect(TOKEN, 's3-0', 's:s3-0:INKP');
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/sect/create`, { worldId: 's3-0', name: 'Ink Pact', tag: 'INKP' }],
      [`${BASE}/sect/join`, { worldId: 's3-0', sectId: 's:s3-0:INKP' }],
    ]);
  });

  it('a {code, message} error envelope keeps its code instead of stringifying to [object Object]', async () => {
    install({ ok: false, error: { code: 'SECT_FULL', message: 'sect is full' } });
    await expect(new WorldClient(BASE).joinSect(TOKEN, 's3-0', 's:x')).rejects.toMatchObject({
      code: 'SECT_FULL',
      message: 'SECT_FULL: sect is full',
    });
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

describe('WorldClient.baseCoords — non-numeric segments', () => {
  // 'not-a-tile-id' above is rejected one line earlier, by the <3-segment check, so the Number.isFinite
  // pair had never actually run against a bad value. It has to hold: baseCoords feeds
  // BotSession.tryExpand's march origin, and a NaN x/y would go out as `fromX=NaN` on a real POST
  // /world/march instead of the bot simply skipping the march this tick.
  it('returns null when the x segment is not a number', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 's3-0:ab:34' })).toBeNull();
  });

  it('returns null when the y segment is not a number', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 's3-0:12:cd' })).toBeNull();
  });

  it('still parses a worldId that itself contains extra colons (split from the right)', () => {
    expect(client.baseCoords({ joined: true, mainBaseTile: 's3:0:12:34' })).toEqual({ x: 12, y: 34 });
  });
});
