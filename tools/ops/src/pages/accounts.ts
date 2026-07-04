// Account management page (OPS_DESIGN §7): create ops accounts, change role, disable, reset password.
import { clear, fmtTime, h, pill } from '../dom';
import type { AdminAccountView } from '../types';
import { showErr, showOk, type Ctx } from './shared';

export async function pageAccounts(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Account management'));
  const err = h('div', { class: 'err' });

  // Create account
  const uName = h('input', { placeholder: 'Username (≥3)' });
  const uPass = h('input', { type: 'password', placeholder: 'Initial password (≥6)' });
  const uDisp = h('input', { placeholder: 'Display name' });
  const uRole = h('select', {}, ...['viewer', 'support', 'ops', 'super'].map((r) => h('option', { value: r }, r)));
  const create = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.createAccount({ username: uName.value.trim(), password: uPass.value, role: uRole.value, displayName: uDisp.value.trim() || uName.value.trim() });
      uName.value = '';
      uPass.value = '';
      uDisp.value = '';
      await reload();
      showOk(err, 'Account created');
    } catch (e) {
      showErr(err, e);
    }
  };
  root.append(
    h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Create ops account'), h('div', { class: 'row' }, uName, uPass, uDisp, uRole, h('button', { onclick: create }, 'Create')), err),
  );

  const box = h('div', { class: 'card' });
  root.append(box);
  const reload = async (): Promise<void> => {
    try {
      const accts = await api.accounts();
      clear(box);
      const t = h('table', {}, h('tr', {}, h('th', {}, 'Username'), h('th', {}, 'Display name'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}, 'Last login'), h('th', {}, 'Actions')));
      for (const a of accts) t.append(accountRow(ctx, a, () => void reload()));
      box.append(t);
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}

function accountRow(ctx: Ctx, a: AdminAccountView, onChange: () => void): HTMLElement {
  const { api, session } = ctx;
  const self = a.id === session.admin.id;
  const err = h('div', { class: 'err' });
  const roleSel = h('select', {}, ...['viewer', 'support', 'ops', 'super'].map((r) => h('option', { value: r, ...(r === a.role ? { selected: 'selected' } : {}) }, r)));
  const saveRole = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.updateAccount(a.id, { role: roleSel.value });
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const toggleDisable = async (): Promise<void> => {
    err.textContent = '';
    try {
      await api.updateAccount(a.id, { disabled: !a.disabled });
      onChange();
    } catch (e) {
      showErr(err, e);
    }
  };
  const reset = async (): Promise<void> => {
    const pw = prompt(`Set new password for ${a.username} (≥6)`);
    if (!pw) return;
    err.textContent = '';
    try {
      await api.resetPassword(a.id, pw);
      showOk(err, 'Password reset');
    } catch (e) {
      showErr(err, e);
    }
  };
  return h(
    'tr',
    {},
    h('td', {}, a.username, self ? h('span', { class: 'muted' }, '(you)') : null),
    h('td', {}, a.displayName),
    h('td', {}, roleSel, h('button', { class: 'ghost', onclick: saveRole }, 'Save')),
    h('td', {}, a.disabled ? pill('disabled', 'failed') : pill('active', 'executed')),
    h('td', {}, fmtTime(a.lastLoginAt ?? 0)),
    h('td', {}, h('button', { class: a.disabled ? 'ghost' : 'danger', disabled: self, onclick: toggleDisable }, a.disabled ? 'Enable' : 'Disable'), h('button', { class: 'ghost', onclick: reset }, 'Reset password'), err),
  );
}
