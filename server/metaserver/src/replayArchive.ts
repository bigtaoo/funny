// Cold-tier replay archive (S1-RP storage tier, 2026-07-20): local VPS disk, deliberately NOT cloud
// object storage (Hetzner Object Storage has a flat ~€7.72/mo base fee regardless of usage — doesn't pay
// for itself at our data volume; replay data won't exceed ~10GB even under heavy load. Revisit once
// there's real revenue to justify it).
//
// Mongo TTL (MATCH_RETENTION_MS in matchReport.ts, 7 days) purges `matches`/`replayBlobs`; before this
// module, that data was gone for good. Every non-disputed settled match is additionally mirrored here
// (fire-and-forget, from matchReport.ts, after the Mongo write) and kept for ARCHIVE_RETENTION_MS (365
// days), giving a cold-tier fallback window for the rare "someone asks for a 2-month-old replay" case.
// Disputed matches (hashMismatch/cheat) are skipped — already kept indefinitely in Mongo.
//
// NW_REPLAY_ARCHIVE_DIR is optional: unset (local dev without the docker volume) → every function here
// is a no-op, so nothing breaks. In prod it points at a Docker volume mount (docker-compose.cloud.yml).
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createLogger, type MatchDoc } from '@nw/shared';

const log = createLogger('meta:replay-archive');

const ARCHIVE_DIR = process.env.NW_REPLAY_ARCHIVE_DIR ?? null;
const ARCHIVE_RETENTION_MS = 365 * 24 * 3600 * 1000;

export function archiveEnabled(): boolean {
  return ARCHIVE_DIR !== null;
}

/** Ensure the archive directory exists (idempotent). Call once at startup; no-op if NW_REPLAY_ARCHIVE_DIR is unset. */
export async function ensureArchiveDir(): Promise<void> {
  if (!ARCHIVE_DIR) return;
  await fs.mkdir(ARCHIVE_DIR, { recursive: true }).catch((e) =>
    log.error('mkdir archive dir failed', { dir: ARCHIVE_DIR, err: (e as Error).message }),
  );
}

/**
 * Fire-and-forget archive of one settled match to local disk. Never awaited by the caller (must not
 * delay match settlement); failures are log-only. Two files per match: `<roomId>.meta.json` (small,
 * uncompressed metadata) and `<roomId>.replay.gz` (the replayGz bytes written as-is — already gzip'd,
 * writing a second gzip pass over it would be wasted work for no size benefit).
 */
export function archiveMatch(match: MatchDoc, replayGzBuf: Buffer): void {
  if (!ARCHIVE_DIR) return;
  if (match.hashMismatch || match.cheat) return; // disputed — kept forever in Mongo already
  const dir = ARCHIVE_DIR;
  const roomId = match.roomId;
  const meta = {
    roomId: match.roomId,
    mode: match.mode,
    seed: match.seed,
    players: match.players,
    winner: match.winner,
    reason: match.reason,
    hashOk: match.hashOk,
    ts: match.ts,
  };
  void (async () => {
    try {
      await fs.writeFile(join(dir, `${roomId}.meta.json`), JSON.stringify(meta), 'utf8');
      await fs.writeFile(join(dir, `${roomId}.replay.gz`), replayGzBuf);
    } catch (e) {
      log.error('archive match to disk failed', { roomId, err: (e as Error).message });
    }
  })();
}

/**
 * Cold-tier fallback read (7d-365d window, after Mongo TTL has purged the match). Returns null if
 * archiving is disabled or the file is missing/expired — callers should treat that the same as a
 * regular 404, not as an error.
 */
export async function readArchivedReplayGz(roomId: string): Promise<Buffer | null> {
  if (!ARCHIVE_DIR) return null;
  try {
    return await fs.readFile(join(ARCHIVE_DIR, `${roomId}.replay.gz`));
  } catch {
    return null;
  }
}

/**
 * Cold-tier metadata read, mirrors {@link readArchivedReplayGz}. Needed by getMatchReplay: once Mongo's
 * TTL has deleted the `matches` doc, the participant-authorization check (`players.some(accountId)`) has
 * nothing to check against unless it falls back to the archived `<roomId>.meta.json` sidecar.
 */
export async function readArchivedMeta(
  roomId: string,
): Promise<Pick<MatchDoc, 'roomId' | 'mode' | 'seed' | 'players' | 'winner' | 'reason' | 'hashOk' | 'ts'> | null> {
  if (!ARCHIVE_DIR) return null;
  try {
    const raw = await fs.readFile(join(ARCHIVE_DIR, `${roomId}.meta.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Daily sweep: delete archive files older than 365 days (mtime-based). Wired into a setInterval alongside the anti-cheat audit timer in index.ts. */
export async function sweepArchive(now: () => number = Date.now): Promise<void> {
  if (!ARCHIVE_DIR) return;
  let entries: string[];
  try {
    entries = await fs.readdir(ARCHIVE_DIR);
  } catch (e) {
    log.error('readdir archive dir failed', { err: (e as Error).message });
    return;
  }
  const cutoff = now() - ARCHIVE_RETENTION_MS;
  for (const name of entries) {
    const path = join(ARCHIVE_DIR, name);
    try {
      const st = await fs.stat(path);
      if (st.mtimeMs < cutoff) await fs.unlink(path);
    } catch (e) {
      log.error('archive sweep entry failed', { path, err: (e as Error).message });
    }
  }
}
