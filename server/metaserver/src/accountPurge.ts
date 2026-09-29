// C5-b account purge (ACCOUNT_DESIGN §C5-b purge, COMPLIANCE_GLOBAL §3.5). DELETE /account only soft-deletes
// (accounts.deletedAt) so that logging back in within ACCOUNT_DELETE_GRACE_MS restores the account; this job
// is what turns an expired soft delete into an actual erasure — for years the docs and the privacy policy
// promised "purged after 7 days" while nothing ever did it.
//
// Shape: a bounded, idempotent, resumable tick (same orchestration style as reputationDecay.ts /
// coinAnomalyAudit.ts), wired into a setInterval in index.ts.
//   1. Claim one due account at a time (findOneAndUpdate on `purge.lockedUntil` = lease, so two ticks or two
//      processes never work the same account concurrently).
//   2. Walk ACCOUNT_PURGE_STEPS in order, skipping steps already confirmed in `purge.steps`. Each remote
//      step is an idempotent `POST /internal/accounts/:id/purge` on that service. The first step that fails
//      or reports `done:false` stops the walk — later steps may depend on earlier ones — and the account is
//      retried after RETRY_MS.
//   3. The local `meta` step deletes this database's per-account collections; then, once per tick, the
//      replay cold archive is scrubbed for every account that got that far, and only then is each account
//      row replaced by a tombstone.
//
// Step order and why:
//   social    first: removes the account from its family, auto-transferring family leadership (or dissolving
//             a family it was the only member of). worldsvc reads family state from socialsvc to fix sects.
//   world     reconciles sect leadership against socialsvc's post-purge families, then wipes the player's
//             presence (tiles/marches/playerWorld) in every shard.
//   auction   may answer done:false while a counterparty's settlement is still in flight (a bid the account
//             placed, or bids on its listing) — it must finish before the wallet is gone.
//   commercial deletes the wallet and non-financial state; keeps the legally retained transaction records,
//             stripped of raw receipt/event payloads.
//   analytics deletes events/sessions by user_id and by device id (pre-login events carry only the latter),
//             so it runs while the account row still has its deviceId.
//   meta      last: the account row is the one place that still knows the deviceId and holds the claim.
//
// The tombstone `{ _id, createdAt, deletedAt, purgedAt }` is kept instead of deleting the row outright: an
// unexpired JWT for the account (30-day TTL, sliding renewal) would otherwise meet a missing row, and
// getOrCreateSave/ensurePublicId would happily resurrect a save and a publicId for it. With the tombstone,
// rejectIfBanned keeps answering 410 and bearerAuth refuses the token outright (see auth.ts).
import type { AccountDoc, AccountPurgeStep, Collections } from '@nw/shared';
import { ACCOUNT_PURGE_STEPS, createLogger } from '@nw/shared';
import { ACCOUNT_DELETE_GRACE_MS } from './service/auth/helpers.js';
import { scrubArchivedPlayers } from './replayArchive.js';
import type { AccountPurgeClient, RemotePurgeStep } from './accountPurgeClient.js';

const log = createLogger('meta:account-purge');

/** Claim lease: comfortably above the worst case of five remote calls at 30s × 2 attempts each. */
const LEASE_MS = 15 * 60 * 1000;
/** Back-off after a failed or pending step: shorter than the default 1h tick, so the next tick retries it. */
const RETRY_MS = 30 * 60 * 1000;

export interface AccountPurgeDeps {
  cols: Collections;
  client: AccountPurgeClient;
  now: () => number;
  /** Max accounts claimed per tick (default 50); the rest wait for the next tick, nothing is dropped. */
  batchLimit?: number;
  /** Replay cold-archive directory override (tests); default NW_REPLAY_ARCHIVE_DIR. */
  archiveDir?: string | null;
}

export interface AccountPurgeResult {
  /** Accounts claimed this tick. */
  scanned: number;
  /** Accounts fully erased and tombstoned. */
  purged: number;
  /** Accounts stopped at a step that reported done:false (retried later). */
  pending: number;
  /** Accounts stopped at a failing step (retried later). */
  failed: number;
}

type Outcome = 'ready' | 'pending' | 'failed';

export async function purgeDeletedAccountsOnce(deps: AccountPurgeDeps): Promise<AccountPurgeResult> {
  const { cols } = deps;
  const tickNow = deps.now();
  const cutoff = tickNow - ACCOUNT_DELETE_GRACE_MS;
  const batchLimit = deps.batchLimit ?? 50;
  const result: AccountPurgeResult = { scanned: 0, purged: 0, pending: 0, failed: 0 };
  const ready: AccountDoc[] = [];

  for (let i = 0; i < batchLimit; i++) {
    // `deletedAt <= cutoff` and restoreIfWithinGrace's `now - deletedAt < GRACE` are disjoint, so an account
    // this job has claimed can no longer be restored by logging in — no race with a returning player.
    const doc = await cols.accounts.findOneAndUpdate(
      {
        deletedAt: { $lte: cutoff },
        purgedAt: { $exists: false },
        $or: [{ 'purge.lockedUntil': { $exists: false } }, { 'purge.lockedUntil': { $lte: tickNow } }],
      },
      {
        $set: { 'purge.lockedUntil': tickNow + LEASE_MS },
        $inc: { 'purge.attempts': 1 },
        $min: { 'purge.startedAt': tickNow },
      },
      { sort: { deletedAt: 1 }, returnDocument: 'after' },
    );
    if (!doc) break;
    result.scanned++;
    let outcome: Outcome;
    try {
      outcome = await runSteps(deps, doc);
    } catch (e) {
      // runSteps already records per-step failures; this is the local meta step or a Mongo error.
      await recordStop(cols, doc._id, deps.now(), `meta: ${(e as Error).message}`);
      outcome = 'failed';
    }
    if (outcome === 'ready') ready.push(doc);
    else result[outcome]++;
  }

  if (ready.length > 0) {
    try {
      const rewritten = await scrubArchivedPlayers(new Set(ready.map((d) => d._id)), deps.archiveDir);
      if (rewritten > 0) log.info('replay archive scrubbed', { accounts: ready.length, files: rewritten });
    } catch (e) {
      // Every step is confirmed, so the next claim goes straight back to this point.
      const msg = `replay archive: ${(e as Error).message}`;
      log.error('account purge archive scrub failed', { err: msg });
      for (const d of ready) await recordStop(cols, d._id, deps.now(), msg);
      result.failed += ready.length;
      return result;
    }
    for (const d of ready) {
      await tombstone(cols, d, deps.now());
      result.purged++;
      log.info('account purged', { accountId: d._id, deletedAt: d.deletedAt, attempts: d.purge?.attempts });
    }
  }
  return result;
}

async function runSteps(deps: AccountPurgeDeps, doc: AccountDoc): Promise<Outcome> {
  const { cols, client } = deps;
  const confirmed = doc.purge?.steps ?? {};
  for (const step of ACCOUNT_PURGE_STEPS) {
    if (confirmed[step]) continue;
    if (step === 'meta') {
      const removed = await purgeMetaLocal(cols, doc._id);
      await confirmStep(cols, doc._id, step, deps.now());
      log.info('account purge step done', { accountId: doc._id, step, removed });
      continue;
    }
    const r = await client.purge(step, doc._id, remoteBody(step, doc));
    if (!r.ok) {
      log.warn('account purge step failed', { accountId: doc._id, step, err: r.error });
      await recordStop(cols, doc._id, deps.now(), r.error);
      return 'failed';
    }
    if (!r.done) {
      log.info('account purge step pending', { accountId: doc._id, step, data: r.data });
      await recordStop(cols, doc._id, deps.now(), `${step}: pending`);
      return 'pending';
    }
    await confirmStep(cols, doc._id, step, deps.now());
    log.info('account purge step done', { accountId: doc._id, step, removed: r.data.removed });
  }
  return 'ready';
}

function remoteBody(step: RemotePurgeStep, doc: AccountDoc): Record<string, unknown> {
  // Pre-login analytics events are keyed by device id only; the account row is the only place that
  // still links that device to the account, which is why analytics runs before the local meta step.
  if (step === 'analytics') return { deviceIds: doc.deviceId ? [doc.deviceId] : [] };
  // Player-to-player mail stores the sender's publicId (not accountId) in `from`; socialsvc could look it
  // up via /internal/account/batch-profiles, but handing it over removes that dependency.
  if (step === 'social') return doc.publicId ? { publicId: doc.publicId } : {};
  return {};
}

async function confirmStep(cols: Collections, accountId: string, step: AccountPurgeStep, at: number): Promise<void> {
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { [`purge.steps.${step}`]: at }, $unset: { 'purge.lastError': '' } },
  );
}

async function recordStop(cols: Collections, accountId: string, at: number, reason: string): Promise<void> {
  await cols.accounts.updateOne(
    { _id: accountId },
    { $set: { 'purge.lockedUntil': at + RETRY_MS, 'purge.lastError': reason.slice(0, 500) } },
  );
}

/**
 * Every per-account collection in the meta database (inventory: ACCOUNT_DESIGN §C5-b purge). Idempotent:
 * all deletes/updates are by account, so a re-run after a partial failure just finds less to do.
 * Kept on purpose: `matches` rows (the opponent's match history — only this account's name/publicId
 * snapshot is blanked; they TTL out after 7 days unless disputed) and the judge/audit references to this
 * account inside OTHER accounts' anti-cheat records (opaque id once the row is a tombstone).
 */
export async function purgeMetaLocal(cols: Collections, accountId: string): Promise<Record<string, number>> {
  const byAccountId = [
    'cardInstances', 'equipmentInstances', 'skinInstances', 'materialInstances',
    'cardIdem', 'equipmentIdem', 'internalGrantOrders',
    'replayShares', 'adsTokens', 'eventParticipants', 'ladderSeasonSnapshots',
    'feedback', 'appeals', 'pveVerifications', 'pveRejections', 'antiCheatReviews',
  ] as const;
  const removed: Record<string, number> = {};
  for (const name of byAccountId) {
    // The union of collection types can't carry a common filter type; every one of these has `accountId: string`.
    const col = cols[name] as unknown as { deleteMany(f: { accountId: string }): Promise<{ deletedCount: number }> };
    removed[name] = (await col.deleteMany({ accountId })).deletedCount;
  }
  removed.saves = (await cols.saves.deleteOne({ _id: accountId })).deletedCount;
  removed.pveStamina = (await cols.pveStamina.deleteOne({ _id: accountId })).deletedCount;
  removed.stateReplayShares = (await cols.stateReplayShares.deleteMany({ createdBy: accountId })).deletedCount;
  // Legacy meta mail collection (mail moved to socialsvc in P2; socialsvc's purge covers the live one).
  removed.mail = (await cols.mail.deleteMany({ to: accountId })).deletedCount;
  removed.matchesAnonymized = (
    await cols.matches.updateMany(
      { players: { $elemMatch: { accountId, $or: [{ displayName: { $exists: true } }, { publicId: { $exists: true } }] } } },
      { $unset: { 'players.$[p].displayName': '', 'players.$[p].publicId': '' } },
      { arrayFilters: [{ 'p.accountId': accountId }] },
    )
  ).modifiedCount;
  return removed;
}

async function tombstone(cols: Collections, doc: AccountDoc, at: number): Promise<void> {
  // replaceOne drops every credential (deviceId/openid/password/oauth), the profile, publicId and flags in
  // one write; the unique sparse indexes on those fields free them up for a brand-new account.
  await cols.accounts.replaceOne(
    { _id: doc._id, purgedAt: { $exists: false } },
    { _id: doc._id, createdAt: doc.createdAt, deletedAt: doc.deletedAt, purgedAt: at } as AccountDoc,
  );
}
