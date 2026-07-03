// Compensation tickets page (OPS_DESIGN §7): create → four-eyes approve → execute; list + actions.
import { clear, fmtTime, h, pill } from '../dom';
import type { CompAttachment, CompScope, CompTarget, CompTicketView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageTickets(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  const caps = session.capabilities;
  clear(root);
  root.append(h('h2', {}, 'Compensation tickets'));

  const canInitiateSingle = caps.includes('comp.initiate.single');
  const canInitiateGlobal = caps.includes('comp.initiate.global');

  if (canInitiateSingle || canInitiateGlobal) root.append(ticketForm(ctx, () => void reload()));

  const filterSel = h('select', {}, ...['', 'pending', 'approved', 'executed', 'rejected', 'cancelled', 'failed'].map((s) => h('option', { value: s }, s || 'All')));
  const listBox = h('div', { class: 'card' });
  const err = h('div', { class: 'err' });
  root.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Status filter'), filterSel, h('button', { class: 'ghost', onclick: () => void reload() }, 'Refresh')), err, listBox);
  filterSel.addEventListener('change', () => void reload());

  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const tickets = await api.tickets(filterSel.value || undefined);
      clear(listBox);
      if (tickets.length === 0) {
        listBox.append(h('div', { class: 'muted' }, 'No tickets'));
        return;
      }
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Status'), h('th', {}, 'Scope'), h('th', {}, 'Target'), h('th', {}, 'Attachments'), h('th', {}, 'Reason'), h('th', {}, 'Initiated'), h('th', {}, 'Approved'), h('th', {}, 'Actions')));
      for (const tk of tickets) t.append(ticketRow(ctx, tk, () => void reload()));
      listBox.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

function describeTarget(target: CompTarget): string {
  return 'publicId' in target ? '#' + target.publicId : `all-server(${target.filter.kind})`;
}
function describeAttachments(att: CompAttachment[]): string {
  return att.map((a) => (a.kind === 'coins' ? `${a.count ?? 0} coins` : `${a.kind}:${a.id ?? '?'}×${a.count ?? 1}`)).join(', ') || 'none';
}

function ticketRow(ctx: Ctx, tk: CompTicketView, onChange: () => void): HTMLElement {
  const { api, session } = ctx;
  const caps = session.capabilities;
  const err = h('div', { class: 'err' });
  const act = async (action: 'approve' | 'reject' | 'cancel' | 'retry', note?: string): Promise<void> => {
    err.textContent = '';
    try {
      await api.ticketAction(tk.id, action, note);
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const buttons: HTMLElement[] = [];
  const isMine = tk.initiatedBy === session.admin.id;
  // Approval capability (mirrors the backend): global→approve.global; overquota→approve.single.overquota; otherwise approve.single.
  const approveCap =
    tk.scope === 'global'
      ? 'comp.approve.global'
      : tk.amountTier === 'overquota'
        ? 'comp.approve.single.overquota'
        : 'comp.approve.single';
  const hasApproveCap = caps.includes(approveCap as never);
  if (tk.status === 'pending') {
    if (hasApproveCap && !isMine) {
      buttons.push(h('button', { onclick: () => void act('approve') }, 'Approve'));
      buttons.push(h('button', { class: 'warn', onclick: () => void act('reject', prompt('Rejection reason?') ?? '') }, 'Reject'));
    } else if (hasApproveCap && isMine) {
      // Single-super-admin self-approval transitional mode: the UI optimistically shows "Approve"; the backend
      // makes the final call — a 403 is returned if a second qualified approver exists (restoring four-eyes).
      // Rejection has no self-approval exemption (use cancel instead), so "Reject" is not shown during self-approval.
      buttons.push(
        h(
          'button',
          { title: 'Self-approval allowed when no other qualified approver exists (backend decides, audit trail kept)', onclick: () => void act('approve') },
          'Approve (self)',
        ),
      );
    }
    if (isMine || session.admin.role === 'super') buttons.push(h('button', { class: 'ghost', onclick: () => void act('cancel') }, 'Cancel'));
  }
  if (tk.status === 'failed' && hasApproveCap) buttons.push(h('button', { class: 'warn', onclick: () => void act('retry') }, 'Retry'));

  return h(
    'tr',
    {},
    h('td', {}, pill(tk.status, tk.status), tk.amountTier === 'overquota' ? h('div', { class: 'muted' }, 'overquota') : null),
    h('td', {}, tk.scope),
    h('td', {}, describeTarget(tk.target)),
    h('td', {}, describeAttachments(tk.mail.attachments)),
    h('td', {}, tk.reason),
    h('td', {}, tk.initiatedByName ?? tk.initiatedBy.slice(0, 8), h('div', { class: 'muted' }, fmtTime(tk.initiatedAt))),
    h('td', {}, tk.approvedByName ?? (tk.approvedBy ? tk.approvedBy.slice(0, 8) : '—'), tk.recipientCount !== undefined ? h('div', { class: 'muted' }, `${tk.recipientCount} recipients`) : null, tk.error ? h('div', { class: 'err' }, tk.error) : null),
    h('td', {}, ...buttons, err),
  );
}

function ticketForm(ctx: Ctx, onCreated: () => void): HTMLElement {
  const { api, session } = ctx;
  const caps = session.capabilities;
  const err = h('div', { class: 'err' });

  const scopeSel = h('select', {}, h('option', { value: 'single' }, 'Individual compensation'), ...(caps.includes('comp.initiate.global') ? [h('option', { value: 'global' }, 'Global compensation')] : []));
  const publicIdInput = h('input', { placeholder: 'Recipient 9-digit public ID', maxlength: '9' });
  const subjectInput = h('input', { placeholder: 'Mail subject' });
  const bodyInput = h('textarea', { placeholder: 'Mail body' });
  const coinsInput = h('input', { type: 'number', value: '0', min: '0' });
  const reasonInput = h('input', { placeholder: 'Reason (required, for audit)' });
  const expireInput = h('input', { type: 'number', value: '30', min: '1' });
  const previewOut = h('span', { class: 'muted' });

  const targetRow = h('div', {}, h('label', {}, 'Recipient public ID'), publicIdInput);
  scopeSel.addEventListener('change', () => {
    targetRow.style.display = scopeSel.value === 'single' ? '' : 'none';
  });

  const buildTarget = (): CompTarget =>
    scopeSel.value === 'single' ? { publicId: publicIdInput.value.trim() } : { filter: { kind: 'all' } };

  const submit = async (): Promise<void> => {
    err.textContent = '';
    const coins = Number(coinsInput.value) || 0;
    const attachments: CompAttachment[] = coins > 0 ? [{ kind: 'coins', count: coins }] : [];
    try {
      await api.initiate({
        scope: scopeSel.value as CompScope,
        target: buildTarget(),
        mail: { subject: subjectInput.value.trim(), body: bodyInput.value.trim(), attachments, expireDays: Number(expireInput.value) || 30 },
        reason: reasonInput.value.trim(),
      });
      showOk(err, 'Ticket created, awaiting approval');
      subjectInput.value = '';
      bodyInput.value = '';
      coinsInput.value = '0';
      reasonInput.value = '';
      onCreated();
    } catch (e) {
      showErr(err, e);
    }
  };
  const doPreview = async (): Promise<void> => {
    err.textContent = '';
    try {
      const r = await api.preview(scopeSel.value as CompScope, buildTarget());
      previewOut.textContent = `Estimated ${r.recipientCount} recipient${r.recipientCount === 1 ? '' : 's'}${r.available ? '' : ' (mail backend not ready, estimate unavailable)'}`;
    } catch (e) {
      showErr(err, e);
    }
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'muted' }, 'Create compensation ticket (initiator ≠ approver; overquota/global requires super-admin approval)'),
    h('label', {}, 'Scope'),
    scopeSel,
    targetRow,
    h('label', {}, 'Mail subject'),
    subjectInput,
    h('label', {}, 'Mail body'),
    bodyInput,
    h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Coins attachment'), coinsInput), h('div', {}, h('label', {}, 'Expire days'), expireInput)),
    h('label', {}, 'Reason'),
    reasonInput,
    h('div', { class: 'row' }, h('button', { onclick: submit }, 'Submit ticket'), h('button', { class: 'ghost', onclick: doPreview }, 'dry-run preview'), previewOut),
    err,
  );
}
