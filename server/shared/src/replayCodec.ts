// Pipeline A replay codec (S1-RP storage cost fix, 2026-07-20): the seed+command replay used for
// anti-cheat/settlement/watch-replay is JSON.stringify'd then gzip'd once as a whole, stored as raw
// bytes (BSON Binary via Buffer) in matches.replayGz / replayBlobs.replayGz. Command bytes inside
// (frames[].cmds[].commands) stay base64 opaque — only the outer JSON wrapper is compressed.
// Never decompress on the per-match write/store path (gameserver→metaserver report, matches insert) —
// only when the full structured replay is actually needed (peer-judge dispute, anti-cheat audit sample).
import { gzipSync, gunzipSync } from 'node:zlib';
import type { MatchReplayDoc } from './mongo';

export function compressReplayDoc(doc: MatchReplayDoc): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'));
}

export function decompressReplayDoc(buf: Buffer): MatchReplayDoc {
  // Documents read back from the MongoDB driver expose BSON binary fields as a `Binary` wrapper
  // (with a `.buffer` property), not a plain Buffer, even though our types declare `Buffer` — normalize
  // here so callers reading doc.replayGz straight off a found document don't need to know that.
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from((buf as unknown as { buffer: Uint8Array }).buffer);
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as MatchReplayDoc;
}
