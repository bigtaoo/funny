// gameserver → meta end-of-match report (M19, S1-M3). POSTs {room_id, seed, mode, both sides'
// hash/winner, reason, non-empty frame replay} to meta /internal/match/report (internal key,
// idempotent on room_id). meta cross-checks, calculates ELO, writes saves.pvp, and archives
// the match; for ranked matches it returns each side's ELO delta back to gameserver →
// forwarded into match_over.elo. When meta is unavailable, reports are queued for background
// retry (active matches do not depend on meta being reachable in real time, M16).
import { internalHeaders, compressReplayDoc } from '@nw/shared';
import type { MatchReplayDoc } from '@nw/shared';
import type { EloBySide, MatchReport } from './Room';

interface QueuedReport {
  body: unknown;
  attempts: number;
}

export class MetaReporter {
  private readonly queue: QueuedReport[] = [];
  private draining = false;

  constructor(
    private readonly baseUrl: string | null, // e.g. http://meta:8080 (internal direct connection, no /api prefix)
    private readonly internalKey: string,
  ) {}

  /**
   * Report one match. Returns each side's ELO delta on successful ranked settlement;
   * returns null for friendly matches, failures, or when meta is unavailable.
   * On failure, enqueues the body for background retry (idempotent key room_id — retries
   * do not trigger duplicate settlement).
   */
  async report(r: MatchReport): Promise<EloBySide | null> {
    // Non-empty frame replay (M19/S1-RP). Opaque command bytes are base64-encoded (commands themselves
    // are not decoded, M12); the whole replayDoc JSON is then gzip'd once (2026-07-20 storage cost fix)
    // and base64-encoded a single time for internal HTTP JSON transport as `replay_gz`.
    const replayDoc: MatchReplayDoc = {
      engineVersion: r.replay.engineVersion,
      mode: r.replay.mode,
      seed: String(r.replay.seed),
      endFrame: r.replay.endFrame,
      frames: r.replay.frames.map((f) => ({
        frame: f.frame,
        cmds: f.cmds.map((c) => ({ side: c.side, commands: Buffer.from(c.commands).toString('base64') })),
      })),
      meta: r.replay.meta,
      ...(r.replay.decks ? { decks: r.replay.decks } : {}),
    };
    const body = {
      room_id: r.roomId,
      seed: String(r.seed),
      mode: r.mode,
      reason: r.reason,
      winner_side: r.winnerSide,
      hash_ok: r.hashOk,
      players: r.players,
      results: r.results.map((x) => ({
        side: x.side,
        state_hash: x.stateHash,
        winner_side: x.winnerSide,
        ...(x.stats ? { stats: x.stats } : {}), // S9-6: per-side per-match achievement counters (meta accumulates after L1 validation, ranked only)
      })),
      replay_gz: compressReplayDoc(replayDoc).toString('base64'),
    };
    if (!this.baseUrl) return null;
    try {
      const res = await this.post(body);
      if (!res) {
        this.enqueue(body);
        return null;
      }
      return res.elo ?? null;
    } catch {
      this.enqueue(body);
      return null;
    }
  }

  private async post(body: unknown): Promise<{ ok: boolean; elo?: EloBySide } | null> {
    if (!this.baseUrl) return null;
    // Explicit timeout (undici has none) — reports carry replay frames so allow 10s;
    // the existing room_id-idempotent retry queue covers a timed-out report.
    const res = await fetch(`${this.baseUrl}/internal/match/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('gameserver', this.internalKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Drain the body so the socket returns to undici's pool (unconsumed bodies wedge
      // it under burst — e.g. many ranked matches ending together).
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
      return null;
    }
    return (await res.json()) as { ok: boolean; elo?: EloBySide };
  }

  private enqueue(body: unknown): void {
    this.queue.push({ body, attempts: 0 });
    void this.drain();
  }

  /** Background retry queue (exponential back-off; idempotent key room_id prevents duplicate settlement). */
  private async drain(): Promise<void> {
    if (this.draining || !this.baseUrl) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(item.attempts, 5));
      await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await this.post(item.body);
        if (res) {
          this.queue.shift();
          continue;
        }
      } catch {
        /* retry */
      }
      item.attempts++;
    }
    this.draining = false;
  }
}
