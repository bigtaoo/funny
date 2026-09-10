// Per-worker setup: bridge the URI globalSetup produced in the main process into this worker's
// process.env, before any test module reads NW_MONGO_URI at module load.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeMongoUri } from '../../scripts/testMongoUri';

bridgeMongoUri('metaserver');

// replayArchive.ts reads NW_REPLAY_ARCHIVE_DIR once at module load — set it here (before any test
// module imports app.js/replayArchive.js) so the cold-tier disk-archive path is exercisable in tests,
// same as it would be in prod with the docker volume mounted. Harmless for every other test file: the
// archive/read/sweep functions are no-ops for roomIds they were never called with.
if (!process.env.NW_REPLAY_ARCHIVE_DIR) {
  process.env.NW_REPLAY_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'nw-replay-archive-'));
}
