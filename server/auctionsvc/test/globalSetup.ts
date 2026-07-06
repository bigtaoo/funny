// Vitest globalSetup: spin up a standalone mongod via mongodb-memory-server (mirrors analyticsvc's harness).
// Skipped entirely when NW_MONGO_URI is already set, so an external Mongo takes precedence.
import { MongoMemoryServer } from 'mongodb-memory-server';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const URI_FILE = join(tmpdir(), 'nw-auctionsvc-mongo-uri');
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
