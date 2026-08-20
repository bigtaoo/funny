// cards/* split — fuseCardsBatch (see ../cards.ts for the module overview).
import {
  applyFusion,
  type Collections,
  type SaveData,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { REV_RETRIES, idemExpireAt, toCardDoc, fromCardDoc, type CardError } from './helpers.js';
import { checkFuseShape, checkFuseRound } from './fuseRules.js';

/** One fusion inside a batch: the same payload single-shot /cards/fuse takes, minus the idem key. */
export interface FuseRound {
  targetId: string;
  materialIds: string[];
}

/**
 * Hard cap on rounds per request. The roster's batch-prep button asks for at most
 * FUSION_MATERIAL_COUNT rounds today (it only ever fills one prep frame's shortfall), so this is
 * pure headroom — it exists so a hand-rolled client can't turn one request into an unbounded write
 * loop against Mongo.
 */
export const MAX_FUSE_BATCH_ROUNDS = 20;

export interface FuseBatchResult {
  /** Rounds that committed, in request order. Short of `rounds.length` iff `failed` is set. */
  completed: number;
  /** The first round that failed, if any — the batch stops there (see the doc comment). */
  failed?: { index: number } & CardError;
  save: SaveData;
}

/**
 * Run N fusions as ONE request (2026-08-20, CHARACTER_CARDS_DESIGN §3.2).
 *
 * Why it exists: producing the materials for a single high-level fusion takes a run of same-level
 * fuses, and the roster's "make the materials" button used to issue them as N sequential
 * POST /cards/fuse calls. Each of those pays its own round-trip AND ships a whole reassembled
 * `cardInv` back (app.ts's preSerialization backfill re-reads every card the account owns) — on a
 * roster in the hundreds that is the stall players can feel. One request means one roster read, one
 * `cardInv` reassembly, one save write.
 *
 * Semantics deliberately match what the client's sequential loop already did, so the UI's
 * report-what-landed handling is unchanged:
 *   · Rounds run strictly in order; each is validated against the roster as the PREVIOUS rounds left
 *     it, so a round may legitimately consume a card an earlier round just levelled up.
 *   · The first failing round stops the batch. Everything before it stays committed and `completed`
 *     reports it — that is a 200, not an error: partial progress is real progress, and the
 *     alternative (rolling back) is impossible without transactions (shared/src/mongo.ts).
 *   · Per-round commit order is fuseCards' order: target level-up first (guarded on the pre-checked
 *     `level`, the fine-grained optimistic lock), materials deleted only once it lands. A crash in
 *     between leaves "levelled up, materials still there" — recoverable — never the reverse.
 *
 * The roster is read ONCE up front and then projected forward in memory across rounds. That is the
 * whole point of the endpoint, and it is as safe as the single-shot path for the same reason: what
 * actually detects concurrent mutation is the `level` guard on each target update, not the age of
 * the read.
 *
 * idempotencyKey covers the WHOLE batch. It is claimed before the first round and its stored
 * `result.rounds` is updated to the committed count when the run ends, so a retry replays that count
 * instead of re-consuming cards. A crash mid-run leaves the claim at its last written count (0 until
 * the run finishes), so the retry replays a low count rather than re-fusing — it under-reports
 * progress but never destroys cards twice, and the client re-reads the roster from the returned save
 * regardless, so the cost is a stale toast number.
 */
export async function fuseCardsBatch(
  cols: Collections,
  now: () => number,
  accountId: string,
  rounds: FuseRound[],
  idempotencyKey: string,
): Promise<FuseBatchResult | CardError> {
  if (!Array.isArray(rounds) || rounds.length === 0)
    return { error: 'rounds must contain at least one entry', code: 'BAD_REQUEST' };
  if (rounds.length > MAX_FUSE_BATCH_ROUNDS)
    return { error: `rounds must contain at most ${MAX_FUSE_BATCH_ROUNDS} entries`, code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  for (const [i, r] of rounds.entries()) {
    const shapeErr = checkFuseShape(r?.targetId, r?.materialIds);
    if (shapeErr) return { ...shapeErr, error: `round ${i}: ${shapeErr.error}` };
  }

  // Idempotency replay: cards are already consumed, so report the stored count against current state.
  const replay = await cols.cardIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'fuseBatch') {
    return { completed: storedRounds(replay.result), save: await getOrCreateSave(cols, accountId, now()) };
  }

  // One roster read for the whole batch (the reason this endpoint exists). Scoped to the ids the
  // batch actually names rather than the full roster — a prep run touches ~30 cards out of up to 500.
  const named = new Set<string>();
  for (const r of rounds) { named.add(r.targetId); for (const m of r.materialIds) named.add(m); }
  const [, docs] = await Promise.all([
    getOrCreateSave(cols, accountId, now()),
    cols.cardInstances.find({ _id: { $in: [...named] }, accountId }).toArray(),
  ]);
  const cards = new Map(docs.map((d) => [d._id, fromCardDoc(d)]));

  // Reject before touching anything if the FIRST round is already invalid — a wholly wasted batch
  // (stale client plan, or a hand-rolled request) should read as an error, not "0 of 5 succeeded".
  const first = rounds[0]!;
  const firstCheck = checkFuseRound(cards, first.targetId, first.materialIds);
  if ('error' in firstCheck) return firstCheck;

  try {
    await cols.cardIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'fuseBatch',
      result: { rounds: 0 },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      // Concurrent retry claimed it first; that run owns the count.
      const prior = await cols.cardIdem.findOne({ _id: idempotencyKey });
      return { completed: storedRounds(prior?.result), save: await getOrCreateSave(cols, accountId, now()) };
    }
    throw e;
  }

  let completed = 0;
  let consumed = 0;
  let failed: ({ index: number } & CardError) | undefined;
  for (const [index, round] of rounds.entries()) {
    const checked = checkFuseRound(cards, round.targetId, round.materialIds);
    if ('error' in checked) { failed = { index, ...checked }; break; }
    const upgraded = applyFusion(checked.target);
    const res = await cols.cardInstances.updateOne(
      { _id: round.targetId, accountId, level: checked.target.level },
      { $set: toCardDoc(upgraded, accountId) },
    );
    if (res.matchedCount === 0) {
      failed = { index, error: 'target card changed concurrently, retry', code: 'REV_CONFLICT' };
      break;
    }
    // Scoped to accountId for the same cross-account TOCTOU reason as fuseCards' delete.
    await cols.cardInstances.deleteMany({ _id: { $in: round.materialIds }, accountId });
    for (const m of round.materialIds) cards.delete(m);
    cards.set(upgraded.id, upgraded);
    completed++;
    consumed += round.materialIds.length;
  }

  await cols.cardIdem.updateOne({ _id: idempotencyKey }, { $set: { 'result.rounds': completed } });

  // Saves-side: ONE count decrement for the whole run, rev-guarded (fuseCards pays this per fuse).
  let save: SaveData | null = null;
  for (let attempt = 0; attempt < REV_RETRIES && !save; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const next: SaveData = {
      ...doc.save,
      rev: doc.save.rev + 1,
      updatedAt: now(),
      cardInvCount: Math.max(0, doc.save.cardInvCount - consumed),
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) save = next;
  }
  // Retries exhausted: the fusions themselves already committed, so report success anyway and let
  // the count mirror self-heal on the next assembleCardInv (same reasoning as fuseCards' tail).
  return {
    completed,
    ...(failed ? { failed } : {}),
    save: save ?? await getOrCreateSave(cols, accountId, now()),
  };
}

function storedRounds(result: unknown): number {
  return (result as { rounds?: number } | undefined)?.rounds ?? 0;
}
