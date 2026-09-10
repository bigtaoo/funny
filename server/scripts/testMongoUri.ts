// The worker half of the Mongo test handshake, kept in its own module on purpose.
//
// Every package's `test/setupEnv.ts` is loaded in EVERY vitest worker, once per test file, so this
// module must stay dependency-free — `testMongoHarness.ts` next door pulls in
// mongodb-memory-server (download/extract machinery and all), which has no business being imported
// hundreds of times by processes that only need to read a URI out of a file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Handshake file: globalSetup runs in the main process, but test files read
 * process.env.NW_MONGO_URI at module load inside worker processes, which never inherited it.
 * tmpdir() is location-independent across both. Shared so the writer and the reader cannot drift.
 */
export function mongoUriHandshakePath(pkg: string): string {
  return join(tmpdir(), `nw-${pkg}-mongo-uri`);
}

/**
 * Bridge the URI globalSetup produced into this worker's process.env — the whole body of every
 * package's `test/setupEnv.ts`.
 *
 * A no-op when NW_MONGO_URI is already set (external Mongo) or the handshake file is absent
 * (globalSetup deferred to an external DB); tests then fall back to their own default URI and
 * self-skip when it is unreachable. NW_REQUIRE_DB turns that silent skip into a failure, which is
 * what CI runs with — a suite that quietly tests nothing is worse than a red one.
 */
export function bridgeMongoUri(pkg: string): void {
  if (!process.env.NW_MONGO_URI) {
    try {
      const uri = readFileSync(mongoUriHandshakePath(pkg), 'utf8').trim();
      if (uri) process.env.NW_MONGO_URI = uri;
    } catch {
      // No handshake file — leave unset.
    }
  }

  if (process.env.NW_REQUIRE_DB && !process.env.NW_MONGO_URI) {
    throw new Error(
      `NW_REQUIRE_DB set but NW_MONGO_URI is still unset after the ${pkg} globalSetup handshake — mongod likely failed to start (see server/scripts/testMongoHarness.ts).`,
    );
  }
}
