// HttpAuctionMetaClient.deductMaterial unit test. meta's /internal/materials/deduct signals business
// errors via real HTTP status (402 insufficient / 404 save-not-found / 409 rev-conflict-exhausted /
// 400 bad request) — no `code` field like escrow*/skin* on this same client. Regression test for
// [[business-errors-surface-as-500-2026-08-02]]: deductMaterial() used to wrap every non-2xx in a plain
// Error regardless of status, so httpApi.ts's `instanceof SlgError` catch never matched and a routine
// "not enough material" surfaced to the seller as a generic 500 instead of the real error code.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlgError, ErrorCode, type EquipmentInstance, type CardInstance } from '@nw/shared';
import { HttpAuctionMetaClient, nullAuctionMetaClient } from '../src/metaClient';

const KEY = 'k-internal';
let nextStatus = 200;
let nextBody: unknown = { ok: true, remaining: 100 };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      await readBody(req);
      res.writeHead(nextStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextBody));
    })();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('HttpAuctionMetaClient.deductMaterial', () => {
  it('2xx → resolves without throwing', async () => {
    nextStatus = 200;
    nextBody = { ok: true, remaining: 100 };
    const c = new HttpAuctionMetaClient(base, KEY);
    await expect(c.deductMaterial('acct1', 'paper', 1, 'auction_list:x')).resolves.toBeUndefined();
  });

  it('402 insufficient materials → throws SlgError(INSUFFICIENT_MATERIALS), not a generic 500', async () => {
    nextStatus = 402;
    nextBody = { ok: false, error: 'insufficient materials' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:y');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.INSUFFICIENT_MATERIALS);
    }
  });

  it('404 save not found → throws SlgError(NOT_FOUND)', async () => {
    nextStatus = 404;
    nextBody = { ok: false, error: 'save not found' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:z');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.NOT_FOUND);
    }
  });

  it('409 rev conflict exhausted → throws SlgError(REV_CONFLICT)', async () => {
    nextStatus = 409;
    nextBody = { ok: false, error: 'rev conflict, retry' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:w');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.REV_CONFLICT);
    }
  });

  it('400 bad request → throws SlgError(BAD_REQUEST)', async () => {
    nextStatus = 400;
    nextBody = { ok: false, error: 'accountId + material + qty (>0) required' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:v');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });

  it('an unrecognized 5xx status still falls back to a plain Error (genuinely unexpected failures stay generic)', async () => {
    nextStatus = 503;
    nextBody = { ok: false, error: 'service unavailable' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.deductMaterial('acct1', 'paper', 1, 'auction_list:u');
      expect.unreachable('deductMaterial() should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(SlgError);
      expect((e as Error).message).toBe('service unavailable');
    }
  });

  it('baseUrl not configured -> throws before ever making a request', async () => {
    const c = new HttpAuctionMetaClient(null, KEY);
    expect(c.available).toBe(false);
    await expect(c.deductMaterial('acct1', 'paper', 1, 'x')).rejects.toThrow('meta service not configured');
  });
});

describe('HttpAuctionMetaClient.grantMaterial (best-effort, never throws)', () => {
  it('2xx -> resolves silently', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await expect(new HttpAuctionMetaClient(base, KEY).grantMaterial('acct1', 'paper', 1, 'x')).resolves.toBeUndefined();
  });
  it('a failure is logged, not thrown', async () => {
    nextStatus = 500;
    nextBody = {};
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMetaClient(base, KEY).grantMaterial('acct1', 'paper', 1, 'x')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] meta.grantMaterial failed', expect.objectContaining({ accountId: 'acct1', material: 'paper' }));
  });
  it('baseUrl not configured -> no-op, no request', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).grantMaterial('acct1', 'paper', 1, 'x')).resolves.toBeUndefined();
  });
});

const EQUIP: EquipmentInstance = { id: 'e1', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] };
const CARD: CardInstance = { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false };

describe('HttpAuctionMetaClient.escrowEquipment / grantEquipment', () => {
  it('escrow success -> returns the instance snapshot', async () => {
    nextStatus = 200;
    nextBody = { instance: EQUIP };
    await expect(new HttpAuctionMetaClient(base, KEY).escrowEquipment('acct1', 'e1', 'x')).resolves.toEqual(EQUIP);
  });
  it.each(['EQUIP_LOCKED', 'EQUIP_IN_USE', 'EQUIP_NOT_FOUND'])('escrow known failure code %s -> SlgError with that code', async (code) => {
    nextStatus = 400;
    nextBody = { code };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowEquipment('acct1', 'e1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(code);
    }
  });
  it('escrow unrecognized failure -> SlgError(BAD_REQUEST)', async () => {
    nextStatus = 400;
    nextBody = { error: 'weird' };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowEquipment('acct1', 'e1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });
  it('escrow: baseUrl not configured -> throws before requesting', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).escrowEquipment('acct1', 'e1', 'x')).rejects.toThrow('meta service not configured');
  });
  it('grantEquipment success -> resolves silently', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await expect(new HttpAuctionMetaClient(base, KEY).grantEquipment('acct1', EQUIP, 'x')).resolves.toBeUndefined();
  });
  it('grantEquipment failure -> logged, not thrown', async () => {
    nextStatus = 500;
    nextBody = {};
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMetaClient(base, KEY).grantEquipment('acct1', EQUIP, 'x')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] meta.grantEquipment failed', expect.objectContaining({ instanceId: 'e1' }));
  });
  it('grantEquipment: baseUrl not configured -> no-op', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).grantEquipment('acct1', EQUIP, 'x')).resolves.toBeUndefined();
  });
});

describe('HttpAuctionMetaClient.escrowCard / grantCard', () => {
  it('escrow success -> returns the instance snapshot', async () => {
    nextStatus = 200;
    nextBody = { instance: CARD };
    await expect(new HttpAuctionMetaClient(base, KEY).escrowCard('acct1', 'c1', 'x')).resolves.toEqual(CARD);
  });
  it.each([ErrorCode.CARD_NOT_FOUND, ErrorCode.CARD_HAS_GEAR])('escrow known failure code %s -> SlgError with that code', async (code) => {
    nextStatus = 400;
    nextBody = { code };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowCard('acct1', 'c1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(code);
    }
  });
  it('escrow unrecognized failure -> SlgError(BAD_REQUEST)', async () => {
    nextStatus = 400;
    nextBody = {};
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowCard('acct1', 'c1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });
  it('escrow: baseUrl not configured -> throws before requesting', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).escrowCard('acct1', 'c1', 'x')).rejects.toThrow('meta service not configured');
  });
  it('grantCard success -> resolves silently', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await expect(new HttpAuctionMetaClient(base, KEY).grantCard('acct1', CARD, 'x')).resolves.toBeUndefined();
  });
  it('grantCard failure -> logged, not thrown', async () => {
    nextStatus = 500;
    nextBody = {};
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMetaClient(base, KEY).grantCard('acct1', CARD, 'x')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] meta.grantCard failed', expect.objectContaining({ instanceId: 'c1' }));
  });
  it('grantCard: baseUrl not configured -> no-op', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).grantCard('acct1', CARD, 'x')).resolves.toBeUndefined();
  });
});

describe('HttpAuctionMetaClient.escrowSkin / grantSkin', () => {
  it('escrow success -> returns the skinId', async () => {
    nextStatus = 200;
    nextBody = { skinId: 'skin_e1' };
    await expect(new HttpAuctionMetaClient(base, KEY).escrowSkin('acct1', 'skin_e1', 'x')).resolves.toBe('skin_e1');
  });
  it.each([ErrorCode.SKIN_IN_USE, ErrorCode.SKIN_NOT_FOUND])('escrow known failure code %s -> SlgError with that code', async (code) => {
    nextStatus = 400;
    nextBody = { code };
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowSkin('acct1', 'skin_e1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(code);
    }
  });
  it('escrow unrecognized failure -> SlgError(BAD_REQUEST)', async () => {
    nextStatus = 400;
    nextBody = {};
    const c = new HttpAuctionMetaClient(base, KEY);
    try {
      await c.escrowSkin('acct1', 'skin_e1', 'x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SlgError);
      expect((e as InstanceType<typeof SlgError>).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });
  it('escrow: baseUrl not configured -> throws before requesting', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).escrowSkin('acct1', 'skin_e1', 'x')).rejects.toThrow('meta service not configured');
  });
  it('grantSkin success -> resolves silently', async () => {
    nextStatus = 200;
    nextBody = { ok: true };
    await expect(new HttpAuctionMetaClient(base, KEY).grantSkin('acct1', 'skin_e1', 'x')).resolves.toBeUndefined();
  });
  it('grantSkin failure -> logged, not thrown', async () => {
    nextStatus = 500;
    nextBody = {};
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(new HttpAuctionMetaClient(base, KEY).grantSkin('acct1', 'skin_e1', 'x')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[auctionsvc] meta.grantSkin failed', expect.objectContaining({ skinId: 'skin_e1' }));
  });
  it('grantSkin: baseUrl not configured -> no-op', async () => {
    await expect(new HttpAuctionMetaClient(null, KEY).grantSkin('acct1', 'skin_e1', 'x')).resolves.toBeUndefined();
  });
});

describe('nullAuctionMetaClient', () => {
  it('reports unavailable; throwing methods throw, best-effort methods no-op', async () => {
    expect(nullAuctionMetaClient.available).toBe(false);
    await expect(nullAuctionMetaClient.deductMaterial('a', 'm', 1, 'x')).rejects.toThrow('meta service not configured');
    await expect(nullAuctionMetaClient.escrowEquipment('a', 'e', 'x')).rejects.toThrow('meta service not configured');
    await expect(nullAuctionMetaClient.escrowCard('a', 'c', 'x')).rejects.toThrow('meta service not configured');
    await expect(nullAuctionMetaClient.escrowSkin('a', 's', 'x')).rejects.toThrow('meta service not configured');
    await expect(nullAuctionMetaClient.grantMaterial('a', 'm', 1, 'x')).resolves.toBeUndefined();
    await expect(nullAuctionMetaClient.grantEquipment('a', EQUIP, 'x')).resolves.toBeUndefined();
    await expect(nullAuctionMetaClient.grantCard('a', CARD, 'x')).resolves.toBeUndefined();
    await expect(nullAuctionMetaClient.grantSkin('a', 's', 'x')).resolves.toBeUndefined();
  });
});
