// Vitest globalSetup: spin up a single-node replica set (rs0) via mongodb-memory-server
// so the e2e suite has a real Mongo with transaction support — no Docker, no manual install.
//
// Skipped entirely when NW_MONGO_URI is already set, so an external Mongo (a native rs0
// install, a CI service, or a remote DB) always takes precedence.
//
// The mongod binary is downloaded once to a shared global cache (~/.cache/mongodb-binaries)
// on first run, then reused offline forever. Pin MONGOD_VERSION below — never let it float.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Handshake file: globalSetup runs in the main process, but the e2e files read
// process.env.NW_MONGO_URI at module load inside worker processes. setupEnv.ts reads
// this file per-worker to bridge the gap. tmpdir() is location-independent across both.
const URI_FILE = join(tmpdir(), 'nw-worldsvc-mongo-uri');

// Pinned mongod binary version — bump deliberately, never float. Must stay compatible
// with the mongodb driver (^6.10) and mirror what prod/compose runs.
const MONGOD_VERSION = '7.0.14';

let replset: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
  if (process.env.NW_MONGO_URI) return;

  replset = await MongoMemoryReplSet.create({
    binary: { version: MONGOD_VERSION },
    replSet: { name: 'rs0', count: 1 },
  });

  let uri = replset.getUri();
  // Force replica-set topology discovery so multi-doc transactions work.
  if (!/[?&]replicaSet=/.test(uri)) {
    uri += (uri.includes('?') ? '&' : '?') + 'replicaSet=rs0';
  }
  process.env.NW_MONGO_URI = uri;
  writeFileSync(URI_FILE, uri, 'utf8');
}

// Teardown runs after every test has already reported, so a failure to shut the replset down cannot
// invalidate a single assertion — but before 2026-09-09 it could still turn the whole run red with no
// message at all, because `replset.stop()` was awaited bare. Measured root cause (worldsvc,
// `DEBUG=MongoMS:*` over a full coverage run): after ~700s of e2e traffic mongod needs **15.1s** to
// actually exit once asked, against the 10s+10s deadline hard-coded in mongodb-memory-server's
// `killProcess` — i.e. under 5s of slack, which a busier machine or a fatter DB eats. Past that
// deadline MMS is inconsistent about what it does: a mongod that outlives it makes `stop()` return
// `false` SILENTLY (MongoMemoryReplSet.stop swallows it and skips its own cleanup, so the run exits 0
// while leaking a live mongod plus a 20k-file dbPath — 20 such orphans were sitting in %TEMP%), while a
// `cleanup()` that trips over still-mapped WiredTiger files throws all the way out here and reds the run.
//
// So: report the tests' verdict, never a teardown hiccup, but say so loudly enough that the NEXT
// occurrence names itself instead of being re-diagnosed from an exit code. `::warning::` is the same
// channel scripts/flakyReporter.mjs uses for retry-masked flakes.
export async function teardown(): Promise<void> {
  // Unlink first: a stop() that throws used to leave the handshake file pointing at a dead mongod.
  rmSync(URI_FILE, { force: true });
  if (!replset) return;

  // Captured before stop(), which clears instanceInfo on the success path.
  const tmpDirs = replset.servers.map((s) => s.instanceInfo?.tmpDir).filter((d): d is string => !!d);

  try {
    // `stop()` REPORTS failure rather than throwing it in the mongod-outlived-the-deadline case, which is
    // the silent mode above — so the boolean matters as much as the catch.
    if (await replset.stop()) return;
    console.log(`::warning::worldsvc test teardown: replset.stop() reported failure — mongod probably outlived mongodb-memory-server's 10s+10s kill deadline and may still be running`);
  } catch (err) {
    console.log(`::warning::worldsvc test teardown: replset.stop() threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // MMS skips its own cleanup whenever stop() reported failure, so do it here or the dbPath leaks for
  // good. Retries cover the common case: mongod died just past the deadline and Windows has not yet
  // released the WiredTiger files. `tmpDir` only, i.e. exactly what MMS's cleanup() would have removed —
  // an externally supplied dbPath is never ours to delete.
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.log(`::warning::worldsvc test teardown: could not remove ${dir} — ${err instanceof Error ? err.message : String(err)}; a mongod may still be holding it`);
    }
  }
}
