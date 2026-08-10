// Matchsvc.ts split (2026-08-10, ≤500-line convention, composition layer): friend-challenge ("切磋",
// ADR friends-duel-confirm) — a pending-invite + 60s-timeout layer on top of the same MatchStarterPort
// the room-ready/ranked-pair flows already use. No room code exchange: the gateway already knows both
// accountIds. Independent of rooms.ts/queue.ts — a duel invite never checks room/queue membership
// (matches the original single-class behavior), so this has no dependency on either sibling.
import { randomUUID } from 'crypto';
import { createLogger, type RedisLike } from '@nw/shared';
import { saveDuelInvite, deleteDuelInvite, type PersistedDuelInvite } from '../persist';
import { DUEL_TIMEOUT_MS, type DuelInvite, type DuelPlayer, type MatchStarterPort, type Push } from './types';

const log = createLogger('matchsvc');

export interface DuelServiceDeps {
  push: Push;
  redis: RedisLike | null;
  now: () => number;
  matchStarter: MatchStarterPort;
}

export class DuelService {
  private readonly duelInvites = new Map<string, DuelInvite>(); // inviteId → invite
  private readonly pendingDuelByAccount = new Map<string, string>(); // fromAccountId → inviteId (one outstanding sent invite at a time)

  constructor(private readonly deps: DuelServiceDeps) {}

  /** `from` is fully resolved by the gateway (profile + elo-validated deck) before this is called. */
  duelInvite(from: DuelPlayer, toAccountId: string): void {
    // A second invite from the same inviter replaces the first (re-clicking "duel" reads as "retry",
    // not "queue another one") — cancel the stale one the same way a decline would.
    const prevId = this.pendingDuelByAccount.get(from.accountId);
    if (prevId) this.cancelDuel(prevId, 'declined');

    const inviteId = randomUUID();
    const expiresAt = this.deps.now() + DUEL_TIMEOUT_MS;
    const timer = setTimeout(() => this.expireDuel(inviteId), DUEL_TIMEOUT_MS);
    timer.unref?.();
    this.duelInvites.set(inviteId, { inviteId, from, toAccountId, timer });
    this.pendingDuelByAccount.set(from.accountId, inviteId);
    log.info('duel invite sent', { from: from.accountId, toAccountId, inviteId });
    void saveDuelInvite(this.deps.redis, { inviteId, from, toAccountId, expiresAt });
    this.deps.push(toAccountId, { kind: 'duel_invited', inviteId, fromPublicId: from.publicId, fromName: from.name });
  }

  /**
   * `toAccountId` must be the invite's actual recipient (mismatched/unknown inviteId is silently
   * ignored — stale UI on a slow client, nothing to correct). `profile` is the responder's own
   * resolved identity + elo-validated deck (gateway); omitted on decline, required to accept.
   */
  async duelRespond(toAccountId: string, inviteId: string, accept: boolean, profile?: DuelPlayer): Promise<void> {
    const invite = this.duelInvites.get(inviteId);
    if (!invite || invite.toAccountId !== toAccountId) return;
    clearTimeout(invite.timer);
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    // Awaited on the accept path (audit-followup-fixes-0730 — same reasoning as roomReady/tick): a crash
    // between this and matchStarter.start's match_found push must never leave the invite's Redis mirror
    // intact, or rehydrate() would re-push duel_invited for an invite that was already accepted and started.
    // The decline path below has no following push that depends on it, so it stays fire-and-forget.
    if (accept && profile) {
      await deleteDuelInvite(this.deps.redis, inviteId, invite.from.accountId);
      log.info('duel accepted -> startMatch', { inviteId, from: invite.from.accountId, toAccountId });
      this.deps.matchStarter.start('friendly', invite.from, profile);
      return;
    }
    void deleteDuelInvite(this.deps.redis, inviteId, invite.from.accountId);
    log.info('duel declined', { inviteId, from: invite.from.accountId, toAccountId });
    this.deps.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason: 'declined' });
  }

  /** Invite timed out with no response (60s) — notify the inviter only; the never-responding
   *  invitee's client self-clears the banner locally once its own countdown reaches zero. */
  private expireDuel(inviteId: string): void {
    const invite = this.duelInvites.get(inviteId);
    if (!invite) return;
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    void deleteDuelInvite(this.deps.redis, inviteId, invite.from.accountId);
    log.info('duel invite timed out', { inviteId, from: invite.from.accountId });
    this.deps.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason: 'timeout' });
  }

  /** Shared by duelInvite's replace-on-reinvite path; same effect as a decline from the invitee's side. */
  private cancelDuel(inviteId: string, reason: string): void {
    const invite = this.duelInvites.get(inviteId);
    if (!invite) return;
    clearTimeout(invite.timer);
    this.duelInvites.delete(inviteId);
    this.pendingDuelByAccount.delete(invite.from.accountId);
    void deleteDuelInvite(this.deps.redis, inviteId, invite.from.accountId);
    this.deps.push(invite.from.accountId, { kind: 'duel_cancelled', inviteId, reason });
  }

  // ───────────────────────── Restart-safety rehydrate (matchsvc-prematch-persist, 2026-07-29) ─────────────────────────

  /** Loads persisted duel invites back in. An invite whose window already closed by the time we came
   *  back up is resolved exactly like a normal timeout (delete + duel_cancelled to the inviter) right
   *  here; a still-live one gets a fresh setTimeout for whatever's left of its window. Returns the set of
   *  inviteIds that are still pending, for the caller's pushStillPending() (kept separate so Matchsvc.ts's
   *  rehydrate() can push duel_invited only after rooms/queue have also loaded, preserving the original
   *  single-pass "active notification" ordering). */
  hydrateAll(duelInvites: PersistedDuelInvite[]): Set<string> {
    const stillPendingInviteIds = new Set<string>();
    for (const inv of duelInvites) {
      const remaining = inv.expiresAt - this.deps.now();
      if (remaining <= 0) {
        void deleteDuelInvite(this.deps.redis, inv.inviteId, inv.from.accountId);
        this.deps.push(inv.from.accountId, { kind: 'duel_cancelled', inviteId: inv.inviteId, reason: 'timeout' });
        continue;
      }
      const timer = setTimeout(() => this.expireDuel(inv.inviteId), remaining);
      timer.unref?.();
      this.duelInvites.set(inv.inviteId, { inviteId: inv.inviteId, from: inv.from, toAccountId: inv.toAccountId, timer });
      this.pendingDuelByAccount.set(inv.from.accountId, inv.inviteId);
      stillPendingInviteIds.add(inv.inviteId);
    }
    return stillPendingInviteIds;
  }

  /** Active notification (rehydrate's final pass): push duel_invited to every invitee whose invite
   *  survived hydrateAll(). */
  pushStillPending(duelInvites: PersistedDuelInvite[], stillPendingInviteIds: Set<string>): void {
    for (const inv of duelInvites) {
      if (stillPendingInviteIds.has(inv.inviteId)) {
        this.deps.push(inv.toAccountId, { kind: 'duel_invited', inviteId: inv.inviteId, fromPublicId: inv.from.publicId, fromName: inv.from.name });
      }
    }
  }
}
