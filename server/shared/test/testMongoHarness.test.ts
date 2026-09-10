// Tests for server/scripts/testMongoHarness.ts + testMongoUri.ts — the Mongo harness every
// Mongo-backed package's vitest globalSetup/setupFiles calls.
//
// Same reasoning as coverageScripts.test.ts next door: this is infrastructure whose failure mode is
// invisible. The 2026-09-09 incident (claudedocs/server-testing-tooling.md) was a teardown that
// turned a 1410-case green run into exit 1 without printing a word, and the fix for it is a specific
// ORDER of operations plus one non-obvious flag (`doCleanup: false`) whose absence throws on an
// assertion deep inside mongodb-memory-server. Both are the kind of thing a later "simplification"
// removes on sight, so they are pinned here.
//
// What is NOT covered, deliberately: the graceful-shutdown round trip itself (connect, send
// `shutdown`, wait for the child to exit). That needs a real mongod, which the e2e suites of the
// eight packages already provide on every run — and a slow shutdown now announces itself with a
// `::warning::` carrying the measured seconds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mongoUriHandshakePath, bridgeMongoUri } from '../../scripts/testMongoUri';
import {
  teardownMongo,
  waitForExit,
  type MongoServerLike,
  type StoppableMongo,
} from '../../scripts/testMongoHarness';

/** A unique package name per test, so nothing here can read or clobber a real suite's handshake file. */
function uniquePkg(): string {
  return `harness-selftest-${Math.random().toString(36).slice(2)}`;
}

describe('mongoUriHandshakePath', () => {
  it('derives the file name from the package, under tmpdir', () => {
    expect(mongoUriHandshakePath('worldsvc')).toBe(join(tmpdir(), 'nw-worldsvc-mongo-uri'));
  });

  it('gives different packages different files (CI runs their shards concurrently)', () => {
    expect(mongoUriHandshakePath('worldsvc')).not.toBe(mongoUriHandshakePath('metaserver'));
  });
});

describe('bridgeMongoUri', () => {
  const saved = { uri: process.env.NW_MONGO_URI, require: process.env.NW_REQUIRE_DB };
  let pkg = '';

  beforeEach(() => {
    pkg = uniquePkg();
    delete process.env.NW_MONGO_URI;
    delete process.env.NW_REQUIRE_DB;
  });

  afterEach(() => {
    rmSync(mongoUriHandshakePath(pkg), { force: true });
    if (saved.uri === undefined) delete process.env.NW_MONGO_URI;
    else process.env.NW_MONGO_URI = saved.uri;
    if (saved.require === undefined) delete process.env.NW_REQUIRE_DB;
    else process.env.NW_REQUIRE_DB = saved.require;
  });

  it('reads the handshake file into NW_MONGO_URI, trimmed', () => {
    writeFileSync(mongoUriHandshakePath(pkg), '  mongodb://127.0.0.1:1234/?replicaSet=rs0\n', 'utf8');
    bridgeMongoUri(pkg);
    expect(process.env.NW_MONGO_URI).toBe('mongodb://127.0.0.1:1234/?replicaSet=rs0');
  });

  it('leaves an already-set NW_MONGO_URI alone — an external Mongo always wins', () => {
    process.env.NW_MONGO_URI = 'mongodb://external:27017';
    writeFileSync(mongoUriHandshakePath(pkg), 'mongodb://127.0.0.1:1234', 'utf8');
    bridgeMongoUri(pkg);
    expect(process.env.NW_MONGO_URI).toBe('mongodb://external:27017');
  });

  it('is a no-op when there is no handshake file', () => {
    expect(() => bridgeMongoUri(pkg)).not.toThrow();
    expect(process.env.NW_MONGO_URI).toBeUndefined();
  });

  it('does not set an empty NW_MONGO_URI from a truncated handshake file', () => {
    // An empty string is worse than unset: the DB-connect helpers read unset as "fall back to the
    // default URI", while an empty URI is what the mongodb driver rejects at parse time.
    writeFileSync(mongoUriHandshakePath(pkg), '   \n', 'utf8');
    bridgeMongoUri(pkg);
    expect(process.env.NW_MONGO_URI).toBeUndefined();
  });

  it('throws under NW_REQUIRE_DB when the handshake never happened, naming the package', () => {
    process.env.NW_REQUIRE_DB = '1';
    expect(() => bridgeMongoUri(pkg)).toThrow(new RegExp(`NW_REQUIRE_DB.*${pkg}`));
  });

  it('does not throw under NW_REQUIRE_DB once the URI is there', () => {
    process.env.NW_REQUIRE_DB = '1';
    writeFileSync(mongoUriHandshakePath(pkg), 'mongodb://127.0.0.1:1234', 'utf8');
    expect(() => bridgeMongoUri(pkg)).not.toThrow();
  });
});

/** A stand-in for mongod's ChildProcess: only `exitCode`/`signalCode` and the `exit` event are used. */
function fakeProc(opts: { exited: boolean }): ChildProcess & { emitExit(): void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { emitExit(): void };
  Object.assign(emitter, {
    exitCode: opts.exited ? 0 : null,
    signalCode: null,
    emitExit(): void {
      Object.assign(emitter, { exitCode: 0 });
      emitter.emit('exit', 0, null);
    },
  });
  return emitter;
}

describe('waitForExit', () => {
  it('resolves true immediately for a process that has already exited', async () => {
    // Budget 0: had this waited on the timer at all, it would have resolved false.
    await expect(waitForExit(fakeProc({ exited: true }), 0)).resolves.toBe(true);
  });

  it('resolves true when the process exits within the budget', async () => {
    const proc = fakeProc({ exited: false });
    const pending = waitForExit(proc, 5_000);
    proc.emitExit();
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the budget runs out, and leaves no listener behind', async () => {
    const proc = fakeProc({ exited: false });
    await expect(waitForExit(proc, 10)).resolves.toBe(false);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});

describe('teardownMongo', () => {
  let warnings: string[] = [];
  let uriFile = '';
  const dirs: string[] = [];

  /** A dbPath with something in it, so a removal that silently did nothing would not pass. */
  function tmpDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nw-harness-selftest-'));
    mkdirSync(join(dir, 'journal'));
    writeFileSync(join(dir, 'journal', 'WiredTigerLog.0000000001'), 'x', 'utf8');
    dirs.push(dir);
    return dir;
  }

  function server(tmpDir?: string): MongoServerLike {
    return {
      instanceInfo: {
        ip: '127.0.0.1',
        port: 27099,
        ...(tmpDir === undefined ? {} : { tmpDir }),
        // Already exited, so teardownMongo skips the graceful-shutdown round trip — the one part
        // that needs a real mongod.
        instance: { mongodProcess: fakeProc({ exited: true }) },
      },
    };
  }

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      warnings.push(String(msg));
    });
    uriFile = join(tmpdir(), `nw-harness-selftest-uri-${Math.random().toString(36).slice(2)}`);
    writeFileSync(uriFile, 'mongodb://127.0.0.1:27099', 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(uriFile, { force: true });
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('unlinks the handshake file, stops with doCleanup:false, and removes the dbPath itself', async () => {
    const a = tmpDbPath();
    const b = tmpDbPath();
    const stop = vi.fn().mockResolvedValue(true);
    const mongo: StoppableMongo = { servers: [server(a), server(b)], stop };

    await teardownMongo(mongo, 'worldsvc', uriFile);

    expect(existsSync(uriFile)).toBe(false);
    // `doCleanup: false` is load-bearing: MMS's own cleanup() asserts that mongodProcess is
    // undefined, which it never is once WE shut mongod down instead of letting MMS kill it.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ doCleanup: false, force: false });
    // ...which is exactly why removing the dbPath has to happen here rather than inside stop().
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('reports a stop() that returns false — the silent path — and still removes the dbPath', async () => {
    const dir = tmpDbPath();
    const mongo: StoppableMongo = { servers: [server(dir)], stop: vi.fn().mockResolvedValue(false) };

    await teardownMongo(mongo, 'metaserver', uriFile);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning::metaserver test teardown:');
    expect(warnings[0]).toContain('stop() reported failure');
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a stop() that throws and still removes the dbPath', async () => {
    const dir = tmpDbPath();
    const mongo: StoppableMongo = {
      servers: [server(dir)],
      stop: vi
        .fn()
        .mockRejectedValue(new Error('Cannot cleanup because "instance.mongodProcess" is still defined')),
    };

    await teardownMongo(mongo, 'socialsvc', uriFile);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning::socialsvc test teardown:');
    expect(warnings[0]).toContain('stop() threw');
    expect(warnings[0]).toContain('instance.mongodProcess');
    expect(existsSync(dir)).toBe(false);
  });

  it('names the directory it could not remove instead of throwing out of teardown', async () => {
    // A NUL byte makes rmSync reject the path outright — a stand-in for the real condition (Windows
    // still holding WiredTiger files), which is not reproducible on demand. What is pinned here is
    // that such a failure becomes a named warning rather than a thrown teardown, because a thrown
    // teardown reds a run whose every assertion already passed.
    const mongo: StoppableMongo = {
      servers: [server('bad\u0000path')],
      stop: vi.fn().mockResolvedValue(true),
    };

    await teardownMongo(mongo, 'admin', uriFile);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning::admin test teardown:');
    expect(warnings[0]).toContain('could not remove');
  });

  it('survives a server that never produced instanceInfo (mongod failed to start)', async () => {
    const stop = vi.fn().mockResolvedValue(true);

    await teardownMongo({ servers: [{}], stop }, 'shared', uriFile);

    expect(existsSync(uriFile)).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });
});
