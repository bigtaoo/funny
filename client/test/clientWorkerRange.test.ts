/**
 * clientWorkerRange.test.ts — `wrangler/worker.client.js`, the Worker in front of /review/*.
 *
 * Cloudflare's static assets path answers `Range` with a full 200, and Safari will not play an MP4
 * from such a server. The App Review recording lives under /review/, so the Worker slices 206s
 * itself. This pins that slicing against a fake ASSETS binding, plus the promise that every other
 * path is passed through untouched (the game must never depend on this Worker).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module outside the client tsconfig
import worker from '../../wrangler/worker.client.js';

const FILE = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) & 0xff));
const N = FILE.length;

const env = {
  ASSETS: {
    fetch: async (req: Request): Promise<Response> => {
      if (new URL(req.url).pathname === '/review/v.mp4') {
        return new Response(req.method === 'HEAD' ? null : FILE, {
          status: 200,
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(N) },
        });
      }
      return new Response('spa', { status: 200 });
    },
  },
};

async function get(path: string, range?: string, method = 'GET') {
  const res: Response = await worker.fetch(new Request(`https://x${path}`, { method, headers: range ? { Range: range } : {} }), env);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

describe('client Worker byte ranges on /review/*', () => {
  it('serves the whole file with Accept-Ranges when no range is asked', async () => {
    const { res, body } = await get('/review/v.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(body.equals(FILE)).toBe(true);
  });

  // Safari's first probe for a <video> or a direct .mp4 load.
  it('answers bytes=0-1 with a 206 of exactly two bytes', async () => {
    const { res, body } = await get('/review/v.mp4', 'bytes=0-1');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-1/${N}`);
    expect(res.headers.get('Content-Length')).toBe('2');
    expect(body.equals(FILE.subarray(0, 2))).toBe(true);
  });

  it.each([
    ['bytes=100-199', 100, 200],
    [`bytes=${N - 10}-`, N - 10, N],
    ['bytes=-23', N - 23, N],
    [`bytes=0-${N + 100}`, 0, N],
  ])('slices %s', async (range, from, to) => {
    const { res, body } = await get('/review/v.mp4', range);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes ${from}-${to - 1}/${N}`);
    expect(body.equals(FILE.subarray(from, to))).toBe(true);
  });

  it('answers a range past the end with 416', async () => {
    const { res } = await get('/review/v.mp4', `bytes=${N}-`);
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${N}`);
  });

  it('falls back to the full file for a multi-range request', async () => {
    const { res, body } = await get('/review/v.mp4', 'bytes=0-1,5-6');
    expect(res.status).toBe(200);
    expect(body.length).toBe(N);
  });

  it('measures a ranged HEAD against the real body, and sends no body', async () => {
    const { res, body } = await get('/review/v.mp4', 'bytes=0-1', 'HEAD');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-1/${N}`);
    expect(body.length).toBe(0);
  });

  it('passes every other path through untouched', async () => {
    const { res, body } = await get('/static/app.js', 'bytes=0-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBeNull();
    expect(body.toString()).toBe('spa');
  });
});
