// Player appeal review queue (CONTENT_MODERATION_DESIGN.md CM10/CM11): human approves (clears the
// account's active mute/temp-ban/ban) or denies each open appeal.
import { clear, fmtTime, h, pill } from '../dom';
import {
  appealPlayerLabel, appealResolvedByText, appealResolveMessage, appealStatusCls, approveConfirm,
  canResolveAppeal, fmtSnapshot,
} from '../logic/appeals';
import type { AppealView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageAppeals(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canAction = session.capabilities.includes('appeals.action');
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
        const statusCell = h('td', {}, pill(a.status, appealStatusCls(a.status)));
        const actionCell = h('td', {});
        const attribution = appealResolvedByText(a);
        if (canResolveAppeal(canAction, a.status)) {
          const rowErr = h('div', { class: 'err' });
          const resolve = async (resolution: 'approved' | 'denied'): Promise<void> => {
            if (resolution === 'approved' && !confirm(approveConfirm(a.accountId))) return;
            rowErr.textContent = '';
            try {
              await api.resolveAppeal(a._id, resolution);
              showOk(rowErr, appealResolveMessage(resolution));
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
        } else if (attribution) {
          actionCell.append(h('div', { class: 'muted' }, attribution));
        }
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(a.createdAt)),
            h('td', {}, appealPlayerLabel(a)),
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
