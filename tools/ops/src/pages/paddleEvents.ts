// Paddle webhook event log page (support/CS lookup, COMMERCIAL_DESIGN §10.4): "why didn't this payment go
// through" — transaction.completed itself is credited via recharges and not duplicated here; this shows
// every other transaction.* event (payment_failed, canceled, past_due, …), which the webhook would
// otherwise drop silently.
import { clear, fmtTime, h } from '../dom';
import { showErr, type Ctx } from './shared';

export async function pagePaddleEvents(ctx: Ctx): Promise<void> {
  const { api, root } = ctx;
  clear(root);
  root.append(h('h2', {}, 'Paddle events'));
  const accountInput = h('input', { placeholder: 'accountId' });
  const txInput = h('input', { placeholder: 'transactionId' });
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'card' });
  const detailOut = h('div', { class: 'card' });
  detailOut.style.display = 'none';
  root.append(
    h(
      'div',
      { class: 'row' },
      accountInput,
      txInput,
      h('button', { class: 'ghost', onclick: () => void reload() }, 'Search'),
    ),
    err,
    box,
    detailOut,
  );
  const reload = async (): Promise<void> => {
    err.textContent = '';
    try {
      const events = await api.paddleEvents({
        ...(accountInput.value.trim() ? { accountId: accountInput.value.trim() } : {}),
        ...(txInput.value.trim() ? { transactionId: txInput.value.trim() } : {}),
      });
      clear(box);
      const t = h(
        'table',
        {},
        h(
          'tr',
          {},
          h('th', {}, 'Time'),
          h('th', {}, 'Event'),
          h('th', {}, 'Status'),
          h('th', {}, 'Transaction'),
          h('th', {}, 'Account'),
        ),
      );
      for (const e of events) {
        const row = h(
          'tr',
          {
            style: 'cursor:pointer',
            onclick: () => {
              clear(detailOut);
              let pretty = e.rawEvent;
              try {
                pretty = JSON.stringify(JSON.parse(e.rawEvent), null, 2);
              } catch {
                // rawEvent wasn't valid JSON — show as-is.
              }
              detailOut.append(h('h3', {}, `${e.eventType} — ${e.transactionId}`), h('pre', {}, pretty));
              detailOut.style.display = '';
            },
          },
          h('td', {}, fmtTime(e.ts)),
          h('td', {}, e.eventType),
          h('td', {}, e.status ?? '—'),
          h('td', {}, e.transactionId),
          h('td', {}, e.accountId ?? '—'),
        );
        t.append(row);
      }
      box.append(events.length ? t : h('div', { class: 'muted' }, 'No records — search by accountId or transactionId, or leave both blank for the most recent events'));
    } catch (e) {
      showErr(err, e);
    }
  };
  await reload();
}
