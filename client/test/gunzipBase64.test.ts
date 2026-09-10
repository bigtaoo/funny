// Coverage for `client/src/net/gzip.ts` — the base64(gzip(...)) unwrapper every server-side match
// replay arrives through (S1-RP, 2026-07-20: the server stopped decompressing and pushed it here to
// save bandwidth).
//
// It was 0% because nothing in `coverage.include` matched it, and it is worth a gate for one reason
// that has nothing to do with its 17 lines: `DecompressionStream` is a *runtime* capability, not a
// language one. It exists in browsers and in Node 18+; whether it exists in the WeChat mini-game
// runtime is exactly the kind of thing this project has been bitten by before (see the host-probe
// work, ASSET_PACKAGING_LOG §17). The explicit `typeof === 'undefined'` throw is the difference
// between "replay playback is unavailable here" and an unreadable TypeError deep in a Blob pipeline,
// so the throw is pinned rather than left as a comment.
import { describe, it, expect, afterEach } from 'vitest';
import { gunzipBase64 } from '../src/net/gzip';

/** The production path in reverse, using the browser/Node CompressionStream the server's gzip matches. */
async function gzipToBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const stream = new Blob([ab]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe('gunzipBase64', () => {
  const g = globalThis as { DecompressionStream?: unknown };
  const real = g.DecompressionStream;
  afterEach(() => { g.DecompressionStream = real; });

  it('round-trips a replay-shaped JSON payload', async () => {
    const payload = JSON.stringify({ frames: [{ f: 1, cmds: ['AAEC'] }, { f: 2, cmds: [] }], engineVersion: 0 });
    const out = await gunzipBase64(await gzipToBase64(payload));
    expect(new TextDecoder().decode(out)).toBe(payload);
  });

  it('handles bytes outside ASCII, which the base64 hop is the easy place to lose', async () => {
    // The decoder walks `charCodeAt` over atob's binary string. A payload with high bytes in it (any
    // Chinese player name in a replay) is where an accidental `TextEncoder` round trip would corrupt
    // the stream instead of throwing — silently, and only for some players.
    const payload = JSON.stringify({ name: '苏元', tag: 'ünïcödé', emoji: '🎯' });
    const out = await gunzipBase64(await gzipToBase64(payload));
    expect(new TextDecoder().decode(out)).toBe(payload);
  });

  it('round-trips an empty payload', async () => {
    expect(await gunzipBase64(await gzipToBase64(''))).toEqual(new Uint8Array(0));
  });

  it('throws a runtime-capability message where DecompressionStream is absent (WeChat)', async () => {
    delete g.DecompressionStream;
    await expect(gunzipBase64('anything')).rejects.toThrow(/decompression unavailable/);
  });

  it('checks the capability BEFORE touching the input, so a bad runtime never reads as bad data', async () => {
    // Order matters for diagnosis: if the base64 decode ran first, the WeChat failure would surface
    // as an InvalidCharacterError about the payload and send the next reader after the server.
    delete g.DecompressionStream;
    await expect(gunzipBase64('!!!not base64!!!')).rejects.toThrow(/decompression unavailable/);
  });

  it('rejects rather than resolves on input that is not gzip', async () => {
    // A truncated or mis-typed response body must not come back as an empty/partial buffer that the
    // caller then tries to JSON.parse.
    await expect(gunzipBase64(btoa('plain text, not gzip'))).rejects.toThrow();
  });
});
