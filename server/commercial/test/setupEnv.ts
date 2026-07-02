// Per-worker setup: bridge the URI produced by globalSetup (main process) into each
// worker's process.env before any e2e module reads NW_MONGO_URI at load time.
//
// If NW_MONGO_URI is already set (external Mongo) or the handshake file is absent
// (globalSetup deferred to an external DB), this is a no-op and tests self-skip when
// the DB is unreachable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.NW_MONGO_URI) {
  try {
    process.env.NW_MONGO_URI = readFileSync(join(tmpdir(), 'nw-commercial-mongo-uri'), 'utf8').trim();
  } catch {
    // No handshake file — leave unset; e2e files fall back to their default URI and skip if down.
  }
}
