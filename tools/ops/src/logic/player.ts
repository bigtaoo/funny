// Pure layer for the player lookup page (ADR-070 Phase 4e).
import type { PlayerProfile, PlayerSummary } from '../types';
import { plural, publicIdLabel } from './shared';

/**
 * The accountId every admin action on this page targets. The profile's own value wins; the search
 * row's is the fallback for a profile fetched by publicId, whose payload may omit it. Both actions
 * (ban/unban and password reset) derived this separately from the same two fields before.
 */
export function targetAccountId(p: Pick<PlayerProfile, 'accountId'>, row: Pick<PlayerSummary, 'accountId'>): string {
  return p.accountId ?? row.accountId;
}

/** The detail table, label→value. Every optional field reads as an em dash rather than "undefined". */
export function playerDetailRows(p: PlayerProfile, row: Pick<PlayerSummary, 'accountId'>): [string, string][] {
  return [
    ['Public ID', publicIdLabel(p.publicId, '—')],
    ['accountId', targetAccountId(p, row)],
    ['Display name', p.displayName ?? '—'],
    ['Rank', p.rank ?? '—'],
    ['ELO', p.elo !== undefined ? String(p.elo) : '—'],
    ['Wins / Losses', p.wins !== undefined ? `${p.wins} / ${p.losses ?? 0}` : '—'],
  ];
}

export function playerStatus(banned: boolean | undefined): { label: string; cls: string } {
  return banned ? { label: 'banned', cls: 'failed' } : { label: 'active', cls: 'ok' };
}

/** The ban button flips label, class and action together; `willBan` is what a click would do. */
export function banButton(banned: boolean | undefined): { label: string; cls: string; willBan: boolean } {
  return banned ? { label: 'Unban', cls: '', willBan: false } : { label: 'Ban', cls: 'danger', willBan: true };
}

export function banConfirm(willBan: boolean, accountId: string): string {
  return `${willBan ? 'Ban' : 'Unban'} accountId ${accountId}?`;
}

export function banMessage(willBan: boolean): string {
  return willBan ? 'Player banned.' : 'Player unbanned.';
}

export function resetPasswordConfirm(accountId: string): string {
  return `Reset the password for accountId ${accountId} to the entered value?`;
}

/** One search-result row's cells. */
export function summaryCells(row: PlayerSummary): { publicId: string; displayName: string; loginId: string } {
  return {
    publicId: publicIdLabel(row.publicId, '—'),
    displayName: row.displayName ?? '—',
    loginId: row.loginId ?? '—',
  };
}

export function resultsText(n: number): string {
  return plural(n, 'result');
}

/** Detail is fetched by publicId when there is one (consistent with the older path), else by accountId. */
export function detailLookup(row: PlayerSummary): { by: 'publicId'; publicId: string } | { by: 'accountId'; accountId: string } {
  return row.publicId ? { by: 'publicId', publicId: row.publicId } : { by: 'accountId', accountId: row.accountId };
}
