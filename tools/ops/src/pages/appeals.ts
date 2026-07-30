// Player appeal review queue (CONTENT_MODERATION_DESIGN.md CM10/CM11): human approves (clears the
// account's active mute/temp-ban/ban) or denies each open appeal.
import { clear, fmtTime, h, pill } from '../dom';
import type { AppealView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

function fmtSnapshot(s: AppealView['enforcementSnapshot']): string {
  const parts: string[] = [];
  if (s.banned) parts.push('banned (permanent)');
  if (s.bannedUntil) parts.push(`temp-banned until ${new Date(s.bannedUntil).toLocaleString()}`);
  if (s.mutedUntil) parts.push(`muted until ${new Date(s.mutedUntil).toLocaleString()}`);
  if (typeof s.reputationScore === 'number') parts.push(`score ${s.reputationScore}`);
  return parts.length ? parts.join(', ') : '—';
}

export async function pageAppeals(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canResolve = session.capabilities.includes('appeals.action');
  clear(root);
  root.append(h('h2', {}, 'Player Appeals'));
  const err = h('div', { class: 'err' });
  const statusSel = h(
    'select',
    {},
    h('option', { value: 'open' }, 'Pending (open)'),
    h('option', { value: 'approved' }, 'Approved'),
    h('option', { value: 'denied' }, 'Denied'),
  ) as HTMLSelectElement;
  const out = h('div', { class: 'card' });

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    try {
      const rows = await api.appeals({ status: statusSel.value, limit: 100 });
      if (rows.length === 0) {
        out.append(h('div', { class: 'muted' }, 'No appeals.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Player'),
          h('th', {}, 'Reason'),
          h('th', {}, 'Enforcement (at submission)'),
          h('th', {}, 'Status'),
          h('th', {}, ''),
        ),
      );
      for (const a of rows as AppealView[]) {
        const statusCell = h('td', {},
          pill(a.status, a.status === 'open' ? 'warn' : a.status === 'approved' ? 'ok' : 'failed'),
        );
        const actionCell = h('td', {});
        if (canResolve && a.status === 'open') {
          const rowErr = h('div', { class: 'err' });
          const resolve = async (resolution: 'approved' | 'denied'): Promise<void> => {
            if (resolution === 'approved' && !confirm(`Approve appeal for accountId ${a.accountId}? Clears the account's active mute/temp-ban/ban (reputation score is not restored).`)) return;
            rowErr.textContent = '';
            try {
              await api.resolveAppeal(a._id, resolution);
              showOk(rowErr, resolution === 'approved' ? 'Approved.' : 'Denied.');
              await load();
            } catch (e) {
              showErr(rowErr, e);
            }
          };
          actionCell.append(
            h('div', { class: 'row' },
              h('button', { onclick: () => void resolve('approved') }, 'Approve'),
              h('button', { class: 'danger', onclick: () => void resolve('denied') }, 'Deny'),
            ),
            rowErr,
          );
        } else if (a.status !== 'open' && a.resolvedBy) {
          actionCell.append(h('div', { class: 'muted' }, `by ${a.resolvedBy}`));
        }
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(a.createdAt)),
            h('td', {}, a.publicId ? '#' + a.publicId : a.accountId),
            h('td', {}, a.reason),
            h('td', {}, fmtSnapshot(a.enforcementSnapshot)),
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

  statusSel.addEventListener('change', () => void load());
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'row' }, statusSel), err),
    out,
  );
  await load();
}
