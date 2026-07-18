// Anti-cheat review queue (S9-7 PvP overclaim + PvE reject 2026-07-18): human resolves each record as dismiss/ban.
import { clear, fmtTime, h, pill } from '../dom';
import type { AntiCheatReviewView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

/** Render a statKey→count map as compact text (empty → —). */
function fmtStats(m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {});
  if (ks.length === 0) return '—';
  return ks.map((k) => `${k}:${m![k]}`).join(', ');
}

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canResolve = session.capabilities.includes('anticheat.action');
  clear(root);
  root.append(h('h2', {}, 'Anti-cheat review'));
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
            h('td', {}, kind === 'pve_reject' ? pill('PvE', r.severity === 'high' ? 'failed' : 'warn') : 'PvP'),
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
  await load();
}
