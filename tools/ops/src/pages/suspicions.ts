// Anti-cheat page: the review queue (S9-7 PvP overclaim + PvE reject 2026-07-18, human resolves each
// record as dismiss/ban) plus the two read-only signal lists restored on 2026-08-20 — C3 hash mismatches
// and the C4 suspicious-PvE roster (see OPS_DESIGN.md 「反作弊两张信号表」).
//
// All three sit on one page because they answer one question in three passes and share `anticheat.view`:
// the queue is per-event and drops out of the default filter once resolved, so the roster is what shows
// recidivism across already-resolved events, and the mismatch list is the only surface for desyncs at all.
// Each section loads and fails on its own — meta being unreachable for one must not blank the others.
//
// Every classification, label and evidence string lives in src/logic/suspicions.ts (ADR-070 Phase 4e).
import { clear, fmtTime, h, pill } from '../dom';
import {
  banConfirm, canResolveReview, mismatchPlayersText, mismatchRepeats, PVE_WARNING_HIGH, pveStatus,
  pveWarningLevel, repeatsText, reviewDetail, reviewKindPill, reviewPlayerLabel, reviewQuery,
  reviewResolvedByText, reviewResolveMessage, reviewStatusPills, suspiciousPveLabel,
} from '../logic/suspicions';
import type { AntiCheatReviewView, MismatchView, SuspiciousPveView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canAction = session.capabilities.includes('anticheat.action');
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
      const rows = await api.antiCheatReviews(reviewQuery(acct.value, statusSel.value, 100));
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
        const kindPill = reviewKindPill(r);
        const pills = reviewStatusPills(r);
        const statusCell = h('td', {},
          pill(pills[0]!.label, pills[0]!.cls),
          ...(pills[1] ? [' ', pill(pills[1].label, pills[1].cls)] : []),
        );
        const actionCell = h('td', {});
        const attribution = reviewResolvedByText(r);
        if (canResolveReview(canAction, r.status)) {
          const rowErr = h('div', { class: 'err' });
          const resolve = async (resolution: 'dismissed' | 'banned'): Promise<void> => {
            if (resolution === 'banned' && !confirm(banConfirm(r.accountId))) return;
            rowErr.textContent = '';
            try {
              await api.resolveAntiCheatReview(r._id, r.accountId, resolution);
              showOk(rowErr, reviewResolveMessage(resolution));
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
        } else if (attribution) {
          actionCell.append(h('div', { class: 'muted' }, attribution));
        }
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {}, kindPill ? pill(kindPill.label, kindPill.cls) : 'PvP'),
            h('td', {}, reviewPlayerLabel(r)),
            h('td', {}, reviewDetail(r)),
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
            repeatsText(repeats),
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
            h('td', {}, mismatchPlayersText(m)),
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
        if (canAction) {
          const rowErr = h('div', { class: 'err' });
          const setBan = async (ban: boolean): Promise<void> => {
            if (ban && !confirm(banConfirm(a._id))) return;
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
        const st = pveStatus(a.banned);
        t.append(
          h('tr', {},
            h('td', {}, suspiciousPveLabel(a)),
            h('td', {}, pill(String(a.pveWarnings), pveWarningLevel(a.pveWarnings) === 'high' ? 'failed' : 'warn')),
            h('td', {}, fmtTime(a.createdAt)),
            h('td', {}, pill(st.label, st.cls)),
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
