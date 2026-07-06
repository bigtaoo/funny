// Per-worker setup: bridge the URI produced by globalSetup into each worker's process.env
// before any e2e module reads NW_MONGO_URI at load time (mirrors analyticsvc's harness).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.NW_MONGO_URI) {
  try {
    process.env.NW_MONGO_URI = readFileSync(join(tmpdir(), 'nw-auctionsvc-mongo-uri'), 'utf8').trim();
  } catch {
    // No handshake file — leave unset; e2e files fall back to their default URI and skip if down.
  }
}
