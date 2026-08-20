// Pure layer for the anti-cheat page (S9-7 review queue + the C3/C4 signal lists; ADR-070 Phase 4e).
import type { AntiCheatReviewView, MismatchView, SuspiciousPveView } from '../types';
import { publicIdLabel } from './shared';

/** PVE_REJECT_BAN_THRESHOLD (@nw/shared pveRewards.ts) — the count at which meta files the review record as `severity: 'high'`. */
export const PVE_WARNING_HIGH = 3;

/** Render a statKey→count map as compact text (empty → —). */
export function fmtStats(m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {});
  if (ks.length === 0) return '—';
  return ks.map((k) => `${k}:${m![k]}`).join(', ');
}

/**
 * How to name a player in the mismatch table. Prefers the publicId (the id support actually quotes to a
 * player, and what Player Lookup takes) and keeps the name alongside when both were snapshotted; falls
 * back to the raw accountId only when the match predates the identity snapshot.
 */
export function mismatchPlayerLabel(p: { accountId: string; displayName?: string; publicId?: string }): string {
  if (p.publicId) return p.displayName ? `${p.displayName} #${p.publicId}` : `#${p.publicId}`;
  return p.displayName ?? p.accountId;
}

/**
 * Accounts appearing in more than one mismatch in the window, most first.
 *
 * This is the whole reason the section is not just a table: under load a desync storm writes dozens of
 * rows that are one infrastructure fault, not dozens of suspects (BOTSVC_DESIGN.md §8 — bots starving
 * one event loop fork their state hash), and a chronological list of 200 rows hides which single account
 * keeps turning up. Counted per row, so the same account twice in one match still counts once.
 */
export function mismatchRepeats(rows: MismatchView[]): { accountId: string; label: string; count: number }[] {
  const seen = new Map<string, { accountId: string; label: string; count: number }>();
  for (const row of rows) {
    for (const id of new Set(row.players.map((p) => p.accountId))) {
      const player = row.players.find((p) => p.accountId === id)!;
      const prev = seen.get(id);
      if (prev) prev.count += 1;
      else seen.set(id, { accountId: id, label: mismatchPlayerLabel(player), count: 1 });
    }
  }
  return [...seen.values()].filter((e) => e.count > 1).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The repeat-offender summary line, or '' when nobody appears twice. */
export function repeatsText(repeats: readonly { label: string; count: number }[]): string {
  return repeats.map((r) => `${r.label} ×${r.count}`).join(', ');
}

/** Both sides of a mismatch, ordered by side so the same match always reads the same way round. */
export function mismatchPlayersText(m: Pick<MismatchView, 'players'>): string {
  return [...m.players].sort((a, b) => a.side - b.side).map((p) => mismatchPlayerLabel(p)).join(' vs ') || '—';
}

/**
 * Severity of a warning count, mirroring the `severity: 'high'` rule meta stamps on the matching review
 * record — the two sections must not disagree about which accounts are the repeat offenders.
 */
export function pveWarningLevel(count: number): 'high' | 'normal' {
  return count >= PVE_WARNING_HIGH ? 'high' : 'normal';
}

/** Roster row label: name + publicId if known, else either alone, else the raw accountId. */
export function suspiciousPveLabel(a: Pick<SuspiciousPveView, '_id' | 'displayName' | 'publicId'>): string {
  return a.displayName
    ? `${a.displayName} ${publicIdLabel(a.publicId, '')}`.trim()
    : publicIdLabel(a.publicId, a._id);
}

// ── Review queue ──

export type ReviewKind = 'pvp_overclaim' | 'pve_reject' | 'coin_anomaly';

/** Rows written before the field existed are PvP overclaims. */
export function reviewKind(r: Pick<AntiCheatReviewView, 'kind'>): ReviewKind {
  return r.kind ?? 'pvp_overclaim';
}

/**
 * The one-line evidence for a record, which is a different sentence per kind: PvE compares claimed vs
 * judged stars, the coin anomaly compares a day's non-recharge gain against its threshold, and a PvP
 * overclaim dumps the four stat maps the two sides disagreed about. Every field is optional because
 * each kind only fills its own, hence the em dashes.
 */
export function reviewDetail(r: AntiCheatReviewView): string {
  switch (reviewKind(r)) {
    case 'pve_reject':
      return `${r.levelId ?? '—'}: claimed ${r.claimedStars ?? '—'}★, judged ${r.judgedStars ?? '—'}★ (reject #${r.rejectCountAfter ?? '—'})`;
    case 'coin_anomaly':
      return `${r.dayKey ?? '—'}: gained ${r.nonRechargeGain ?? '—'} non-recharge coins (threshold ${r.threshold ?? '—'})`;
    default:
      return `${r.roomId ?? '—'} (side ${r.side ?? '—'}) reported ${fmtStats(r.reported)} / auth ${fmtStats(r.authoritative)} / overclaim ${fmtStats(r.overclaim)} / rolled back ${fmtStats(r.rolledBack)} / suspicion ${r.suspicionAfter ?? '—'}`;
  }
}

/** The kind column: PvE and Coin get a coloured pill, PvP is plain text. */
export function reviewKindPill(r: AntiCheatReviewView): { label: string; cls: string } | null {
  switch (reviewKind(r)) {
    case 'pve_reject':
      return { label: 'PvE', cls: r.severity === 'high' ? 'failed' : 'warn' };
    case 'coin_anomaly':
      return { label: 'Coin', cls: 'warn' };
    default:
      return null;
  }
}

/** Status pill, plus the resolution pill a reviewed record carries alongside it. */
export function reviewStatusPills(r: Pick<AntiCheatReviewView, 'status' | 'resolution'>): { label: string; cls: string }[] {
  const pills: { label: string; cls: string }[] = [{ label: r.status, cls: r.status === 'open' ? 'warn' : 'ok' }];
  if (r.status === 'reviewed' && r.resolution) {
    pills.push({ label: r.resolution, cls: r.resolution === 'banned' ? 'failed' : 'ok' });
  }
  return pills;
}

/** Queue row's player column — prefers the publicId, same as everywhere else players are named. */
export function reviewPlayerLabel(r: Pick<AntiCheatReviewView, 'publicId' | 'accountId'>): string {
  return publicIdLabel(r.publicId, r.accountId);
}

export function canResolveReview(canAction: boolean, status: string): boolean {
  return canAction && status === 'open';
}

/** "by <admin>" for a reviewed record, or null when there is nothing to attribute. */
export function reviewResolvedByText(r: Pick<AntiCheatReviewView, 'status' | 'resolvedBy'>): string | null {
  return r.status === 'reviewed' && r.resolvedBy ? `by ${r.resolvedBy}` : null;
}

export function banConfirm(accountId: string): string {
  return `Ban accountId ${accountId}?`;
}

export function reviewResolveMessage(resolution: 'dismissed' | 'banned'): string {
  return resolution === 'banned' ? 'Banned.' : 'Dismissed.';
}

/** The queue query: accountId only when the operator typed one, status always. */
export function reviewQuery(accountId: string, status: string, limit: number): { accountId?: string; status: string; limit: number } {
  const a = accountId.trim();
  return { ...(a ? { accountId: a } : {}), status, limit };
}

export function pveStatus(banned: boolean | undefined): { label: string; cls: string } {
  return banned ? { label: 'banned', cls: 'failed' } : { label: 'active', cls: 'ok' };
}
