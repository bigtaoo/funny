// Promo code management page (B-PROMO, promo.manage; META_TASKS.md §B-PROMO).
//
// Mint + list only, deliberately: a code lives in commercial keyed on its own uppercase text and players
// may already have redeemed it, so there is no edit and no delete — retiring one early means letting it
// expire or hit its total limit. That also means the create form is the one place an operator can get it
// wrong, hence the client-side validation below rather than a round-trip per typo.
//
// Every status/normalization rule here mirrors commercial's PromoService so what the operator reads on
// this page matches what a player's redeem attempt actually does (commercial service/promo.ts): the code
// text is trimmed + uppercased before storage, and redeem validates expiry BEFORE the total limit — so a
// code that is both past its expiry and exhausted rejects as expired, and is labelled that way here too.
import { clear, fmtTime, h, pill } from '../dom';
import type { PromoCodeView } from '../types';
import { localInputToMs, msToLocalInput, showErr, showOk, type Ctx } from './shared';

/** Commercial normalizes before storing (`args.code.trim().toUpperCase()`) — mirror it so the preview shows the code players will actually type. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface PromoDraft {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  note?: string;
}

/**
 * Reject a draft the server would reject anyway, plus the two cases it would silently accept but no
 * operator means: an expiry already in the past (a code dead on arrival) and a non-integer amount.
 * Returns null when the draft is good.
 *
 * `coins`/`totalLimit` are floored by commercial rather than rejected, so a fractional entry is a typo
 * that would otherwise land quietly as a different number than typed — caught here instead.
 */
export function validatePromoDraft(draft: PromoDraft, now: number = Date.now()): string | null {
  if (!normalizePromoCode(draft.code)) return 'Code is required.';
  if (!Number.isFinite(draft.coins) || draft.coins <= 0) return 'Coins must be a positive number.';
  if (!Number.isInteger(draft.coins)) return 'Coins must be a whole number.';
  if (draft.expiresAt !== undefined) {
    if (!Number.isFinite(draft.expiresAt)) return 'Expiry is not a valid date/time.';
    if (draft.expiresAt <= now) return 'Expiry is in the past — the code would be dead on arrival.';
  }
  if (draft.totalLimit !== undefined) {
    if (!Number.isFinite(draft.totalLimit) || draft.totalLimit <= 0) return 'Total limit must be a positive number.';
    if (!Number.isInteger(draft.totalLimit)) return 'Total limit must be a whole number.';
  }
  return null;
}

/**
 * How a redeem attempt would resolve right now. Validation order matches commercial's `promoRedeem`
 * (expiry first, then the total limit), so an expired-and-exhausted code reads "Expired" here exactly
 * as the player's error would.
 */
export function promoStatus(
  code: Pick<PromoCodeView, 'expiresAt' | 'totalLimit' | 'redeemed'>,
  now: number = Date.now(),
): { label: string; cls: string } {
  if (code.expiresAt !== undefined && code.expiresAt < now) return { label: 'Expired', cls: '' };
  if (code.totalLimit !== undefined && code.redeemed >= code.totalLimit) return { label: 'Exhausted', cls: '' };
  return { label: 'Active', cls: 'ok' };
}

/** "3 / 100" for a capped code, "3 / ∞" for an uncapped one. */
export function redemptionText(code: Pick<PromoCodeView, 'totalLimit' | 'redeemed'>): string {
  return `${code.redeemed} / ${code.totalLimit ?? '∞'}`;
}

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
    const expiryInput = h('input', { type: 'datetime-local', value: msToLocalInput(Date.now() + 30 * 86400_000) }) as HTMLInputElement;
    expiryInput.disabled = true;
    const noteInput = h('input', { style: 'width:100%', placeholder: 'Why this code exists (ops-only, never shown to players)' }) as HTMLInputElement;
    const status = h('span', {});
    const createBtn = h('button', {}, 'Create code') as HTMLButtonElement;

    // Live-echo the normalized code: uppercasing happens server-side, so without this the operator can
    // type lowercase, see it stored uppercase, and wonder which form players must enter.
    const syncPreview = (): void => {
      const norm = normalizePromoCode(codeInput.value);
      preview.textContent = norm && norm !== codeInput.value ? `stored as ${norm}` : '';
    };
    codeInput.addEventListener('input', syncPreview);
    expiryEnabled.addEventListener('change', () => {
      expiryInput.disabled = !expiryEnabled.checked;
    });

    createBtn.onclick = async (): Promise<void> => {
      status.textContent = '';
      status.className = '';
      const draft: PromoDraft = {
        code: codeInput.value,
        coins: Number(coinsInput.value),
        ...(expiryEnabled.checked ? { expiresAt: localInputToMs(expiryInput.value) } : {}),
        ...(limitInput.value.trim() ? { totalLimit: Number(limitInput.value) } : {}),
        ...(noteInput.value.trim() ? { note: noteInput.value.trim() } : {}),
      };
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
        // Commercial reports a duplicate `_id` as the same 'BAD_REQUEST' it uses for malformed input,
        // which meta forwards as a 409 — translate it, since "BAD_REQUEST" on a well-formed form is
        // otherwise a dead end for the operator.
        showErr(status, (e as { status?: number }).status === 409
          ? new Error(`Code ${normalized} already exists (codes are unique, case-insensitive).`)
          : e);
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
