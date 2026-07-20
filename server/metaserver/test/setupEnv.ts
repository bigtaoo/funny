// Per-worker setup: bridge the URI produced by globalSetup (main process) into each
// worker's process.env before any e2e module reads NW_MONGO_URI at load time.
//
// If NW_MONGO_URI is already set (external Mongo) or the handshake file is absent
// (globalSetup deferred to an external DB), this is a no-op and tests self-skip when
// the DB is unreachable.
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

if (!process.env.NW_MONGO_URI) {
  try {
    process.env.NW_MONGO_URI = readFileSync(join(tmpdir(), 'nw-metaserver-mongo-uri'), 'utf8').trim();
  } catch {
    // No handshake file — leave unset; e2e files fall back to their default URI and skip if down.
  }
}

// replayArchive.ts reads NW_REPLAY_ARCHIVE_DIR once at module load — set it here (before any test
// module imports app.js/replayArchive.js) so the cold-tier disk-archive path is exercisable in tests,
// same as it would be in prod with the docker volume mounted. Harmless for every other test file: the
// archive/read/sweep functions are no-ops for roomIds they were never called with.
if (!process.env.NW_REPLAY_ARCHIVE_DIR) {
  process.env.NW_REPLAY_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'nw-replay-archive-'));
}
