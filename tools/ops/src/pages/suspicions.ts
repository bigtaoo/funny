// Anti-cheat review queue (S9-7): achievement stat overclaim review records.
import { clear, fmtTime, h, pill } from '../dom';
import type { AntiCheatReviewView } from '../types';
import { showErr, type Ctx } from './shared';

/** Render a statKey→count map as compact text (empty → —). */
function fmtStats(m: Record<string, number> | undefined): string {
  const ks = Object.keys(m ?? {});
  if (ks.length === 0) return '—';
  return ks.map((k) => `${k}:${m![k]}`).join(', ');
}

export async function pageSuspicions(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Anti-cheat review (achievement stat overclaim)'));
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
          h('th', {}, 'Player'),
          h('th', {}, 'Room'),
          h('th', {}, 'Reported'),
          h('th', {}, 'Authoritative'),
          h('th', {}, 'Overclaim'),
          h('th', {}, 'Rolled back'),
          h('th', {}, 'suspicion'),
          h('th', {}, 'Status'),
        ),
      );
      for (const r of rows as AntiCheatReviewView[]) {
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {}, r.publicId ? '#' + r.publicId : r.accountId),
            h('td', {}, r.roomId + ` (side ${r.side})`),
            h('td', {}, fmtStats(r.reported)),
            h('td', {}, fmtStats(r.authoritative)),
            h('td', {}, fmtStats(r.overclaim)),
            h('td', {}, fmtStats(r.rolledBack)),
            h('td', {}, String(r.suspicionAfter)),
            h('td', {}, pill(r.status, r.status === 'open' ? 'warn' : 'ok')),
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
