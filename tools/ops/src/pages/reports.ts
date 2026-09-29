// UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11): human resolves each open report as
// dismiss/uphold; uphold applies the -20 reputation penalty via the metaserver enforcement path.
import { clear, fmtTime, h, pill } from '../dom';
import {
  canDeleteReportContent, canResolveReport, purgeConfirm, purgeMessage, reportContentText, reportKindText,
  reportStatusCls, resolvedByText, resolveMessage, upholdConfirm,
} from '../logic/reports';
import type { ReportView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageReports(ctx: Ctx): Promise<void> {
  const { api, root, session } = ctx;
  const canAction = session.capabilities.includes('reports.action');
  // Ban lives on the anti-cheat capability (same /admin/accounts/:id/ban path as Player Lookup).
  const canBan = session.capabilities.includes('anticheat.action');
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
          h('th', {}, 'Kind'),
          h('th', {}, 'Content'),
          h('th', {}, 'Reason'),
          h('th', {}, 'Status'),
          h('th', {}, ''),
        ),
      );
      for (const r of rows as ReportView[]) {
        const statusCell = h('td', {}, pill(r.status, reportStatusCls(r.status)));
        const actionCell = h('td', {});
        const attribution = resolvedByText(r);
        // Guideline 1.2 follow-through (any status): remove the message, purge the author, eject the author.
        const contentErr = h('div', { class: 'err' });
        const contentRow = h('div', { class: 'row' });
        const act = async (fn: () => Promise<string>): Promise<void> => {
          contentErr.textContent = '';
          try {
            showOk(contentErr, await fn());
          } catch (e) {
            showErr(contentErr, e);
          }
        };
        if (canDeleteReportContent(canAction, r)) {
          contentRow.append(h('button', {
            onclick: () => void act(async () => {
              const res = await api.deleteReportContent(r._id);
              return res.deleted ? `Deleted ${res.channel} content.` : 'Already gone (expired or deleted).';
            }),
          }, 'Delete message'));
        }
        if (canAction) {
          contentRow.append(h('button', {
            class: 'danger',
            onclick: () => {
              if (!confirm(purgeConfirm(r.targetId))) return;
              void act(async () => purgeMessage(await api.purgeAuthor(r.targetId)));
            },
          }, "Purge user's messages"));
        }
        if (canBan) {
          contentRow.append(h('button', {
            class: 'danger',
            onclick: () => {
              if (!confirm(`Ban accountId ${r.targetId}?`)) return;
              void act(async () => {
                await api.banPlayer(r.targetId);
                return 'Banned.';
              });
            },
          }, 'Ban'));
        }
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
        if (contentRow.childElementCount > 0) actionCell.append(contentRow, contentErr);
        t.append(
          h('tr', {},
            h('td', {}, fmtTime(r.ts)),
            h('td', {}, r.reporterId),
            h('td', {}, r.targetId),
            h('td', {}, reportKindText(r)),
            h('td', {}, reportContentText(r)),
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
