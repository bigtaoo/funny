// Account-deletion purge, worldsvc leg. metaserver soft-deletes an account (accounts.deletedAt); after the
// grace period its purge job calls every service's `POST /internal/accounts/:accountId/purge` (see
// httpApi/internalRoutes.ts) and retries until each one answers done. Two consequences shape this file:
//
//  • Idempotent and re-runnable after a partial failure. Every step is a delete/unset keyed on the account (a
//    second run matches nothing), and the steps that FIND the rest — the playerWorld docs and their sectId
//    mirrors — are deleted last, so a run that dies half-way leaves the breadcrumbs a retry needs.
//  • socialsvc's purge has ALREADY run by the time this is called. It removed the account from its family:
//    a leader with other members had leadership auto-transferred (families.leaderId changed), a sole member's
//    family was dissolved outright (the FamilyDoc — and with it the family's `sectId` mirror — is gone). So
//    sect reconciliation below reads membership back from socialsvc as the source of truth instead of trusting
//    anything worldsvc cached about the account's family.
//
// Deliberately NOT touched:
//  • `sieges` (battle reports, 30-day TTL): they carry only attackerId/defenderId, no names, and are the other
//    player's history as much as this one's — deleting them would punch holes in other people's reports.
//    They expire on their own.
//  • `cities`: owned by sect (ownerSectId), never by account.
//  • `siegeDamage` rows AGAINST this account (defenderId): see forceClearShardPresence in transfer.ts — they
//    carry the besieging player's team and resolve themselves via the stale-target path once the tiles go.
//  • `shardAllocations`: keyed by familyId only.
import { WorldCore } from './core';
import type { PlayerWorldDoc, SectDoc } from './db';
import type { FamilySummary } from './socialsvcClient';
import { forceClearShardPresence, vacateShard } from './transfer';
import { tearDownSect } from './sect/membership';

export interface AccountPurgeResult {
  done: true;
  /** How many worlds (shards) the account had a playerWorld doc in when this run started. */
  worlds: number;
  /** Rows deleted / modified per collection by this run (a re-run reports all zeros). */
  removed: Record<string, number>;
  /** Sects whose leadership moved to another family/account, and sects dissolved because no family was left. */
  sects: { reassigned: number; dissolved: number };
}

type SectOutcome = 'reassigned' | 'dissolved' | 'updated' | 'unchanged';

/** Same bounded refetch+retry shape voteRemoveLeader uses for its rev-guarded sect writes. */
const SECT_REV_ATTEMPTS = 5;

export class AccountPurgeService {
  constructor(private readonly core: WorldCore) {}

  async purgeAccount(accountId: string): Promise<AccountPurgeResult> {
    const { cols } = this.core.deps;
    const removed: Record<string, number> = {
      marches: 0, occupations: 0, stationed: 0, contestedTiles: 0, siegeDamage: 0,
      nations: 0, sectMessages: 0, nationMessages: 0, familyMessages: 0,
      seasonResults: 0, shardTransfers: 0, tiles: 0, playerWorld: 0,
    };
    const add = (k: string, n: number): void => { removed[k] = (removed[k] ?? 0) + n; };

    const pws = await cols.playerWorld.find({ accountId }).toArray();

    // 1. In-flight state, per shard — the same force-clear mergeShard uses (a deleted account, like a closing
    //    shard, has no later for a march/hold/park to resolve into).
    for (const pw of pws) {
      const c = await forceClearShardPresence(this.core, pw.worldId, accountId);
      for (const [k, n] of Object.entries(c)) add(k, n);
    }

    // 2. Nation ownership. Nation docs are the per-capital slots initNations creates at season open (unique
    //    {worldId, capitalIdx}, one per province), not per-player records — deleting one would remove the
    //    capital from getNations/getNationAt until the next season open. So the account's claim is unset
    //    instead, with exactly the $unset initNations uses to clear stale ownership.
    const nations = await cols.nations.updateMany(
      { ownerId: accountId },
      { $unset: { ownerId: '', familyId: '', nationName: '', foundedAt: '' } },
    );
    add('nations', nations.modifiedCount);

    // 3. Sects.
    const sects = await this.reconcileSects(accountId, pws, add);

    // 4. Chat content the account sent (all three channel shapes; familyMessages is the legacy one).
    add('sectMessages', (await cols.sectMessages.deleteMany({ senderId: accountId })).deletedCount);
    add('nationMessages', (await cols.nationMessages.deleteMany({ senderId: accountId })).deletedCount);
    add('familyMessages', (await cols.familyMessages.deleteMany({ senderId: accountId })).deletedCount);

    // 5. Season history: blank the name on this account's solo ranking entries but keep id/score/rank, so
    //    every OTHER player's historic ranking (and the G6 allocation that reads last season's results) is
    //    unchanged. The $elemMatch on `name` existing makes a re-run match nothing.
    const seasons = await cols.seasonResults.updateMany(
      { ranking: { $elemMatch: { scope: 'solo', id: accountId, name: { $exists: true } } } },
      { $unset: { 'ranking.$[e].name': '' } },
      { arrayFilters: [{ 'e.scope': 'solo', 'e.id': accountId }] },
    );
    add('seasonResults', seasons.modifiedCount);

    // 6. Mid-season transfer cooldown tracker (_id = accountId).
    add('shardTransfers', (await cols.shardTransfers.deleteOne({ _id: accountId })).deletedCount);

    // 7. LAST: tiles + playerWorld + the population slot. Everything above finds its work through these docs
    //    (worldIds for step 1, sectId mirrors for step 3), so they must outlive any step that can fail.
    //    vacateShard only decrements population when THIS call deleted the doc, so a retry can never free the
    //    same slot twice; the one unguarded window (doc deleted, process dies before the $inc) leaks a slot,
    //    which is the safe direction for a capacity counter.
    for (const pw of pws) {
      const v = await vacateShard(this.core, pw.worldId, accountId);
      add('tiles', v.tiles);
      if (v.playerWorld) add('playerWorld', 1);
    }

    return { done: true, worlds: pws.length, removed, sects };
  }

  /**
   * Candidate sects = every sect the account's playerWorld docs mirror (it was in one through its family) ∪
   * every sect it leads (covers a stale/missing mirror). Each is reconciled against socialsvc's current roster.
   */
  private async reconcileSects(
    accountId: string,
    pws: readonly PlayerWorldDoc[],
    add: (k: string, n: number) => void,
  ): Promise<{ reassigned: number; dissolved: number }> {
    const { cols } = this.core.deps;
    const ids = new Set<string>();
    for (const pw of pws) if (pw.sectId) ids.add(pw.sectId);
    const led = await cols.sects.find({ leaderId: accountId }).project<{ _id: string }>({ _id: 1 }).toArray();
    for (const s of led) ids.add(s._id);

    const out = { reassigned: 0, dissolved: 0 };
    if (ids.size === 0) return out;
    // With no socialsvc there is no roster to reconcile against, and the null client answers `[]` for every
    // sect — which would read as "no families left" and dissolve live sects. Refuse (→ 500, the job retries)
    // rather than guess.
    if (!this.core.socialsvc.available) throw new Error('socialsvc unavailable: cannot reconcile sect membership');

    for (const sid of ids) {
      const r = await this.reconcileSect(sid, add);
      if (r === 'reassigned') out.reassigned++;
      else if (r === 'dissolved') out.dissolved++;
    }
    return out;
  }

  /**
   * Bring one sect back in line with socialsvc after the account's family changed under it.
   *
   * Why worldsvc has to do this at all: a sect's leadership normally only moves by voteRemoveLeader, and a
   * sect only disappears by dissolveSect — both require the sect leader (or family leaders) to ACT, and a
   * deleted account never will. leaveSect also forbids the leader family from simply walking out. So when the
   * deleted account was the sect leader, nothing in the ordinary game flow can ever un-stick the sect; the
   * purge is the only place that can.
   *
   *  - Leader family still in the sect → just re-point `leaderId` at that family's current leader (socialsvc
   *    auto-transferred family leadership, so this is usually the account's successor).
   *  - Leader family gone (dissolved with its sole member) and other families remain → leadership passes to
   *    the largest remaining family (memberCount desc, familyId asc as a deterministic tie-break).
   *  - No family left → dissolve it, same teardown dissolveSect runs (there are no member mirrors to clear).
   *  - Always: memberFamilyCount := roster size (a recompute, so re-running is a no-op), and a pending
   *    removalVote is cleaned of families no longer in the sect (dropped entirely if its nominee is gone, or
   *    on any leadership change — voteRemoveLeader clears it on a transition too).
   *
   * Writes are rev-guarded with a bounded refetch+retry, like voteRemoveLeader: a concurrent vote landing
   * between our read and write must not be silently overwritten by a decision made on the older doc.
   * Known gap (accepted, same single-document-CAS convention as the rest of worldsvc): joinSect bumps
   * memberFamilyCount without touching rev and writes the socialsvc mirror after the sect doc, so a join
   * racing this exact window can leave the count one low until the next recompute.
   */
  private async reconcileSect(sid: string, add: (k: string, n: number) => void): Promise<SectOutcome> {
    const { cols } = this.core.deps;
    const socialsvc = this.core.socialsvc;
    for (let attempt = 0; attempt < SECT_REV_ATTEMPTS; attempt++) {
      const sect = await cols.sects.findOne({ _id: sid });
      if (!sect) return 'unchanged'; // already dissolved (by a previous run, or by its members)
      // Fresh read (no 10s membership cache, throws instead of answering [] on failure) — socialsvc's own purge
      // changed this roster behind worldsvc's back, and the empty answer is what triggers a dissolve.
      const remaining: FamilySummary[] = socialsvc.getFamiliesBySectFresh
        ? await socialsvc.getFamiliesBySectFresh(sid)
        : await socialsvc.getFamiliesBySect(sid);

      if (remaining.length === 0) {
        const { messages } = await tearDownSect(cols, socialsvc, sect.worldId, sect, [], this.core.deps.now());
        add('sectMessages', messages);
        return 'dissolved';
      }

      const inSect = new Set(remaining.map((f) => f.familyId));
      const set: Partial<SectDoc> = {};
      let unsetVote = false;
      let outcome: SectOutcome = 'unchanged';

      const leaderFam = remaining.find((f) => f.familyId === sect.leaderFamilyId);
      if (leaderFam) {
        if (leaderFam.leaderId !== sect.leaderId) {
          set.leaderId = leaderFam.leaderId;
          outcome = 'reassigned';
        }
      } else {
        const successor = [...remaining].sort((a, b) => b.memberCount - a.memberCount || (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0))[0]!;
        set.leaderFamilyId = successor.familyId;
        set.leaderId = successor.leaderId;
        outcome = 'reassigned';
      }

      if (sect.memberFamilyCount !== remaining.length) {
        set.memberFamilyCount = remaining.length;
        if (outcome === 'unchanged') outcome = 'updated';
      }

      const vote = sect.removalVote;
      if (vote) {
        // A leadership change voids the vote (the nominee may even be the new leader family).
        const newLeaderFamily = set.leaderFamilyId ?? sect.leaderFamilyId;
        if (outcome === 'reassigned' && set.leaderFamilyId !== undefined) unsetVote = true;
        else if (!inSect.has(vote.nomineeFamilyId) || vote.nomineeFamilyId === newLeaderFamily) unsetVote = true;
        else {
          const voters = vote.voterFamilyIds.filter((f) => inSect.has(f));
          if (voters.length !== vote.voterFamilyIds.length) {
            set.removalVote = { nomineeFamilyId: vote.nomineeFamilyId, voterFamilyIds: voters };
          }
        }
        if ((unsetVote || set.removalVote) && outcome === 'unchanged') outcome = 'updated';
      }

      if (outcome === 'unchanged') return 'unchanged';
      const res = await cols.sects.updateOne(
        { _id: sid, rev: sect.rev },
        { $set: set, ...(unsetVote ? { $unset: { removalVote: '' } } : {}), $inc: { rev: 1 } },
      );
      if (res.matchedCount > 0) return outcome;
    }
    throw new Error(`account purge: sect ${sid} lost the rev race every attempt`);
  }
}
