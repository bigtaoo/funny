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
const URI_FILE = join(tmpdir(), 'nw-metaserver-mongo-uri');

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

export async function teardown(): Promise<void> {
  if (replset) await replset.stop();
  rmSync(URI_FILE, { force: true });
}
