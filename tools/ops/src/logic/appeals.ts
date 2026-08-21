// Pure layer for the player appeal review queue (CONTENT_MODERATION_DESIGN.md CM10/CM11; ADR-070 4e).
import type { AppealView } from '../types';
import { publicIdLabel } from './shared';

/**
 * The enforcement state that was in force when the player appealed, as one line. Order is severity
 * descending, and every part is optional: a player appealing a mute has no ban fields at all, and an
 * appeal filed against nothing (already lapsed) reads as an em dash rather than an empty cell.
 */
export function fmtSnapshot(s: AppealView['enforcementSnapshot']): string {
  const parts: string[] = [];
  if (s.banned) parts.push('banned (permanent)');
  if (s.bannedUntil) parts.push(`temp-banned until ${new Date(s.bannedUntil).toLocaleString()}`);
  if (s.mutedUntil) parts.push(`muted until ${new Date(s.mutedUntil).toLocaleString()}`);
  if (typeof s.reputationScore === 'number') parts.push(`score ${s.reputationScore}`);
  return parts.length ? parts.join(', ') : '—';
}

/** Pill colour per status. Note approved is the GOOD outcome here, unlike the report queue's upheld. */
export function appealStatusCls(status: string): string {
  return status === 'open' ? 'warn' : status === 'approved' ? 'ok' : 'failed';
}

/** Same two-part test as the report queue: the capability plus "still open". */
export function canResolveAppeal(canAction: boolean, status: string): boolean {
  return canAction && status === 'open';
}

/** Names the one thing approving does NOT do, which is the question operators actually ask. */
export function approveConfirm(accountId: string): string {
  return `Approve appeal for accountId ${accountId}? Clears the account's active mute/temp-ban/ban (reputation score is not restored).`;
}

export function appealResolveMessage(resolution: 'approved' | 'denied'): string {
  return resolution === 'approved' ? 'Approved.' : 'Denied.';
}

/** Prefers the publicId support can quote back to the player. */
export function appealPlayerLabel(a: Pick<AppealView, 'publicId' | 'accountId'>): string {
  return publicIdLabel(a.publicId, a.accountId);
}

/** "by <admin>" for a resolved row, or null when there is nothing to attribute. */
export function appealResolvedByText(a: Pick<AppealView, 'status' | 'resolvedBy'>): string | null {
  return a.status !== 'open' && a.resolvedBy ? `by ${a.resolvedBy}` : null;
}
