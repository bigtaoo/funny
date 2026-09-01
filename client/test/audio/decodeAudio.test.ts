// decodeAudio exists because two runtimes disagree about decodeAudioData's shape, and assuming
// either one loads NOTHING on the other target — silently, forever falling back to the synth
// voices. So each shape gets a case, including the one nobody can reproduce locally.
//
// Run with: npm test
import { describe, it, expect } from 'vitest';
import { decodeAudio, type AudioDecoder } from '../../src/audio/decodeAudio';
import { fakeBuffer } from './fakeAudioContext';

const BYTES = new ArrayBuffer(8);

describe('decodeAudio', () => {
  it('adopts a RETURNED promise (the browser shape)', async () => {
    const buf = fakeBuffer(0.1);
    const ctx: AudioDecoder = { decodeAudioData: () => Promise.resolve(buf) };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(buf);
  });

  it('accepts the CALLBACK shape with no return value', async () => {
    // This is the case a promise-only implementation would fail on a real device, where it is
    // indistinguishable from "the files are missing".
    const buf = fakeBuffer(0.2);
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, ok) => {
        ok?.(buf);
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(buf);
  });

  it('rejects through the error callback', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, _ok, fail) => {
        fail?.(new Error('bad frame'));
      },
    };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('bad frame');
  });

  it('turns a non-Error rejection value into an Error', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, _ok, fail) => {
        fail?.('nope');
      },
    };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('nope');
  });

  it('turns a SYNCHRONOUS throw into a rejection, not an unhandled boot exception', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: () => {
        throw new Error('callback form unsupported');
      },
    };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('callback form unsupported');
  });

  it('rejects with a message when the failure carries no value at all', async () => {
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, _ok, fail) => {
        fail?.(undefined);
      },
    };
    await expect(decodeAudio(ctx, BYTES)).rejects.toThrow('decodeAudioData failed');
  });

  it('first settle wins when an implementation does BOTH', async () => {
    // A promise implementation may also invoke the callbacks. The callback fires first here, so
    // the later promise rejection must not turn a loaded sample into a failure.
    const buf = fakeBuffer(0.3);
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, ok) => {
        ok?.(buf);
        return Promise.reject(new Error('late'));
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(buf);
  });

  it('passes the bytes through untouched', async () => {
    let seen: ArrayBuffer | null = null;
    const ctx: AudioDecoder = {
      decodeAudioData: (d, ok) => {
        seen = d;
        ok?.(fakeBuffer(0.1));
      },
    };
    await decodeAudio(ctx, BYTES);
    expect(seen).toBe(BYTES);
  });

  it('ignores a returned non-promise (a runtime returning something odd)', async () => {
    const buf = fakeBuffer(0.4);
    const ctx: AudioDecoder = {
      decodeAudioData: (_d, ok) => {
        ok?.(buf);
        // Not a thenable — must not be treated as one.
        return undefined;
      },
    };
    await expect(decodeAudio(ctx, BYTES)).resolves.toBe(buf);
  });
});
