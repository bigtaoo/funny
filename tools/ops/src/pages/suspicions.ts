// Anti-cheat page: the review queue (S9-7 PvP overclaim + PvE reject 2026-07-18, human resolves each
// record as dismiss/ban) plus the two read-only signal lists restored on 2026-08-20 — C3 hash mismatches
// and the C4 suspicious-PvE roster (see OPS_DESIGN.md 「反作弊两张信号表」).
//
// All three sit on one page because they answer one question in three passes and share `anticheat.view`:
// the queue is per-event and drops out of the default filter once resolved, so the roster is what shows
// recidivism across already-resolved events, and the mismatch list is the only surface for desyncs at all.
// Each section loads and fails on its own — meta being unreachable for one must not blank the others.
import { clear, fmtTime, h, pill } from '../dom';
import type { AntiCheatReviewView, MismatchView, SuspiciousPveView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

/** PVE_REJECT_BAN_THRESHOLD (@nw/shared pveRewards.ts) — the count at which meta files the review record as `severity: 'high'`. */
const PVE_WARNING_HIGH = 3;

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

/**
 * Severity of a warning count, mirroring the `severity: 'high'` rule meta stamps on the matching review
 * record — the two sections must not disagree about which accounts are the repeat offenders.
 */
export function pveWarningLevel(count: number): 'high' | 'normal' {
  return count >= PVE_WARNING_HIGH ? 'high' : 'normal';
}

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canResolve = session.capabilities.includes('anticheat.action');
  clear(root);
  root.append(h('h2', {}, 'Anti-cheat'), h('h3', {}, 'Review queue'));
  const err = h('div', { class: 'err' });
  const acct = h('input', { placeholder: 'Filter by accountId (optional)' });
  const statusSel = h(
    'select',
    {},
    h('option', { value: 'open' }, 'Pending (open)'),
    h('option', { value: 'reviewed' }, 'Reviewed'),
    h('option', { value: 'all' }, 'All'),
  ) as HTMLSelectElement;
  const out = h('div', { class: 'card' });

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    try {
      const rows = await api.antiCheatReviews({
        ...(acct.value.trim() ? { accountId: acct.value.trim() } : {}),
        status: statusSel.value,
        limit: 100,
      });
      if (rows.length === 0) {
        out.append(h('div', { class: 'muted' }, 'No review records.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Kind'),
          h('th', {}, 'Player'),
          h('th', {}, 'Detail'),
          h('th', {}, 'Status'),
          h('th', {}, ''),
        ),
      );
      for (const r of rows as AntiCheatReviewView[]) {
        const kind = r.kind ?? 'pvp_overclaim';
        const detail =
          kind === 'pve_reject'
            ? `${r.levelId ?? '—'}: claimed ${r.claimedStars ?? '—'}★, judged ${r.judgedStars ?? '—'}★ (reject #${r.rejectCountAfter ?? '—'})`
            : kind === 'coin_anomaly'
            ? `${r.dayKey ?? '—'}: gained ${r.nonRechargeGain ?? '—'} non-recharge coins (threshold ${r.threshold ?? '—'})`
            : `${r.roomId ?? '—'} (side ${r.side ?? '—'}) reported ${fmtStats(r.reported)} / auth ${fmtStats(r.authoritative)} / overclaim ${fmtStats(r.overclaim)} / rolled back ${fmtStats(r.rolledBack)} / suspicion ${r.suspicionAfter ?? '—'}`;
        const statusCell = h('td', {},
          pill(r.status, r.status === 'open' ? 'warn' : 'ok'),
          ...(r.status === 'reviewed' && r.resolution ? [' ', pill(r.resolution, r.resolution === 'banned' ? 'failed' : 'ok')] : []),
        );
        const actionCell = h('td', {});
        if (canResolve && r.status === 'open') {
          const rowErr = h('div', { class: 'err' });
          const resolve = async (resolution: 'dismissed' | 'banned'): Promise<void> => {
            if (resolution === 'banned' && !confirm(`Ban accountId ${r.accountId}?`)) return;
            rowErr.textContent = '';
            try {
              await api.resolveAntiCheatReview(r._id, r.accountId, resolution);
              showOk(rowErr, resolution === 'banned' ? 'Banned.' : 'Dismissed.');
              await load();
            } catch (e) {
              showErr(rowErr, e);
            }
          };
          actionCell.append(
            h('div', { class: 'row' },
              h('button', { onclick: () => void resolve('dismissed') }, 'Dismiss'),
              h('button', { class: 'danger', onclick: () => void resolve('banned') }, 'Ban'),
            ),
            rowErr,
          );
        } else if (r.status === 'reviewed' && r.resolvedBy) {
          actionCell.append(h('div', { class: 'muted' }, `by ${r.resolvedBy}`));
        }
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {},
              kind === 'pve_reject' ? pill('PvE', r.severity === 'high' ? 'failed' : 'warn')
                : kind === 'coin_anomaly' ? pill('Coin', 'warn')
                : 'PvP',
            ),
            h('td', {}, r.publicId ? '#' + r.publicId : r.accountId),
            h('td', {}, detail),
            statusCell,
            actionCell,
          ),
        );
      }
      out.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };

  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, acct, statusSel, h('button', { onclick: load }, 'Query')), err),
    out,
  );

  // ── C3: unadjudicated hash mismatches ──
  const mismatchOut = h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Loading...'));
  const loadMismatches = async (): Promise<void> => {
    clear(mismatchOut);
    try {
      const rows = await api.mismatches();
      if (rows.length === 0) {
        mismatchOut.append(h('div', { class: 'muted' }, 'No unadjudicated mismatches in the last 24 hours.'));
        return;
      }
      const repeats = mismatchRepeats(rows);
      if (repeats.length > 0) {
        mismatchOut.append(
          h('div', { style: 'margin-bottom:8px' },
            h('strong', {}, 'Appears in more than one: '),
            repeats.map((r) => `${r.label} ×${r.count}`).join(', '),
          ),
        );
      }
      const t = h('table', {});
      t.append(h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Mode'), h('th', {}, 'Players'), h('th', {}, 'Reason'), h('th', {}, 'Room')));
      for (const m of rows as MismatchView[]) {
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(m.ts)),
            h('td', {}, m.mode),
            h('td', {}, [...m.players].sort((a, b) => a.side - b.side).map((p) => mismatchPlayerLabel(p)).join(' vs ') || '—'),
            h('td', {}, m.reason),
            h('td', { style: 'font-family:monospace;font-size:12px' }, m.roomId),
          ),
        );
      }
      mismatchOut.append(t);
    } catch (e) {
      showErr(mismatchOut, e);
    }
  };
  root.append(
    h('h3', {}, 'Hash mismatches (last 24 h)'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Matches whose two clients disagreed on the final state hash and that the peer judge could not ' +
      'adjudicate (C3). Kept indefinitely, unlike ordinary matches. A burst of these across many rooms at ' +
      'once is usually one desync incident rather than many cheaters — check the repeat list first.'),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('button', { onclick: () => void loadMismatches() }, 'Reload')),
    mismatchOut,
  );

  // ── C4: suspicious-PvE account roster ──
  const pveOut = h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Loading...'));
  const loadSuspiciousPve = async (): Promise<void> => {
    clear(pveOut);
    try {
      const rows = await api.suspiciousPve();
      if (rows.length === 0) {
        pveOut.append(h('div', { class: 'muted' }, 'No account has a rejected PvE spot-check.'));
        return;
      }
      const t = h('table', {});
      t.append(h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Warnings'), h('th', {}, 'Account since'), h('th', {}, 'Status'), h('th', {}, '')));
      for (const a of rows as SuspiciousPveView[]) {
        const actionCell = h('td', {});
        if (canResolve) {
          const rowErr = h('div', { class: 'err' });
          const setBan = async (ban: boolean): Promise<void> => {
            if (ban && !confirm(`Ban accountId ${a._id}?`)) return;
            rowErr.textContent = '';
            try {
              if (ban) await api.banPlayer(a._id);
              else await api.unbanPlayer(a._id);
              await loadSuspiciousPve();
            } catch (e) {
              showErr(rowErr, e);
            }
          };
          actionCell.append(
            a.banned
              ? h('button', { onclick: () => void setBan(false) }, 'Unban')
              : h('button', { class: 'danger', onclick: () => void setBan(true) }, 'Ban'),
            rowErr,
          );
        }
        t.append(
          h('tr', {},
            h('td', {}, a.displayName ? `${a.displayName} ${a.publicId ? '#' + a.publicId : ''}`.trim() : (a.publicId ? '#' + a.publicId : a._id)),
            h('td', {}, pill(String(a.pveWarnings), pveWarningLevel(a.pveWarnings) === 'high' ? 'failed' : 'warn')),
            h('td', {}, fmtTime(a.createdAt)),
            h('td', {}, a.banned ? pill('banned', 'failed') : pill('active', 'ok')),
            actionCell,
          ),
        );
      }
      pveOut.append(t);
    } catch (e) {
      showErr(pveOut, e);
    }
  };
  root.append(
    h('h3', {}, 'Suspicious PvE accounts'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Cumulative rejected PvE spot-checks per account, most-flagged first (C4). The count is a review ' +
      `signal only — nothing bans automatically; ${PVE_WARNING_HIGH}+ is what the queue above marks high ` +
      'severity. Unlike the queue, a row never goes away, so this is where repeat offenders across ' +
      'already-resolved records show up.'),
    h('div', { class: 'row', style: 'margin-bottom:8px' }, h('button', { onclick: () => void loadSuspiciousPve() }, 'Reload')),
    pveOut,
  );

  // Sequential, not Promise.all: three sections against one admin process, none of them urgent.
  await load();
  await loadMismatches();
  await loadSuspiciousPve();
}
