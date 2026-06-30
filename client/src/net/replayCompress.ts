// State-stream share blob compression (REPLAY_SHARE_DESIGN §7).
//
// The share blob is highly repetitive delta JSON (same structure frame by frame), so gzip
// compression ratios are very high (~10-20×). Sharing only happens on Web (requires fetch
// + online), so we use the browser's native CompressionStream/'gzip' directly; the compressed
// data is stored as a base64 string inside the existing JSON envelope (the server stores it
// opaquely without interpreting it). If CompressionStream is unavailable (old browsers /
// WeChat mini-game — the latter cannot reach the share path anyway), an error is thrown and
// the share UI provides a fallback message.

/** gzip magic bytes: used during unpacking to detect whether the blob is compressed (for backward compatibility with uncompressed plain-text blobs). */
const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;

function bytesToBase64(bytes: Uint8Array): string {
  // Build the binary string in chunks to avoid blowing the call stack with large arrays passed to String.fromCharCode.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** EncodedStateReplay → gzip → base64 string. Throws if the environment does not support compression (share UI provides the fallback). */
export async function packReplayBlob(enc: unknown): Promise<string> {
  const json = JSON.stringify(enc);
  if (typeof CompressionStream === 'undefined') {
    throw new Error('compression unavailable in this runtime');
  }
  const cs = new CompressionStream('gzip');
  const stream = new Blob([json]).stream().pipeThrough(cs);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToBase64(buf);
}

/** base64(gzip) → EncodedStateReplay. Also handles plain-text JSON (uncompressed legacy / degraded blobs). */
export async function unpackReplayBlob(packed: unknown): Promise<unknown> {
  // Compatibility: legacy / degraded paths may have stored a plain object instead of a compressed string.
  if (typeof packed !== 'string') return packed;
  const bytes = base64ToBytes(packed);
  // Copy into a concrete ArrayBuffer to work around the type issue where Uint8Array<ArrayBufferLike> does not satisfy BlobPart.
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC0 && bytes[1] === GZIP_MAGIC1) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([ab]).stream().pipeThrough(ds);
    const json = await new Response(stream).text();
    return JSON.parse(json) as unknown;
  }
  // Not gzip: treat as plain-text JSON (should not happen in practice; kept as a fallback).
  return JSON.parse(new TextDecoder().decode(ab)) as unknown;
}
