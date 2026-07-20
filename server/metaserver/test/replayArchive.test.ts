// Cold-tier disk archive (S1-RP, 2026-07-20) — pure filesystem module, no Mongo needed.
// NW_REPLAY_ARCHIVE_DIR is set globally to a mkdtemp dir by test/setupEnv.ts before this module loads.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MatchDoc } from '@nw/shared';
import {
  archiveMatch,
  archiveEnabled,
  readArchivedMeta,
  readArchivedReplayGz,
  sweepArchive,
} from '../dist/replayArchive.js';

const ARCHIVE_DIR = process.env.NW_REPLAY_ARCHIVE_DIR!;

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

describe('replayArchive', () => {
  const written: string[] = [];
  afterAll(async () => {
    await Promise.all(
      written.flatMap((roomId) => [
        fs.unlink(join(ARCHIVE_DIR, `${roomId}.meta.json`)).catch(() => {}),
        fs.unlink(join(ARCHIVE_DIR, `${roomId}.replay.gz`)).catch(() => {}),
      ]),
    );
  });

  it('setupEnv wired NW_REPLAY_ARCHIVE_DIR so archiving is actually enabled in tests', () => {
    expect(archiveEnabled()).toBe(true);
  });

  it('writes meta.json + replay.gz, both readable back', async () => {
    const roomId = 'ARC1';
    written.push(roomId);
    const match = baseMatch(roomId);
    const replayGzBuf = Buffer.from('fake-gzip-bytes');
    archiveMatch(match, replayGzBuf);
    await new Promise((r) => setTimeout(r, 50)); // fire-and-forget write

    const meta = await readArchivedMeta(roomId);
    expect(meta?.roomId).toBe(roomId);
    expect(meta?.players).toEqual(match.players);

    const gz = await readArchivedReplayGz(roomId);
    expect(gz?.equals(replayGzBuf)).toBe(true);
  });

  it('skips disputed matches (hashMismatch=true) — no files written', async () => {
    const roomId = 'ARC2';
    written.push(roomId);
    archiveMatch(baseMatch(roomId, { hashMismatch: true }), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await readArchivedMeta(roomId)).toBeNull();
    expect(await readArchivedReplayGz(roomId)).toBeNull();
  });

  it('skips disputed matches (cheat conviction) — no files written', async () => {
    const roomId = 'ARC3';
    written.push(roomId);
    archiveMatch(baseMatch(roomId, { cheat: { side: 0, accountId: 'a' } }), Buffer.from('x'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await readArchivedMeta(roomId)).toBeNull();
  });

  it('readArchivedReplayGz/readArchivedMeta return null for an unknown roomId (treated as a plain 404, not an error)', async () => {
    expect(await readArchivedReplayGz('NOPE-ARCHIVE')).toBeNull();
    expect(await readArchivedMeta('NOPE-ARCHIVE')).toBeNull();
  });

  it('sweepArchive deletes files older than the 365-day retention window, keeps newer ones', async () => {
    const oldRoom = 'ARC-OLD';
    const freshRoom = 'ARC-FRESH';
    written.push(oldRoom, freshRoom);
    archiveMatch(baseMatch(oldRoom), Buffer.from('old'));
    archiveMatch(baseMatch(freshRoom), Buffer.from('fresh'));
    await new Promise((r) => setTimeout(r, 50));

    // Backdate the "old" pair's mtime past the retention window.
    const oldTime = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    await fs.utimes(join(ARCHIVE_DIR, `${oldRoom}.meta.json`), oldTime, oldTime);
    await fs.utimes(join(ARCHIVE_DIR, `${oldRoom}.replay.gz`), oldTime, oldTime);

    await sweepArchive();

    expect(await readArchivedReplayGz(oldRoom)).toBeNull();
    expect(await readArchivedMeta(oldRoom)).toBeNull();
    expect(await readArchivedReplayGz(freshRoom)).not.toBeNull();
  });
});
