// The Mongo harness behind every server package's vitest `globalSetup` / `setupFiles`.
//
// There used to be eight near-identical copies of this file (one per package that needs a real
// Mongo), which is why the teardown bug written up in claudedocs/server-testing-tooling.md
// ("worldsvc 全量跑的退出码非确定性") could be fixed in worldsvc and still be live in the other
// seven. One implementation, two shapes:
//
//   replSet: true   single-node rs0 — needed for multi-document transactions (worldsvc, metaserver)
//   replSet: false  standalone mongod — enough for single-doc atomics and index creation
//
// Skipped entirely when NW_MONGO_URI is already set, so an external Mongo (a native install, a CI
// service, a remote DB) always takes precedence.
//
// The mongod binary is downloaded once into a shared global cache (~/.cache/mongodb-binaries) and
// reused offline forever after. MONGOD_VERSION is pinned on purpose — never let it float.
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { appendFileSync, writeFileSync, rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { mongoUriHandshakePath } from './testMongoUri';

/** Pinned mongod binary — bump deliberately. Must stay compatible with the mongodb driver (^6.10) and mirror what prod/compose runs. */
export const MONGOD_VERSION = '7.0.14';

/**
 * How long we are willing to wait for mongod to finish its own graceful shutdown. Generous on
 * purpose: this budget is ours, it is not a race (see `stopMongod`), and blowing it only downgrades
 * teardown to mongodb-memory-server's own kill path — the same thing that used to happen always.
 */
const SHUTDOWN_WAIT_MS = 120_000;

/** Warn above this: a shutdown this slow is pure wall clock burnt every single run, worth seeing. */
const SHUTDOWN_WARN_MS = 8_000;

export interface MongoHarnessOptions {
  /** Package name. Names the handshake file and the ::warning:: lines, so a teardown hiccup says whose suite it came from. */
  pkg: string;
  /** true = single-node rs0, for suites that use multi-document transactions. false = standalone mongod. */
  replSet: boolean;
}

/** The two exports vitest's `globalSetup` expects. */
export interface MongoHarness {
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

export function createMongoHarness({ pkg, replSet }: MongoHarnessOptions): MongoHarness {
  const uriFile = mongoUriHandshakePath(pkg);
  let mongo: MongoMemoryReplSet | MongoMemoryServer | undefined;

  return {
    async setup(): Promise<void> {
      if (process.env.NW_MONGO_URI) return;

      let uri: string;
      if (replSet) {
        const rs = await MongoMemoryReplSet.create({
          binary: { version: MONGOD_VERSION },
          replSet: { name: 'rs0', count: 1 },
        });
        mongo = rs;
        uri = rs.getUri();
        // Force replica-set topology discovery so multi-doc transactions work.
        if (!/[?&]replicaSet=/.test(uri)) uri += (uri.includes('?') ? '&' : '?') + 'replicaSet=rs0';
      } else {
        const standalone = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
        mongo = standalone;
        uri = standalone.getUri();
      }

      process.env.NW_MONGO_URI = uri;
      writeFileSync(uriFile, uri, 'utf8');
    },

    async teardown(): Promise<void> {
      if (!mongo) {
        rmSync(uriFile, { force: true });
        return;
      }
      await teardownMongo(asStoppable(mongo), pkg, uriFile);
    },
  };
}

/**
 * The slice of mongodb-memory-server's API that teardown actually touches. Structural on purpose:
 * both `MongoMemoryServer` and `MongoMemoryReplSet` satisfy it, and so does a plain object, which is
 * what makes the sequencing below testable without a real mongod (see
 * shared/test/testMongoHarness.test.ts).
 */
export interface MongoServerLike {
  instanceInfo?: {
    ip: string;
    port: number;
    tmpDir?: string;
    instance: { mongodProcess?: ChildProcess };
  };
}

export interface StoppableMongo {
  servers: readonly MongoServerLike[];
  stop(opts: { doCleanup: boolean; force: boolean }): Promise<boolean>;
}

function asStoppable(mongo: MongoMemoryReplSet | MongoMemoryServer): StoppableMongo {
  const servers = mongo instanceof MongoMemoryReplSet ? mongo.servers : [mongo];
  return { servers, stop: (opts) => mongo.stop(opts) };
}

/**
 * Shut every mongod down, then clean up after it. The order here is the whole point, so it lives in
 * one named function with its own tests rather than inline in a closure.
 */
export async function teardownMongo(mongo: StoppableMongo, pkg: string, uriFile: string): Promise<void> {
  // Unlink first: a stop() that throws used to leave the handshake file pointing at a dead mongod.
  rmSync(uriFile, { force: true });

  // Captured before stop(), which empties `servers` on the replset path.
  const tmpDirs = mongo.servers.map((s) => s.instanceInfo?.tmpDir).filter((d): d is string => !!d);

  for (const server of mongo.servers) await stopMongod(server, pkg);

  try {
    // `doCleanup: false` is required, not a preference: mongodb-memory-server's cleanup() ASSERTS
    // that `instance.mongodProcess` is undefined, and that only happens on the path where MMS
    // itself did the killing. Our mongod is already gone by now, so MMS takes its "nothing to
    // shutdown, skipping" branch, leaves the handle set, and its own cleanup would throw on that
    // assertion — turning a green run red, i.e. exactly the failure this whole exercise is about,
    // with the sign flipped. What this call is still for: MMS's `killerProcess` (the watchdog that
    // would kill mongod if this process died) gets reaped inside it.
    //
    // Both failure modes are still reported. stop() REPORTS the mongod-outlived-the-deadline case
    // by returning false rather than throwing, so the boolean matters as much as the catch.
    if (!(await mongo.stop({ doCleanup: false, force: false }))) {
      warn(pkg, 'stop() reported failure — a mongod or its killer process may still be running');
    }
  } catch (err) {
    warn(pkg, `stop() threw — ${message(err)}`);
  }

  // Removing the dbPath is ours now, which also means it happens on every path instead of only when
  // MMS decided to skip it. Retries cover a mongod that has only just died and whose WiredTiger
  // files Windows has not released yet — an unretried rm on those is EPERM/EBUSY, and MMS's own
  // removeDir() passes no maxRetries at all, which is how an all-green run used to exit 1.
  // `tmpDir` only, i.e. exactly what MMS's cleanup() would have removed — an externally supplied
  // dbPath is never ours to delete.
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      warn(pkg, `could not remove ${dir} — ${message(err)}; a mongod may still be holding it`);
    }
  }
}

/**
 * Take one mongod down on OUR clock, then let mongodb-memory-server do its bookkeeping.
 *
 * Why not just `stop()`: for a replica set MMS asks mongod to shut down and then sends SIGINT a
 * second later, while mongod is still shutting down — and gives it 10s to react plus 10s more after
 * escalating to SIGKILL, both halves hard-coded in its `killProcess`. That extra SIGINT is the
 * actual defect. Reproduced at realistic scale, a mongod that gets it mid-shutdown never emits
 * `exit` at all (3 of 3 attempts): node's event loop just drains. MMS's `killProcess` IS
 * `await childprocess.once('exit')`, so no event means it waits out both timeouts and rejects,
 * `stop()` returns `false`, MMS skips its own cleanup — and the run exits 0 having leaked the whole
 * dbPath. That is where the 21 orphaned `mongo-mem-*` directories (11.12 GB) came from. The other
 * observed shape of the same trigger is a 15.1s delay before `exit` finally arrives, against a 20s
 * deadline. Details, including the shutdown-phase breakdown: claudedocs/server-testing-tooling.md.
 *
 * So we ask mongod to shut down ourselves, send no signal at all, and wait for its `exit` with no
 * deadline but our own. By the time `stop()` runs the pid is gone, its `killProcess` takes the
 * "PID was not alive anymore" early return, and neither the signal nor the 10s+10s race happens.
 * Measured cost of what is left: 3.9s for a full worldsvc run, 98% of it inside
 * `Closing WiredTiger`, i.e. real work rather than a timeout.
 *
 * The standalone suites gain the graceful shutdown too — MMS only sends the `shutdown` command for
 * replica sets, so on Windows those mongods were being hard-killed outright, which is exactly how a
 * dbPath ends up full of files nobody has released.
 */
async function stopMongod(server: MongoServerLike, pkg: string): Promise<void> {
  const info = server.instanceInfo;
  const proc = info?.instance.mongodProcess;
  if (!info || !proc || hasExited(proc)) return;

  const started = Date.now();
  const stopTap = tapShutdownLog(proc);
  try {
    const client = await MongoClient.connect(`mongodb://${info.ip}:${info.port}/admin`, {
      serverSelectionTimeoutMS: 5_000,
      directConnection: true,
    });
    try {
      // `timeoutSecs: 1` mirrors MMS: it caps how long the primary waits for a secondary to catch
      // up, and with a single-node set there is never one to wait for.
      await client.db('admin').command({ shutdown: 1, force: true, timeoutSecs: 1 });
    } finally {
      await client.close();
    }
  } catch {
    // mongod drops the connection the instant it accepts `shutdown`, so this command almost always
    // rejects with a network error — that IS the success path. What settles it is whether the
    // process exits below, so swallow whatever happened here and go look.
  }

  const exited = await waitForExit(proc, SHUTDOWN_WAIT_MS);
  stopTap();
  const elapsed = Date.now() - started;
  if (!exited) {
    warn(pkg, `mongod was still alive ${SHUTDOWN_WAIT_MS / 1000}s after the shutdown command — falling back to mongodb-memory-server's kill path`);
    return;
  }
  if (elapsed >= SHUTDOWN_WARN_MS) {
    warn(pkg, `mongod took ${(elapsed / 1000).toFixed(1)}s to shut down — wall clock burnt every run, see claudedocs/server-testing-tooling.md`);
  }
}

/**
 * Optional diagnostic tap: `NW_TEST_MONGO_SHUTDOWN_LOG=<file>` appends mongod's OWN log lines for
 * the shutdown window to that file. mongod times its shutdown steps itself — the one that matters
 * is `"id":4795901,"msg":"WiredTiger closed"` and its `durationMillis` — so this is the cheap way
 * to find out WHERE a slow shutdown goes, without re-running the whole suite under
 * `DEBUG=MongoMS:*` (which logs every line mongod emits over the entire run and roughly quadruples
 * it). Off by default and behaviour-free either way.
 */
function tapShutdownLog(proc: ChildProcess): () => void {
  const file = process.env.NW_TEST_MONGO_SHUTDOWN_LOG;
  if (!file || !proc.stdout) return () => {};
  const onData = (chunk: Buffer | string): void => {
    try {
      appendFileSync(file, String(chunk));
    } catch {
      // A diagnostic that cannot write must not be the thing that breaks teardown.
    }
  };
  proc.stdout.on('data', onData);
  return () => proc.stdout?.off('data', onData);
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** Exported for shared/test/testMongoHarness.test.ts — the budget above is far too long to wait out in a test. */
export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

/**
 * Teardown runs after every test has already reported, so nothing that happens here can invalidate
 * an assertion — which is why it must NOT red the run. But it has to be loud enough that the next
 * occurrence names itself instead of being re-diagnosed from a bare exit code. `::warning::` is the
 * same channel scripts/flakyReporter.mjs uses for retry-masked flakes.
 */
function warn(pkg: string, msg: string): void {
  console.log(`::warning::${pkg} test teardown: ${msg}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
