// Unit tests for logger.ts. `threshold` and `LOG_DIR` are module-level consts evaluated once at
// import time from process.env.NW_LOG_LEVEL / NW_LOG_DIR, so any test that needs a different value
// for either must `vi.resetModules()` and re-`import('../src/logger')` dynamically — mutating
// process.env after the first import has no effect on an already-loaded module instance.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../src/logger';

const ENV_KEYS = ['NW_LOG_LEVEL', 'NW_LOG_DIR'] as const;
let envSnapshot: Record<string, string | undefined>;
const tempDirs: string[] = [];

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  vi.restoreAllMocks();
  vi.doUnmock('node:fs');
  vi.resetModules();
});

function newTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nw-logger-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Import a fresh instance of the logger module under the given env vars. */
async function freshLogger(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Promise<typeof import('../src/logger')> {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  vi.resetModules();
  return import('../src/logger');
}

/** createWriteStream()'s writes land asynchronously; poll briefly for the file + expected line count
 *  instead of assuming it's flushed the instant stream.write() returns. */
async function waitForLines(path: string, count: number, timeoutMs = 2000): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= count) return lines;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} line(s) in ${path}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('createLogger / level threshold', () => {
  it('defaults to debug when NW_LOG_LEVEL is unset (all levels emit)', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.debug('d');
    log.info('i');
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('defaults to debug when NW_LOG_LEVEL is an invalid value', async () => {
    const { createLogger } = await freshLogger({ NW_LOG_LEVEL: 'bogus' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.debug('d');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive for a valid NW_LOG_LEVEL value', async () => {
    const { createLogger } = await freshLogger({ NW_LOG_LEVEL: 'WARN' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('svc');
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses debug/info and allows warn/error when threshold is warn', async () => {
    const { createLogger } = await freshLogger({ NW_LOG_LEVEL: 'warn' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('svc');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('only allows error when threshold is error', async () => {
    const { createLogger } = await freshLogger({ NW_LOG_LEVEL: 'error' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('svc');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('console line formatting', () => {
  it('routes info/debug to console.log, warn to console.warn, error to console.error, with tag + msg', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('gateway');
    log.info('hello');
    log.warn('careful');
    log.error('boom');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('INFO'));
    expect(logSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('[gateway] hello'));
    expect(warnSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('WARN'));
    expect(warnSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('[gateway] careful'));
    expect(errorSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('ERROR'));
    expect(errorSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('[gateway] boom'));
  });

  it('appends formatted data fields to the console line', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('msg', { a: 1, b: 'x' });
    expect(logSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('a=1 b=x'));
  });

  it('omits data suffix entirely when data is undefined', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('plain');
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line.endsWith('plain')).toBe(true);
  });

  it('formats an Error value in data as its .message', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('failed', { err: new Error('kaboom') });
    expect(logSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('err=kaboom'));
  });

  it('JSON.stringifies a plain object value', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('withObj', { payload: { x: 1, y: 2 } });
    expect(logSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('payload={"x":1,"y":2}'));
  });

  it('falls back to String(v) when JSON.stringify throws on a circular object', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info('circ', { o: circular });
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toEqual(expect.stringContaining('o=[object Object]'));
  });

  it('collapses embedded newlines/whitespace in a data value to single spaces', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('multi', { text: 'line1\nline2\tline3' });
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toEqual(expect.stringContaining('text=line1 line2 line3'));
    expect(line).not.toContain('\n');
  });

  it('skips fields whose value is undefined', async () => {
    const { createLogger } = await freshLogger({});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('partial', { a: undefined, b: 2 });
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toEqual(expect.stringContaining('b=2'));
    expect(line).not.toContain('a=');
  });
});

describe('file sink', () => {
  it('is disabled (no file created, no throw) when NW_LOG_DIR is unset', async () => {
    const { createLogger } = await freshLogger({});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    expect(() => log.info('no file')).not.toThrow();
  });

  it('creates the log directory (mkdirSync recursive) and writes a structured JSON line', async () => {
    const base = newTempDir();
    const dir = join(base, 'nested', 'logs'); // does not exist yet — exercises ensureDir()'s mkdirSync
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svcname');
    log.info('hello file', { k: 'v', err: new Error('bad'), skip: undefined });
    expect(existsSync(dir)).toBe(true);
    const [line] = await waitForLines(join(dir, 'svcname.log'), 1);
    const rec = JSON.parse(line!);
    expect(rec).toMatchObject({ level: 'info', svc: 'svcname', msg: 'hello file', k: 'v', err: 'bad' });
    expect(rec.skip).toBeUndefined();
    expect(typeof rec.t).toBe('string');
  });

  it('groups tags sharing a root (before the first colon) into the same log file', async () => {
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('gateway:internal').info('one');
    createLogger('gateway:matchsvc').info('two');
    const lines = await waitForLines(join(dir, 'gateway.log'), 2);
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs[0]).toMatchObject({ svc: 'gateway:internal', msg: 'one' });
    expect(recs[1]).toMatchObject({ svc: 'gateway:matchsvc', msg: 'two' });
  });

  it('reuses the same stream across multiple log calls for the same root (no re-creation)', async () => {
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('reused');
    log.info('first');
    log.info('second');
    log.info('third');
    const lines = await waitForLines(join(dir, 'reused.log'), 3);
    expect(lines).toHaveLength(3);
  });

  it('child() loggers group under the parent root while printing the combined tag', async () => {
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parent = createLogger('gateway');
    const child = parent.child('judge');
    child.info('child msg');
    expect(logSpy.mock.calls[0]![0]).toEqual(expect.stringContaining('[gateway:judge] child msg'));
    const lines = await waitForLines(join(dir, 'gateway.log'), 1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ svc: 'gateway:judge', msg: 'child msg' });
  });

  it('ensureDir() failure (mkdirSync throws) is swallowed: fileStream returns null, console still logs', async () => {
    // A pre-existing plain file cannot be used as a directory path component: mkdirSync(recursive)
    // fails against it on both POSIX and Windows.
    const base = newTempDir();
    const blockerFile = join(base, 'blocker');
    writeFileSync(blockerFile, 'not a directory');
    const dir = join(blockerFile, 'sub'); // parent path segment is a file -> mkdirSync must throw
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    expect(() => log.info('still logs')).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('mkdirSync failure is stably reproduced via a mocked node:fs (ensureDir returns false)', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        mkdirSync: vi.fn(() => {
          throw new Error('mock mkdir failure');
        }),
      };
    });
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: join(dir, 'wont-be-created') });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    expect(() => log.info('still logs')).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('createWriteStream failure is swallowed: streams.set(svc, null), fileStream returns null', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        createWriteStream: vi.fn(() => {
          throw new Error('mock stream failure');
        }),
      };
    });
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    log.info('first');
    log.info('second'); // exercises the streams.has(svc) cached-null branch too
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, 'svc.log'))).toBe(false);
  });

  it('a write() failure on an existing stream is caught and does not affect console output', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const fakeStream = {
        write: vi.fn(() => {
          throw new Error('mock write failure');
        }),
        on: vi.fn(),
      };
      return {
        ...actual,
        createWriteStream: vi.fn(() => fakeStream),
      };
    });
    const dir = newTempDir();
    const { createLogger } = await freshLogger({ NW_LOG_DIR: dir });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('svc');
    expect(() => log.info('resilient')).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe('exported type surface', () => {
  it('Logger interface methods are all present on a created logger', async () => {
    const { createLogger } = await freshLogger({});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const log: Logger = createLogger('svc');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });
});
