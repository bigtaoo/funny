// Regression coverage for the state-stream share blob compression (REPLAY_SHARE_DESIGN §7).
// Previously zero coverage: the pack/unpack round-trip that every shared-replay deep link
// depends on had never been exercised by any test.
import { describe, it, expect } from 'vitest';
import { packReplayBlob, unpackReplayBlob } from '../src/net/replayCompress';

describe('replayCompress — pack/unpack round-trip', () => {
  it('packs an object to a base64 string and unpacks it back to an equal object', async () => {
    const enc = { frames: [{ tick: 1, ru: [1, 2, 3] }, { tick: 2, rb: [4] }], engineVersion: 7, seed: 42 };
    const packed = await packReplayBlob(enc);
    expect(typeof packed).toBe('string');

    const out = await unpackReplayBlob(packed);
    expect(out).toEqual(enc);
  });

  it('round-trips a large, highly repetitive delta stream (realistic replay shape)', async () => {
    const frames = Array.from({ length: 500 }, (_, i) => ({ tick: i, ru: [1, 2, 3], rb: [] }));
    const enc = { frames, engineVersion: 7, seed: 1 };
    const packed = await packReplayBlob(enc);
    // gzip compresses this repetitive JSON well below its raw size (per file header, ~10-20×) —
    // a real ratio check, not just "round-trips", since that's the whole point of this module.
    expect(packed.length).toBeLessThan(JSON.stringify(enc).length / 5);
    const out = await unpackReplayBlob(packed);
    expect(out).toEqual(enc);
  });

  it('the packed output is real gzip (magic bytes 0x1f 0x8b) so legacy plain-text detection stays correct', async () => {
    const packed = await packReplayBlob({ a: 1 });
    const bin = atob(packed);
    expect(bin.charCodeAt(0)).toBe(0x1f);
    expect(bin.charCodeAt(1)).toBe(0x8b);
  });

  it('unpackReplayBlob passes through a non-string input unchanged (legacy/degraded blob stored as a plain object)', async () => {
    const legacy = { frames: [] };
    const out = await unpackReplayBlob(legacy);
    expect(out).toBe(legacy);
  });

  it('unpackReplayBlob treats a non-gzip string as plain-text JSON (uncompressed legacy fallback)', async () => {
    const plain = JSON.stringify({ legacy: true });
    // base64 of plain JSON text — its first two bytes are not the gzip magic (0x1f 0x8b).
    const b64 = btoa(plain);
    const out = await unpackReplayBlob(b64);
    expect(out).toEqual({ legacy: true });
  });
});
