// Promo code management page (B-PROMO, promo.manage; META_TASKS.md §B-PROMO).
// Mint + list only — the reasoning, the validation and the commercial-mirroring status rules all live
// in src/logic/promo.ts (ADR-070 Phase 4e); this file is the form and the table.
import { clear, fmtTime, h, pill } from '../dom';
import {
  createError, DEFAULT_EXPIRY_MS, normalizedPreview, normalizePromoCode, promoDraft, promoStatus,
  redemptionText, validatePromoDraft,
} from '../logic/promo';
import { msToLocalInput } from '../logic/shared';
import { showErr, showOk, type Ctx } from './shared';

export async function pagePromo(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(
    h('h2', {}, 'Promo Codes'),
    h('div', { class: 'muted', style: 'margin-bottom:8px' },
      'Mint coin redemption codes (B-PROMO). Players redeem them in the shop Coins tab; each player may ' +
      'redeem a given code once. Codes are stored uppercase and cannot be edited or deleted — to retire ' +
      'one early, set an expiry or a total limit up front.'),
  );

  const formBox = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const list = h('div', {}, 'Loading...');
  root.append(formBox, list);

  const fieldRow = (label: string, control: Node): HTMLElement =>
    h('div', { style: 'margin:6px 0' },
      h('label', { style: 'display:block;font-size:13px;color:var(--muted)' }, label), control);

  // `notice` re-renders the (now cleared) form carrying a message in its own status slot. Reporting
  // success by appending a second status node instead would leave the stale "Created X." line sitting
  // next to the next attempt's error.
  const renderForm = (notice?: string): void => {
    clear(formBox);
    const codeInput = h('input', { style: 'width:100%;font-family:monospace', placeholder: 'e.g. WELCOME2026' }) as HTMLInputElement;
    const preview = h('span', { class: 'muted', style: 'font-size:12px' });
    const coinsInput = h('input', { type: 'number', min: '1', step: '1', value: '100' }) as HTMLInputElement;
    const limitInput = h('input', { type: 'number', min: '1', step: '1', placeholder: 'blank = unlimited' }) as HTMLInputElement;
    const expiryEnabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const expiryInput = h('input', { type: 'datetime-local', value: msToLocalInput(Date.now() + DEFAULT_EXPIRY_MS) }) as HTMLInputElement;
    expiryInput.disabled = true;
    const noteInput = h('input', { style: 'width:100%', placeholder: 'Why this code exists (ops-only, never shown to players)' }) as HTMLInputElement;
    const status = h('span', {});
    const createBtn = h('button', {}, 'Create code') as HTMLButtonElement;

    codeInput.addEventListener('input', () => {
      preview.textContent = normalizedPreview(codeInput.value);
    });
    expiryEnabled.addEventListener('change', () => {
      expiryInput.disabled = !expiryEnabled.checked;
    });

    createBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      const draft = promoDraft({
        code: codeInput.value,
        coins: coinsInput.value,
        expiryEnabled: expiryEnabled.checked,
        expiry: expiryInput.value,
        totalLimit: limitInput.value,
        note: noteInput.value,
      });
      const problem = validatePromoDraft(draft);
      if (problem) {
        showErr(status, new Error(problem));
        return;
      }
      const normalized = normalizePromoCode(draft.code);
      createBtn.disabled = true;
      try {
        const r = await api.createPromoCode({ ...draft, code: normalized });
        renderForm(`Created ${r.code}.`);
        await refresh();
      } catch (e) {
        showErr(status, createError(e, normalized));
        createBtn.disabled = false;
      }
    };

    formBox.append(
      h('div', { style: 'margin-bottom:6px' }, h('strong', {}, 'New code')),
      fieldRow('Code', h('div', {}, codeInput, preview)),
      h('div', { style: 'display:flex;gap:16px;flex-wrap:wrap' },
        fieldRow('Coins per redemption', coinsInput),
        fieldRow('Total redemptions', limitInput),
        fieldRow('Expiry', h('div', { class: 'row' }, expiryEnabled, expiryInput)),
      ),
      fieldRow('Ops note (optional)', noteInput),
      h('div', { style: 'margin-top:8px' }, createBtn, ' ', status),
    );
    if (notice) showOk(status, notice);
  };

  const refresh = async (): Promise<void> => {
    try {
      const codes = await api.promoCodes();
      clear(list);
      if (!codes.length) {
        list.append(h('div', { class: 'muted' }, 'No promo codes yet. Use the form above to mint one.'));
        return;
      }
      const t = h('table', {});
      t.append(
        h('tr', {},
          h('th', {}, 'Code'),
          h('th', {}, 'Coins'),
          h('th', {}, 'Redeemed'),
          h('th', {}, 'Status'),
          h('th', {}, 'Expires'),
          h('th', {}, 'Created'),
          h('th', {}, 'Ops note'),
        ),
      );
      for (const c of codes) {
        const st = promoStatus(c);
        t.append(
          h('tr', {},
            h('td', { style: 'font-family:monospace' }, c.code),
            h('td', {}, String(c.coins)),
            h('td', {}, redemptionText(c)),
            h('td', {}, pill(st.label, st.cls)),
            h('td', {}, c.expiresAt === undefined ? h('span', { class: 'muted' }, 'never') : h('span', {}, fmtTime(c.expiresAt))),
            h('td', {}, h('div', {}, fmtTime(c.createdAt)), h('div', { class: 'muted', style: 'font-size:12px' }, c.createdBy)),
            h('td', {}, c.note ? h('span', {}, c.note) : h('span', { class: 'muted' }, '—')),
          ),
        );
      }
      list.append(h('div', { class: 'card' }, t));
    } catch (e) {
      showErr(list, e);
    }
  };

  renderForm();
  await refresh();
}
