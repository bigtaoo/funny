// Unit coverage for src/replayArchive.ts, importing directly from '../src/...' (not '../dist/...') so
// v8 coverage attributes executed lines back to source — see test/replayArchive.test.ts (imports
// '../dist/replayArchive.js', so its otherwise-thorough coverage of this module's *behavior* records
// 0% against src/replayArchive.ts). Scenarios below mirror that file (read first, per the task brief)
// plus additional module-instances built with a fresh `NW_REPLAY_ARCHIVE_DIR` (via vi.resetModules() +
// dynamic re-import, since ARCHIVE_DIR is captured once at module load) to reach the branches the
// single shared-env instance used everywhere else in this suite can't: disabled (env unset), and the
// mkdir/readdir/writeFile failure catches (module pointed at a path that can't work as a directory).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MatchDoc } from '@nw/shared';

const ORIGINAL_ARCHIVE_DIR = process.env.NW_REPLAY_ARCHIVE_DIR;

function baseMatch(roomId: string, extra: Partial<MatchDoc> = {}): MatchDoc {
  return {
    roomId,
    mode: 'ranked',
    seed: '1',
    players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
    winner: 0,
    reason: 'base',
    hashOk: true,
    ts: 1000,
    ...extra,
  };
}

afterEach(() => {
  // Every dynamic-import scenario below sets NW_REPLAY_ARCHIVE_DIR temporarily; restore the value the
  // rest of this worker's test files expect (set once by test/setupEnv.ts) after each test.
  if (ORIGINAL_ARCHIVE_DIR === undefined) delete process.env.NW_REPLAY_ARCHIVE_DIR;
  else process.env.NW_REPLAY_ARCHIVE_DIR = ORIGINAL_ARCHIVE_DIR;
});

// ── Enabled, functioning archive dir (mirrors test/replayArchive.test.ts's scenarios, src-attributed) ──
describe('replayArchive (enabled, src import)', () => {
  let ARCHIVE_DIR: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: typeof import('../src/replayArchive.js');
  const written: string[] = [];

  beforeAll(async () => {
    ARCHIVE_DIR = await mkdtemp(join(tmpdir(), 'nw-replay-archive-unit-'));
    process.env.NW_REPLAY_ARCHIVE_DIR = ARCHIVE_DIR;
    vi.resetModules();
    mod = await import('../src/replayArchive.js');
  });

  afterAll(async () => {
    await rm(ARCHIVE_DIR, { recursive: true, force: true });
  });

  it('archiveEnabled() is true once NW_REPLAY_ARCHIVE_DIR is set', () => {
    expect(mod.archiveEnabled()).toBe(true);
  });

  it('ensureArchiveDir creates the directory (idempotent, safe to call twice)', async () => {
    await mod.ensureArchiveDir();
    await mod.ensureArchiveDir();
    const st = await fs.stat(ARCHIVE_DIR);
    expect(st.isDirectory()).toBe(true);
  });

  it('archiveMatch writes meta.json + replay.gz, both readable back', async () => {
    const roomId = 'U-ARC1';
    written.push(roomId);
    const match = baseMatch(roomId);
    const replayGzBuf = Buffer.from('fake-gzip-bytes');
    mod.archiveMatch(match, replayGzBuf);
    await new Promise((r) => setTimeout(r, 50));

    const meta = await mod.readArchivedMeta(roomId);
    expect(meta?.roomId).toBe(roomId);
    expect(meta?.players).toEqual(match.players);
    expect(meta?.mode).toBe('ranked');
    expect(meta?.winner).toBe(0);
    expect(meta?.hashOk).toBe(true);

    const gz = await mod.readArchivedReplayGz(roomId);
    expect(gz?.equals(replayGzBuf)).toBe(true);
  });

  it('skips disputed matches (hashMismatch=true) — no files written', async () => {
    const roomId = 'U-ARC2';
    written.push(roomId);
    mod.archiveMatch(baseMatch(roomId, { hashMismatch: true }), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await mod.readArchivedMeta(roomId)).toBeNull();
    expect(await mod.readArchivedReplayGz(roomId)).toBeNull();
  });

  it('skips disputed matches (cheat conviction) — no files written', async () => {
    const roomId = 'U-ARC3';
    written.push(roomId);
    mod.archiveMatch(baseMatch(roomId, { cheat: { side: 0, accountId: 'a' } }), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await mod.readArchivedMeta(roomId)).toBeNull();
  });

  it('readArchivedReplayGz/readArchivedMeta return null for an unknown roomId (treated as a plain 404)', async () => {
    expect(await mod.readArchivedReplayGz('U-NOPE')).toBeNull();
    expect(await mod.readArchivedMeta('U-NOPE')).toBeNull();
  });

  it('sweepArchive deletes files older than the 365-day retention window, keeps newer ones', async () => {
    const oldRoom = 'U-ARC-OLD';
    const freshRoom = 'U-ARC-FRESH';
    written.push(oldRoom, freshRoom);
    mod.archiveMatch(baseMatch(oldRoom), Buffer.from('old'));
    mod.archiveMatch(baseMatch(freshRoom), Buffer.from('fresh'));
    await new Promise((r) => setTimeout(r, 50));

    const oldTime = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await fs.utimes(join(ARCHIVE_DIR, `${oldRoom}.meta.json`), oldTime, oldTime);
    await fs.utimes(join(ARCHIVE_DIR, `${oldRoom}.replay.gz`), oldTime, oldTime);

    await mod.sweepArchive();

    expect(await mod.readArchivedReplayGz(oldRoom)).toBeNull();
    expect(await mod.readArchivedMeta(oldRoom)).toBeNull();
    expect(await mod.readArchivedReplayGz(freshRoom)).not.toBeNull();
  });

  it('sweepArchive accepts a custom `now` function (used by index.ts to inject a fixed clock)', async () => {
    const roomId = 'U-ARC-CUSTOM-NOW';
    written.push(roomId);
    mod.archiveMatch(baseMatch(roomId), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    // A `now` far in the future makes every file "old" relative to the retention window.
    await mod.sweepArchive(() => Date.now() + 400 * 24 * 3600 * 1000);
    expect(await mod.readArchivedReplayGz(roomId)).toBeNull();
  });
});

// ── Disabled: NW_REPLAY_ARCHIVE_DIR unset at module load → every function is a documented no-op ──
describe('replayArchive (disabled, src import)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: typeof import('../src/replayArchive.js');

  beforeAll(async () => {
    delete process.env.NW_REPLAY_ARCHIVE_DIR;
    vi.resetModules();
    mod = await import('../src/replayArchive.js');
  });

  it('archiveEnabled() is false', () => {
    expect(mod.archiveEnabled()).toBe(false);
  });

  it('ensureArchiveDir is a no-op (resolves without touching the filesystem)', async () => {
    await expect(mod.ensureArchiveDir()).resolves.toBeUndefined();
  });

  it('archiveMatch is a no-op (no error, nothing to read back)', async () => {
    mod.archiveMatch(baseMatch('D-ARC1'), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 20));
    expect(await mod.readArchivedReplayGz('D-ARC1')).toBeNull();
  });

  it('readArchivedReplayGz/readArchivedMeta return null unconditionally', async () => {
    expect(await mod.readArchivedReplayGz('anything')).toBeNull();
    expect(await mod.readArchivedMeta('anything')).toBeNull();
  });

  it('sweepArchive is a no-op (resolves without touching the filesystem)', async () => {
    await expect(mod.sweepArchive()).resolves.toBeUndefined();
  });
});

// ── Failure branches: module instances pointed at a path that cannot function as a directory ──
describe('replayArchive (failure branches, src import)', () => {
  it('ensureArchiveDir: mkdir fails (path already exists as a regular file, not a directory) — caught + logged, does not throw', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'nw-replay-archive-fail-'));
    const fileAsDir = join(parent, 'not-a-directory');
    await writeFile(fileAsDir, 'i am a file, not a directory');
    process.env.NW_REPLAY_ARCHIVE_DIR = fileAsDir;
    vi.resetModules();
    const mod = await import('../src/replayArchive.js');
    await expect(mod.ensureArchiveDir()).resolves.toBeUndefined();
    await rm(parent, { recursive: true, force: true });
  });

  it('archiveMatch: writeFile fails (archive dir does not exist on disk) — fire-and-forget catch, does not throw or reject', async () => {
    const nonExistentDir = join(tmpdir(), `nw-replay-archive-never-created-${Date.now()}`);
    process.env.NW_REPLAY_ARCHIVE_DIR = nonExistentDir;
    vi.resetModules();
    const mod = await import('../src/replayArchive.js');
    expect(() => mod.archiveMatch(baseMatch('F-ARC1'), Buffer.from('x'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    // Nothing was ever written (directory never existed) — reads still behave as a plain miss.
    expect(await mod.readArchivedReplayGz('F-ARC1')).toBeNull();
  });

  it('sweepArchive: readdir fails (archive dir does not exist on disk) — caught + logged, resolves without throwing', async () => {
    const nonExistentDir = join(tmpdir(), `nw-replay-archive-never-created-2-${Date.now()}`);
    process.env.NW_REPLAY_ARCHIVE_DIR = nonExistentDir;
    vi.resetModules();
    const mod = await import('../src/replayArchive.js');
    await expect(mod.sweepArchive()).resolves.toBeUndefined();
  });
});
