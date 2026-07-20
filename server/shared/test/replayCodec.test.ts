// Pipeline A replay codec (S1-RP, 2026-07-20): compress/decompress round-trip + the specific
// BSON-Binary-vs-Buffer bug caught during review (decompressReplayDoc crashed on documents read
// back from Mongo, since the driver exposes binary fields as a `Binary` wrapper, not a plain Buffer).
import { describe, it, expect } from 'vitest';
import { compressReplayDoc, decompressReplayDoc, type MatchReplayDoc } from '../src';

const sample: MatchReplayDoc = {
  engineVersion: 0,
  mode: 'netplay',
  seed: '42',
  endFrame: 3,
  frames: [{ frame: 3, cmds: [{ side: 0, commands: 'AAA=' }] }],
  meta: { recordedAt: 1, winner: 0 },
};

/** Mimics the MongoDB driver's BSON Binary wrapper — has `.buffer`, is NOT `Buffer.isBuffer(...)`. */
function asMongoBinary(buf: Buffer): unknown {
  return { buffer: new Uint8Array(buf), sub_type: 0 };
}

describe('replayCodec', () => {
  it('round-trips a MatchReplayDoc through compress → decompress', () => {
    const gz = compressReplayDoc(sample);
    expect(decompressReplayDoc(gz)).toEqual(sample);
  });

  it('decompresses a real Buffer (e.g. straight off gameserver transport) directly', () => {
    const gz = compressReplayDoc(sample);
    expect(Buffer.isBuffer(gz)).toBe(true);
    expect(decompressReplayDoc(gz)).toEqual(sample);
  });

  it('regression: decompresses a Mongo-driver-shaped BSON Binary wrapper, not just a plain Buffer', () => {
    const gz = compressReplayDoc(sample);
    const binaryLike = asMongoBinary(gz) as Buffer; // types say Buffer; the driver actually hands back Binary
    expect(decompressReplayDoc(binaryLike)).toEqual(sample);
  });

  it('preserves decks when present', () => {
    const withDecks: MatchReplayDoc = { ...sample, decks: { top: ['a'], bottom: ['b'] } };
    expect(decompressReplayDoc(compressReplayDoc(withDecks))).toEqual(withDecks);
  });
});
