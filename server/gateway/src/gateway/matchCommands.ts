// gateway/Gateway.ts split (2026-08-10, ≤500-line convention, composition layer #3): the async matchmaking
// commands that need a meta round-trip (current elo + profile) before ever touching matchsvc — ranked enqueue,
// friendly room create/join, and friend-challenge duel invite/respond. Depends on the narrow `ConnLookup`/
// `Push` surface from connRegistry (never the WS handshake/heartbeat internals) plus meta/matchsvc.
import { createLogger, validatePvpDeck, defaultPvpDeck } from '@nw/shared';
import type { MatchsvcClient } from '../matchsvcClient';
import type { MetaClient } from '../metaClient';
import { displayName, type ConnLookup, type Push } from './types';

const log = createLogger('gateway');

export interface MatchCommandsDeps {
  conns: ConnLookup;
  push: Push;
  meta: MetaClient;
  matchsvc: MatchsvcClient;
}

export class MatchCommands {
  constructor(private readonly deps: MatchCommandsDeps) {}

  /** Ranked enqueue: fetches ELO from meta first (keeping matchsvc DB-free), validates deck, then enqueues. */
  async enqueueRanked(accountId: string, submittedDeck: string[]): Promise<void> {
    if (!this.deps.meta.available) {
      log.warn('ranked rejected: meta unavailable (no ELO source)', { accountId });
      this.deps.push(accountId, {
        kind: 'room_error',
        code: 'RANKED_UNAVAILABLE',
        message: 'ranked requires server storage',
      });
      return;
    }
    const identity = await this.deps.meta.getMatchIdentity(accountId);
    // The player may have disconnected during the await → only enqueue if still online.
    if (!this.deps.conns.has(accountId)) {
      log.warn('ranked enqueue aborted: account dropped during ELO fetch', { accountId });
      return;
    }
    const elo = identity.elo;
    const deck = this.resolvedDeck(accountId, submittedDeck, elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    log.info('-> matchsvc enqueue', { accountId, elo, deckSize: deck.length });
    const ok = await this.deps.matchsvc.enqueue(accountId, name, publicId, elo, equippedTitle, avatarId, '', deck, equippedSkins);
    // Retries are already exhausted inside matchsvc.enqueue (see matchsvcClient's postInternal
    // retries=2) — a false here means the command never landed at all, so the client's
    // "searching" UI would otherwise wait forever with no signal (P0-7, comm-audit finding B8).
    if (!ok && this.deps.conns.has(accountId)) {
      log.warn('ranked enqueue failed after retries: notifying client', { accountId });
      this.deps.push(accountId, { kind: 'room_error', code: 'RANKED_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /**
   * Friendly (custom) room create: validate the submitted deck against the player's *current* elo,
   * exactly like ranked — friendly rooms are NOT a sandbox (PVP_LOADOUT §6.3, universal server-side
   * gating). Without this, an empty/unvalidated deck lets the engine fall back to the full card pool.
   */
  async createRoomValidated(accountId: string, submittedDeck: string[]): Promise<void> {
    const identity = await this.deps.meta.getMatchIdentity(accountId);
    if (!this.deps.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    const ok = await this.deps.matchsvc.roomCreate(accountId, name, publicId, equippedTitle, avatarId, deck, equippedSkins);
    // No retry inside roomCreate (not idempotent) — a single failed attempt still deserves an
    // explicit error instead of leaving the "connecting" UI stuck with no signal (P0-7).
    if (!ok && this.deps.conns.has(accountId)) {
      log.warn('room create failed: notifying client', { accountId });
      this.deps.push(accountId, { kind: 'room_error', code: 'MATCHMAKING_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /** Friendly room join: same current-elo deck gating as create (PVP_LOADOUT §6.3). */
  async joinRoomValidated(accountId: string, code: string, submittedDeck: string[]): Promise<void> {
    const identity = await this.deps.meta.getMatchIdentity(accountId);
    if (!this.deps.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    const ok = await this.deps.matchsvc.roomJoin(accountId, name, publicId, code, equippedTitle, avatarId, deck, equippedSkins);
    if (!ok && this.deps.conns.has(accountId)) {
      log.warn('room join failed: notifying client', { accountId });
      this.deps.push(accountId, { kind: 'room_error', code: 'MATCHMAKING_UNAVAILABLE', message: 'matchmaking unreachable' });
    }
  }

  /**
   * Friend challenge ("切磋", ADR friends-duel-confirm) invite: the client only knows the friend's
   * publicId, so this resolves it to an accountId (meta) before ever touching matchsvc — matchsvc
   * itself only ever deals in accountIds (like every other command here). Same current-elo deck
   * gating as room create/join/ranked (PVP_LOADOUT §6.3). Offline/unknown target short-circuits
   * with an immediate duel_cancelled back to the inviter instead of creating a pending invite that
   * could never be answered.
   */
  async handleDuelInvite(accountId: string, toPublicId: string, submittedDeck: string[]): Promise<void> {
    const resolved = await this.deps.meta.resolveByPublicId(toPublicId);
    if (!this.deps.conns.has(accountId)) return;
    if (!resolved || resolved.accountId === accountId) {
      this.deps.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'not_found' });
      return;
    }
    if (!this.deps.conns.has(resolved.accountId)) {
      this.deps.push(accountId, { kind: 'duel_cancelled', inviteId: '', reason: 'offline' });
      return;
    }
    const identity = await this.deps.meta.getMatchIdentity(accountId);
    if (!this.deps.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    this.deps.matchsvc.duelInvite(accountId, name, publicId, equippedTitle, avatarId, resolved.accountId, deck, equippedSkins);
  }

  /** Accept/decline a friend-challenge invite. Only accept needs the responder's own profile + deck
   *  (elo-gated same as create/join) — decline is a plain pass-through, no lookups needed. */
  async handleDuelRespond(accountId: string, inviteId: string, accept: boolean, submittedDeck: string[]): Promise<void> {
    if (!accept) {
      this.deps.matchsvc.duelRespond(accountId, inviteId, false);
      return;
    }
    const identity = await this.deps.meta.getMatchIdentity(accountId);
    if (!this.deps.conns.has(accountId)) return;
    const deck = this.resolvedDeck(accountId, submittedDeck, identity.elo);
    const name = identity.displayName || displayName(accountId);
    const publicId = identity.publicId ?? '';
    const equippedTitle = identity.equippedTitle ?? '';
    const avatarId = identity.avatarId ?? '';
    const equippedSkins = identity.equippedSkins ?? [];
    this.deps.matchsvc.duelRespond(accountId, inviteId, true, name, publicId, equippedTitle, avatarId, deck, equippedSkins);
  }

  /**
   * Validate the submitted deck against the player's *current*-elo unlocked card set; fall back to
   * defaultPvpDeck on rejection. A dropped-elo player must not keep high-tier units in a low matchup.
   * Server-side guard: client-side validation is UX, this is the authority (PVP_LOADOUT §6.3).
   */
  private resolvedDeck(accountId: string, submitted: string[], elo: number): string[] {
    if (submitted.length === 0) return defaultPvpDeck();
    const result = validatePvpDeck(submitted, elo);
    if (!result.valid) {
      log.warn('invalid pvp deck submitted, falling back to default', { accountId, error: result.error });
      return defaultPvpDeck();
    }
    return submitted;
  }
}
