// Small gzip helper for Pipeline A (server-authoritative match replay, S1-RP storage cost fix,
// 2026-07-20). The server now returns the seed+command replay as a compressed `replayGz` string
// (base64(gzip(JSON))) instead of decoding it server-side — decompression is pushed to the client to
// save bandwidth (mirrors the pattern already proven in net/replayCompress.ts for the unrelated
// state-stream share pipeline).
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64(gzip(bytes)) → decompressed Uint8Array. Throws if the environment lacks DecompressionStream. */
export async function gunzipBase64(b64: string): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('decompression unavailable in this runtime');
  }
  const bytes = base64ToBytes(b64);
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([ab]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
