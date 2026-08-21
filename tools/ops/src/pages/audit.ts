// Audit log page (OPS_DESIGN §7): operator action log; super-admins may query other actors.
import { clear, fmtTime, h } from '../dom';
import { auditCells, auditQuery } from '../logic/audit';
import { showErr, type Ctx } from './shared';

export async function pageAudit(ctx: Ctx): Promise<void> {
  const { api, session, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Audit log'));
  const canAll = session.capabilities.includes('audit.view.all');
  const actorInput = h('input', { placeholder: 'actor adminId (super-admin only: query other operators)' });
  const fromInput = h('input', { type: 'date' }) as HTMLInputElement;
  const toInput = h('input', { type: 'date' }) as HTMLInputElement;
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'card' });
  root.append(
    h(
      'div',
      { class: 'row' },
      canAll ? actorInput : h('span', { class: 'muted' }, 'You can only view your own actions'),
      h('span', { class: 'muted' }, 'From'),
      fromInput,
      h('span', { class: 'muted' }, 'To'),
      toInput,
      h('button', { class: 'ghost', onclick: () => void reload() }, 'Refresh'),
    ),
    err,
    box,
  );
  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const entries = await api.audit(auditQuery({ canAll, actor: actorInput.value, from: fromInput.value, to: toInput.value }));
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Operator'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'Summary'), h('th', {}, 'IP')));
      for (const e of entries) {
        const c = auditCells(e);
        t.append(h('tr', {}, h('td', {}, fmtTime(e.ts)), h('td', {}, c.operator), h('td', {}, c.action), h('td', {}, c.target), h('td', {}, c.summary), h('td', {}, c.ip)));
      }
      box.append(entries.length ? t : h('div', { class: 'muted' }, 'No records'));
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}
