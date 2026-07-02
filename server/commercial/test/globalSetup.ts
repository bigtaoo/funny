// Vitest globalSetup: spin up a standalone mongod via mongodb-memory-server so the e2e
// suite has a real Mongo — no Docker, no manual install. commercial performs only
// single-document atomic operations (no multi-doc transactions), so a standalone server
// is sufficient (unlike worldsvc, which needs an rs0 replica set for transactions).
//
// Skipped entirely when NW_MONGO_URI is already set, so an external Mongo (a native
// install, a CI service, or a remote DB) always takes precedence.
//
// The mongod binary is downloaded once to a shared global cache (~/.cache/mongodb-binaries)
// on first run, then reused offline forever. Pin MONGOD_VERSION below — never let it float.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Handshake file: globalSetup runs in the main process, but the e2e files read
// process.env.NW_MONGO_URI at module load inside worker processes. setupEnv.ts reads
// this file per-worker to bridge the gap. tmpdir() is location-independent across both.
const URI_FILE = join(tmpdir(), 'nw-commercial-mongo-uri');

// Pinned mongod binary version — bump deliberately, never float. Mirrors worldsvc/socialsvc's
// harness so all suites share one cached binary; stays compatible with the mongodb driver (^6.10).
const MONGOD_VERSION = '7.0.14';

let mongod: MongoMemoryServer | undefined;

export async function setup(): Promise<void> {
  if (process.env.NW_MONGO_URI) return;

  mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
  const uri = mongod.getUri();
  process.env.NW_MONGO_URI = uri;
  writeFileSync(URI_FILE, uri, 'utf8');
}

export async function teardown(): Promise<void> {
  if (mongod) await mongod.stop();
  rmSync(URI_FILE, { force: true });
}
