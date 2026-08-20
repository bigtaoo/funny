// UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11): human resolves each open report as
// dismiss/uphold; uphold applies the -20 reputation penalty via the metaserver enforcement path.
import { clear, fmtTime, h, pill } from '../dom';
import { canResolveReport, reportStatusCls, resolvedByText, resolveMessage, upholdConfirm } from '../logic/reports';
import type { ReportView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageReports(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canAction = session.capabilities.includes('reports.action');
  clear(root);
  root.append(h('h2', {}, 'UGC Reports'));
  const err = h('div', { class: 'err' });
  const statusSel = h(
    'select',
    {},
    h('option', { value: 'open' }, 'Pending (open)'),
    h('option', { value: 'dismissed' }, 'Dismissed'),
    h('option', { value: 'upheld' }, 'Upheld'),
  ) as HTMLSelectElement;
  const out = h('div', { class: 'card' });

  const load = async (): Promise<void> => {
    err.textContent = '';
    clear(out);
    try {
      const rows = await api.reports({ status: statusSel.value, limit: 100 });
      if (rows.length === 0) {
        out.append(h('div', { class: 'muted' }, 'No reports.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Time'),
          h('th', {}, 'Reporter'),
          h('th', {}, 'Target'),
          h('th', {}, 'Reason'),
          h('th', {}, 'Status'),
          h('th', {}, ''),
        ),
      );
      for (const r of rows as ReportView[]) {
        const statusCell = h('td', {}, pill(r.status, reportStatusCls(r.status)));
        const actionCell = h('td', {});
        const attribution = resolvedByText(r);
        if (canResolveReport(canAction, r.status)) {
          const rowErr = h('div', { class: 'err' });
          const resolve = async (resolution: 'dismissed' | 'upheld'): Promise<void> => {
            if (resolution === 'upheld' && !confirm(upholdConfirm(r.targetId))) return;
            rowErr.textContent = '';
            try {
              const res = await api.resolveReport(r._id, r.targetId, resolution);
              showOk(rowErr, resolveMessage(resolution, res));
              await load();
            } catch (e) {
              showErr(rowErr, e);
            }
          };
          actionCell.append(
            h('div', { class: 'row' },
              h('button', { onclick: () => void resolve('dismissed') }, 'Dismiss'),
              h('button', { class: 'danger', onclick: () => void resolve('upheld') }, 'Uphold'),
            ),
            rowErr,
          );
        } else if (attribution) {
          actionCell.append(h('div', { class: 'muted' }, attribution));
        }
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {}, r.reporterId),
            h('td', {}, r.targetId),
            h('td', {}, r.reason),
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
