// Compensation tickets page (OPS_DESIGN §7): create → four-eyes approve → execute; list + actions.
// Which actions a ticket offers is decided in src/logic/tickets.ts (ADR-070 Phase 4e) — this file
// only binds handlers to whatever that returns.
import { clear, fmtTime, h, pill } from '../dom';
import {
  buildTarget, canInitiate, describeAttachments, describeTarget, previewText, statusFilter,
  type TicketAction, ticketActions, ticketInput, ticketPeople, TICKET_STATUSES,
} from '../logic/tickets';
import type { CompScope, CompTicketView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageTickets(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Compensation tickets'));

  if (canInitiate(session)) root.append(ticketForm(ctx, () => void reload()));

  const filterSel = h('select', {}, ...TICKET_STATUSES.map((s) => h('option', { value: s }, s || 'All')));
  const listBox = h('div', { class: 'card' });
  const err = h('div', { class: 'err' });
  root.append(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Status filter'), filterSel, h('button', { class: 'ghost', onclick: () => void reload() }, 'Refresh')), err, listBox);
  filterSel.addEventListener('change', () => void reload());

  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const tickets = await api.tickets(statusFilter(filterSel.value));
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

function ticketRow(ctx: Ctx, tk: CompTicketView, onChange: () => void): HTMLElement {
  const { api, session } = ctx;
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
  const button = (a: TicketAction): HTMLElement => {
    switch (a) {
      case 'approve':
        return h('button', { onclick: () => void act('approve') }, 'Approve');
      case 'reject':
        return h('button', { class: 'warn', onclick: () => void act('reject', prompt('Rejection reason?') ?? '') }, 'Reject');
      case 'approve-self':
        return h(
          'button',
          { title: 'Self-approval allowed when no other qualified approver exists (backend decides, audit trail kept)', onclick: () => void act('approve') },
          'Approve (self)',
        );
      case 'cancel':
        return h('button', { class: 'ghost', onclick: () => void act('cancel') }, 'Cancel');
      case 'retry':
        return h('button', { class: 'warn', onclick: () => void act('retry') }, 'Retry');
    }
  };
  const people = ticketPeople(tk);

  return h(
    'tr',
    {},
    h('td', {}, pill(tk.status, tk.status), tk.amountTier === 'overquota' ? h('div', { class: 'muted' }, 'overquota') : null),
    h('td', {}, tk.scope),
    h('td', {}, describeTarget(tk.target)),
    h('td', {}, describeAttachments(tk.mail.attachments)),
    h('td', {}, tk.reason),
    h('td', {}, people.initiated, h('div', { class: 'muted' }, fmtTime(tk.initiatedAt))),
    h('td', {}, people.approved, tk.recipientCount !== undefined ? h('div', { class: 'muted' }, `${tk.recipientCount} recipients`) : null, tk.error ? h('div', { class: 'err' }, tk.error) : null),
    h('td', {}, ...ticketActions(tk, session).map(button), err),
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

  const fields = (): Parameters<typeof ticketInput>[0] => ({
    scope: scopeSel.value,
    publicId: publicIdInput.value,
    subject: subjectInput.value,
    body: bodyInput.value,
    coins: coinsInput.value,
    expireDays: expireInput.value,
    reason: reasonInput.value,
  });

  const submit = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.initiate(ticketInput(fields()));
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
      const r = await api.preview(scopeSel.value as CompScope, buildTarget(scopeSel.value, publicIdInput.value));
      previewOut.textContent = previewText(r);
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
