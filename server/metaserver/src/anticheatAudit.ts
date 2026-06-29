// Achievement PvP stats anti-cheat L2/L3 offline sampling batch (ACHIEVEMENT_DESIGN §4.4). The meta timer calls auditOnce periodically:
// samples archived ranked matches → headlessly re-computes both sides' true kill/cast via an online peer judge (gateway.judge) →
// compares against the archived reported values → if overclaim is confirmed, rolls back the excess + increments statSuspicion + enqueues for OPS review.
//
// Key constraint: the server stores command frames as base64 opaque and never decodes them, so re-computation **must** go through the peer judge (same as Phase C).
// No judge available / re-computation failed / old engine → skip (benefit-of-doubt, never convict without evidence). Pure logic (sampling/comparison/rollback)
// lives in @nw/shared.antiCheatAudit; this file only handles orchestration + DB.
import type {
  Collections,
  MatchDoc,
  SaveData,
  StatKey,
  AntiCheatReviewDoc,
} from '@nw/shared';
import {
  compareAudit,
  applyRollback,
  shouldAuditSample,
} from '@nw/shared';
import type { GatewayClient, JudgeFrame } from './gatewayClient.js';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:anticheat-audit');

export interface AuditDeps {
  cols: Collections;
  /** Re-computation source (same as Phase C). `available=false` → skip the entire batch (no judge means no conviction). */
  gateway: GatewayClient;
  now: () => number;
  /** 0..1 random number (injected for deterministic testing); defaults to Math.random. */
  rand?: () => number;
  /** Number of candidate matches examined per tick (default 5, oldest-first to drain backlog). */
  sampleLimit?: number;
  /** Sampling probability overrides (defaults: AUDIT_SAMPLE_P0 / AUDIT_SAMPLE_P_FLAGGED). */
  p0?: number;
  pFlagged?: number;
}

export interface AuditResult {
  examined: number; // number of candidate matches pulled
  audited: number; // matches marked audited (clean + overclaim)
  flagged: number; // number of sides confirmed as overclaiming (escalated + rolled back + review record)
  skipped: number; // no replay / re-computation failed → skipped mark
}

/** Parses the judge's PvP per-side statsJson → `{ sideNo: {statKey:n} }`; invalid input → null. */
function parsePerSideStats(
  statsJson: string | undefined,
): Record<string, Partial<Record<StatKey, number>>> | null {
  if (!statsJson) return null;
  try {
    const o = JSON.parse(statsJson) as unknown;
    if (!o || typeof o !== 'object') return null;
    return o as Record<string, Partial<Record<StatKey, number>>>;
  } catch {
    return null;
  }
}

/** Converts archived replay frames (commands already as base64 strings) → judge frames. */
function toJudgeFrames(doc: MatchDoc): JudgeFrame[] {
  const replay = doc.replay;
  if (!replay) return [];
  return replay.frames.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({ side: c.side, commands: String(c.commands) })),
  }));
}

/** Optimistic-lock read-modify-write on a save doc (same pattern as service.mutateSave / applyPvp, 3 retries). Returns null on failure. */
async function mutateSaveForAudit(
  cols: Collections,
  now: () => number,
  accountId: string,
  transform: (s: SaveData) => SaveData,
): Promise<SaveData | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return null;
    const out = transform(doc.save);
    const next: SaveData = { ...out, rev: doc.save.rev + 1, updatedAt: now() };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
  }
  return null;
}

/** Sets the audited mark (idempotent gate; only writes if the mark does not already exist). */
async function markAudited(
  cols: Collections,
  roomId: string,
  audited: MatchDoc['audited'],
): Promise<void> {
  await cols.matches
    .updateOne({ roomId, audited: { $exists: false } }, { $set: { audited } })
    .catch((e) => log.error('mark audited failed', { roomId, err: (e as Error).message }));
}

/**
 * Audits a batch of archived ranked matches. Returns all zeros immediately if no judge is available;
 * re-computes matches **serially** (one online re-computation per match to avoid overwhelming live games).
 * Any exception is only logged, the audited mark is not set (preserving re-sample eligibility), and the error is not rethrown.
 */
export async function auditOnce(deps: AuditDeps): Promise<AuditResult> {
  const { cols, gateway, now } = deps;
  const result: AuditResult = { examined: 0, audited: 0, flagged: 0, skipped: 0 };
  if (!gateway.available) return result; // no judge → never convict

  const rand = deps.rand ?? Math.random;
  const limit = deps.sampleLimit ?? 5;
  const opts = { p0: deps.p0, pFlagged: deps.pFlagged };

  const candidates = await cols.matches
    .find({ mode: 'ranked', audited: { $exists: false } })
    .sort({ ts: 1 }) // oldest first, drain backlog
    .limit(limit)
    .toArray();
  result.examined = candidates.length;

  for (const doc of candidates) {
    try {
      await auditMatch(deps, doc, rand, opts, result);
    } catch (e) {
      log.error('audit match failed', { roomId: doc.roomId, err: (e as Error).message });
      // do not mark → leave match for re-sampling (no data loss).
    }
  }
  return result;
}

async function auditMatch(
  deps: AuditDeps,
  doc: MatchDoc,
  rand: () => number,
  opts: { p0?: number; pFlagged?: number },
  result: AuditResult,
): Promise<void> {
  const { cols, gateway, now } = deps;

  // L3 weighted sampling: use the higher statSuspicion of the two participating sides for the sampling decision (either side being flagged raises the match's sampling probability).
  const saves = await Promise.all(
    doc.players.map((p) => cols.saves.findOne({ _id: p.accountId })),
  );
  const maxSusp = saves.reduce((m, s) => Math.max(m, s?.save.antiCheat?.statSuspicion ?? 0), 0);
  if (!shouldAuditSample(maxSusp, rand(), opts)) return; // not sampled: do not mark, retain re-sample eligibility

  // Fetch replay (inline preferred, fall back to external blob).
  let replay = doc.replay;
  if (!replay && doc.replayRef) {
    const blob = await cols.replayBlobs.findOne({ _id: doc.replayRef });
    replay = blob?.replay;
  }
  if (!replay) {
    await markAudited(cols, doc.roomId, { ts: now(), verdict: 'skipped' });
    result.audited++;
    result.skipped++;
    return;
  }

  // Headless re-computation via peer judge (mode 1 = ranked; frames forwarded as-is in base64, same as judgeMismatch).
  const verdict = await gateway.judge({
    seed: Number(doc.seed),
    mode: 1,
    endFrame: replay.endFrame,
    frames: toJudgeFrames({ ...doc, replay }),
    exclude: doc.players.map((p) => p.accountId),
  });
  const parsed = verdict.ok ? parsePerSideStats(verdict.statsJson) : null;
  if (!verdict.ok || !parsed) {
    // No available judge / re-computation failed / old engine cannot re-compute → mark skipped (consume the record, do not retry a broken replay indefinitely).
    await markAudited(cols, doc.roomId, {
      ts: now(),
      verdict: 'skipped',
      ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
    });
    result.audited++;
    result.skipped++;
    return;
  }

  // Compare reported vs re-computed values per side and collect overclaiming sides.
  const overclaimBySide: Record<string, Partial<Record<StatKey, number>>> = {};
  for (const p of doc.players) {
    const reported = doc.reportedStats?.[String(p.side)];
    const authoritative = parsed[String(p.side)];
    const cmp = compareAudit(reported, authoritative);
    if (!cmp.suspicious) continue;
    const rolled = await flagOverclaim(deps, doc, p, reported ?? {}, authoritative ?? {}, cmp.overclaim, verdict.judgeAccountId);
    if (rolled) {
      overclaimBySide[String(p.side)] = rolled;
      result.flagged++;
    }
  }

  const suspicious = Object.keys(overclaimBySide).length > 0;
  await markAudited(cols, doc.roomId, {
    ts: now(),
    verdict: suspicious ? 'overclaim' : 'clean',
    ...(verdict.judgeAccountId ? { judgeAccountId: verdict.judgeAccountId } : {}),
    ...(suspicious ? { overclaim: overclaimBySide } : {}),
  });
  result.audited++;
}

/**
 * Confirms overclaim for a given side: review-first lock (`_id=roomId:accountId` unique) prevents duplicate rollbacks —
 * if a record already exists it was already rolled back in a previous round, so skip. New insert → roll back the excess amount (clamped to 0 floor)
 * + statSuspicion++ + lastFlaggedTs, then back-fill the actual rolled-back amount and escalated value.
 * Returns the actual rollback map; already processed / rollback write failed → null (not counted in flagged).
 */
async function flagOverclaim(
  deps: AuditDeps,
  doc: MatchDoc,
  player: MatchDoc['players'][number],
  reported: Partial<Record<StatKey, number>>,
  authoritative: Partial<Record<StatKey, number>>,
  overclaim: Partial<Record<StatKey, number>>,
  judgeAccountId: string | undefined,
): Promise<Partial<Record<StatKey, number>> | null> {
  const { cols, now } = deps;
  const reviewId = `${doc.roomId}:${player.accountId}`;

  // review-first as idempotent lock: claim via unique index (_id), already exists → rolled back in a prior round, skip.
  const seed: AntiCheatReviewDoc = {
    _id: reviewId,
    roomId: doc.roomId,
    accountId: player.accountId,
    ...(player.publicId ? { publicId: player.publicId } : {}),
    side: player.side,
    reported,
    authoritative,
    overclaim,
    rolledBack: {},
    suspicionAfter: 0,
    status: 'open',
    ts: now(),
    ...(judgeAccountId ? { judgeAccountId } : {}),
  };
  try {
    await cols.antiCheatReviews.insertOne(seed);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null; // this match+side was already processed
    throw e;
  }

  // Roll back the overclaimed amount + escalate (rev-guarded atomic write). Coins are not clawed back (§4.4) — only stats + antiCheat are modified.
  let rolledBack: Partial<Record<StatKey, number>> = {};
  let suspicionAfter = 0;
  const saved = await mutateSaveForAudit(cols, now, player.accountId, (s) => {
    const { stats, rolledBack: rb } = applyRollback(s.stats, overclaim);
    rolledBack = rb;
    const prevSusp = s.antiCheat?.statSuspicion ?? 0;
    suspicionAfter = prevSusp + 1;
    return {
      ...s,
      ...(stats ? { stats } : {}),
      antiCheat: { statSuspicion: suspicionAfter, lastFlaggedTs: now() },
    };
  });
  if (!saved) {
    // Rollback write failed (rev conflict retries exhausted): delete the review record to release the lock, leave the match for re-sampling next round (no data loss).
    await cols.antiCheatReviews.deleteOne({ _id: reviewId }).catch(() => {});
    return null;
  }

  await cols.antiCheatReviews
    .updateOne({ _id: reviewId }, { $set: { rolledBack, suspicionAfter } })
    .catch((e) => log.error('review backfill failed', { reviewId, err: (e as Error).message }));

  log.warn('anti-cheat overclaim flagged', {
    roomId: doc.roomId,
    accountId: player.accountId,
    overclaim,
    rolledBack,
    suspicionAfter,
  });
  return rolledBack;
}
