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

  /**
   * Pins WHY `MatchReplayDoc.frames[].cmds[].commands` is typed `string` and not bytes (it was
   * `unknown` until 2026-08-20, a leftover of the pre-gzip era when the doc really was stored as
   * BSON). The doc's only storage form is JSON inside this gzip blob, and JSON has no byte type:
   * a Buffer does not survive the round-trip — it comes back as the `{type,data}` object
   * JSON.stringify makes of it, which every downstream consumer would then hand to the judge /
   * re-simulation as garbage. Base64 at the single producer (gameserver metaReport.ts) is what
   * makes the field round-trip at all.
   */
  it('regression: bytes cannot survive the JSON round-trip — only the base64 string does', () => {
    const bytes = Buffer.from([0, 1, 2]);
    // Deliberately violating the type, which is the whole point: this is what `unknown` used to allow.
    const bad = { ...sample, frames: [{ frame: 3, cmds: [{ side: 0, commands: bytes as unknown as string }] }] };
    const back = decompressReplayDoc(compressReplayDoc(bad)).frames[0]!.cmds[0]!.commands;
    expect(typeof back).toBe('object');
    expect(back).toEqual({ type: 'Buffer', data: [0, 1, 2] });
    expect(Buffer.isBuffer(back)).toBe(false);
    // …whereas the base64 of the same bytes comes back byte-identical and decodes to the original.
    const good = { ...sample, frames: [{ frame: 3, cmds: [{ side: 0, commands: bytes.toString('base64') }] }] };
    const round = decompressReplayDoc(compressReplayDoc(good)).frames[0]!.cmds[0]!.commands;
    expect(round).toBe('AAEC');
    expect(Buffer.from(round, 'base64')).toEqual(bytes);
  });

  it('preserves decks when present', () => {
    const withDecks: MatchReplayDoc = { ...sample, decks: { top: ['a'], bottom: ['b'] } };
    expect(decompressReplayDoc(compressReplayDoc(withDecks))).toEqual(withDecks);
  });
});
